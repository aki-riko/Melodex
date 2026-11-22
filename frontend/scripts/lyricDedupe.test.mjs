// services/musicdl.getLyric 的去重契约。
//
// 背景(2026-11-22 生产真实日志):/music/lyric 在后端要跑「6 个源并发兜底搜索 +
// 单源最多 6+6 秒」,实测稳定耗 11~12 秒,而且一次都不少。日志里「遗症」这一首连发
// 3 次(kuwo → qq 各一次,全部无歌词),30 多秒全烧在注定失败的兜底上。
//
// 为什么不直接 import musicdl.js 跑真实调用:它依赖 axios 与一批无扩展名的 ESM 相对
// import,Node 直接 import 会 ERR_MODULE_NOT_FOUND(项目里其它契约测试也都因此避开它)。
// 所以这里改用两层验证:
//   1. 静态契约 —— 源码里确实存在"并发去重 + 空结果缓存 + 失败不缓存"这三段逻辑;
//   2. 行为契约 —— 用同一套算法(下面独立复刻,与源码同构)跑真实时序,断言去重生效。
// 两层都过,才说明生产代码真的会去重。

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/services/musicdl.js', import.meta.url), 'utf8');

// ---- 1. 静态契约:关键结构必须在,且顺序正确 ----
const lyricStart = source.indexOf('export const getLyric');
assert.ok(lyricStart > 0, 'getLyric 必须存在');
const lyricBlock = source.slice(lyricStart, lyricStart + 3200);

assert.match(lyricBlock, /lyricInFlight/, '必须有并发去重表 lyricInFlight');
assert.match(lyricBlock, /lyricSettled/, '必须有空结果缓存表 lyricSettled');
assert.match(
  lyricBlock,
  /const pending = lyricInFlight\.get\(key\)[\s\S]{0,60}if \(pending\) return pending/,
  '同一 key 并发时必须复用同一个 Promise',
);
assert.match(lyricBlock, /lyricInFlight\.delete\(key\)/, '请求结束必须清理 in-flight（否则失败会永久卡住）');
assert.match(
  lyricBlock,
  /catch \(err\) \{[\s\S]{0,200}throw err;/,
  '失败必须向上抛，不能被吞掉（否则调用方无法提示"歌词加载失败"）',
);
// key 必须包含 source:id —— 同名不同源是两个实体。
// 注意 lyricRequestKey 定义在 getLyric 之前,所以要往前多取一段窗口。
const keyHelperAt = source.indexOf('lyricRequestKey');
assert.ok(keyHelperAt > 0, '必须有 lyricRequestKey 用于构造去重键');
const keyHelperBlock = source.slice(keyHelperAt, keyHelperAt + 400);
assert.match(
  keyHelperBlock,
  /source[\s\S]{0,60}id/,
  '请求 key 必须含 source 与 id，否则同名不同源会被错误合并',
);
// 内嵌歌词短路必须保留（既有行为）。
assert.match(
  lyricBlock,
  /embeddedLyric[\s\S]{0,120}return embeddedLyric/,
  '有 extra.lyric 时必须短路，不发请求（既有行为不能丢）',
);

// ---- 2. 行为契约:用同构算法跑真实时序 ----
// 与源码同一套逻辑（in-flight + 空结果 TTL 缓存 + 失败不缓存）。
const TTL = 5 * 60 * 1000;
const inFlight = new Map();
const settled = new Map();
let backendCalls = 0;
let backendImpl = async () => '';

const keyOf = (s) => `${s.source || ''}::${s.id || ''}::${s.name || ''}`;

const getLyric = async (song) => {
  if (typeof song.extra?.lyric === 'string' && song.extra.lyric.trim()) {
    return song.extra.lyric.trim();
  }
  const key = keyOf(song);
  const hit = settled.get(key);
  if (hit && hit.text === '' && Date.now() - hit.at < TTL) return '';
  const pending = inFlight.get(key);
  if (pending) return pending;
  const request = (async () => {
    backendCalls += 1;
    return backendImpl(song);
  })();
  inFlight.set(key, request);
  try {
    const text = await request;
    settled.set(key, { text: text || '', at: Date.now() });
    return text;
  } finally {
    inFlight.delete(key);
  }
};

const song = {
  id: '002kBeiE4F3SEj', source: 'qq', name: '遗症', artist: '格林Colin', duration: 198, extra: {},
};

// 2a. 并发去重:3 次同时调用只打 1 次后端
backendCalls = 0;
backendImpl = async () => {
  await new Promise((r) => setTimeout(r, 30));
  return '[00:01.00]测试歌词';
};
const [a, b, c] = await Promise.all([getLyric(song), getLyric(song), getLyric(song)]);
assert.equal(backendCalls, 1, `并发 3 次只应打 1 次后端，实际 ${backendCalls} 次`);
assert.equal(a, '[00:01.00]测试歌词');
assert.equal(b, a, '并发调用必须拿到同一个结果');
assert.equal(c, a);

// 2b. 空结果在 TTL 内复用(这正是 11 秒慢路径)
backendCalls = 0;
backendImpl = async () => '';
const emptySong = { ...song, id: 'no-lyric', name: '没歌词' };
const e1 = await getLyric(emptySong);
const e2 = await getLyric(emptySong);
assert.equal(e1, '');
assert.equal(backendCalls, 1, `空结果应复用，实际打了 ${backendCalls} 次（每次 11 秒就白等了）`);

// 2c. 同名不同源不能合并
backendCalls = 0;
backendImpl = async () => '[00:02.00]另一个源';
await getLyric({ ...song, id: 'same', source: 'qq' });
await getLyric({ ...song, id: 'same', source: 'kuwo' });
assert.equal(backendCalls, 2, '同 id 不同 source 必须分别请求');

// 2d. 失败不缓存,重试真能再打
backendCalls = 0;
let failOnce = true;
backendImpl = async () => {
  if (failOnce) { failOnce = false; throw new Error('network boom'); }
  return '[00:03.00]重试成功';
};
const retrySong = { ...song, id: 'retry' };
await assert.rejects(() => getLyric(retrySong), /network boom/, '首次错误应向上抛');
assert.equal(await getLyric(retrySong), '[00:03.00]重试成功', '失败后应能重试成功');
assert.equal(backendCalls, 2, '失败后重试必须真的再请求一次');

// 2e. 内嵌歌词短路
backendCalls = 0;
assert.equal(await getLyric({ ...song, extra: { lyric: '[00:04.00]内嵌' } }), '[00:04.00]内嵌');
assert.equal(backendCalls, 0, '有内嵌歌词时不应发请求');

console.log('lyric dedupe tests passed（并发去重 / 空结果缓存 / 跨源隔离 / 失败可重试 / 内嵌短路）');
