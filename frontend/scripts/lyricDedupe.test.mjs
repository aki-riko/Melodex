// services/musicdl.getLyric 的去重契约。
//
// 背景(2026-11-22 生产真实日志):/music/lyric 在后端要跑「6 个源并发兜底搜索 +
// 单源最多 6+6 秒」,实测稳定耗 11~12 秒,而且一次都不少。日志里「遗症」这一首连发
// 3 次(kuwo → qq 各一次,全部无歌词),30 多秒全烧在注定失败的兜底上。
//
// 在隔离的 VM 中加载实际 getLyric 和它的缓存；只替换 HTTP 边界。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { normalizeSong } from '../src/utils/songFields.js';
import { urlSafeExtraValue } from '../src/utils/songUrlExtra.js';

const source = readFileSync(new URL('../src/services/musicdl.js', import.meta.url), 'utf8');
const block = source.slice(source.indexOf('const LYRIC_DEDUPE_TTL_MS'), source.indexOf('// 构造 Melodex 下载/播放链接'));
let backendCalls = 0;
let backendImpl;
const send = async (method, url, body) => {
  backendCalls += 1;
  return { data: await backendImpl(method, url, body) };
};
const client = {
  get: (url) => send('GET', url),
  post: (url, body) => send('POST', url, body),
};
const getLyric = vm.runInNewContext(block.replace('export const getLyric', 'const getLyric') + '\ngetLyric', {
  client, normalizeSong, urlSafeExtraValue, URLSearchParams, LYRIC_TIMEOUT_MS: 1000, console,
});

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
assert.equal(await getLyric({ ...song, source: 'netease', extra: { lyric: '[00:04.00]内嵌' } }), '[00:04.00]内嵌');
assert.equal(backendCalls, 0, '有内嵌歌词时不应发请求');

// 历史 QQ 内嵌歌词要走自动校对，旧歌词进请求体，普通 GET 的空缓存不能盖住它。
const embedded = '[00:06.900]Call [00:07.140]my name\n[00:08.730]唤[00:08.910]我姓名';
const expected = embedded.split('\n')[0];
backendImpl = async (method, url, body) => {
  assert.equal(method, 'POST');
  assert.equal(body, embedded);
  assert.ok(!decodeURIComponent(url).includes('[00:'));
  return expected;
};
assert.equal(await getLyric({ ...emptySong, extra: { lyric: embedded } }), expected);
backendImpl = async () => { throw new Error('unavailable'); };
assert.equal(await getLyric({ ...song, extra: { lyric: embedded } }), embedded);

console.log('歌词请求去重、空结果缓存、历史歌词校对与回退通过');
