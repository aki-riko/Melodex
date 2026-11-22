// 「我喜欢」列表红心批量误灭的回归测试(2026-11-23 用户真机截图)。
//
// ## 用户报的现象
// 「我喜欢」歌单里 11 首**全部是收藏过的**(页面本身就是收藏集合驱动出来的),
// 右侧却只有 1 首是实心红心,其余 10 首是空心。
// 截图证据:唯一亮的那首正在播放 —— 它是播放条广播点亮的,不是自己查出来的。
//
// ## 根因(用本测试复现出来的,不是猜)
// `services/favoriteStatus.js` 的「变更序号」原本是**一个全局计数器**,
// 用来丢弃「晚于用户亲手切换才回来」的陈旧状态查询。但它是全局的:
//   ① 「我喜欢」页一次挂 N 行,N 个查询走同一个 /favorites/status_batch,同一批返回;
//   ② 第 1 行拿到结果后 publishFavoriteChange → 全局序号 +1;
//   ③ 同一批里剩下 N-1 行的 .then 比对序号,发现「变了」→ 判定陈旧 → 丢弃 → 心永远空心。
// 而播放条那条查询排在列表之前(PlayerProvider 在 App 外层,effect 先跑),
// 所以第一行是它;列表 11 行**全部**丢弃 —— 截图里「只有正在播放那首亮」正是此形态。
//
// ## 修法
// 序号改为**按歌**(key = userId + 歌曲身份)各记一份。它要表达的是
// 「这首歌的收藏态被改过」,不是「这台机器上任何一首歌被改过」。
//
// ## 本测试锁住什么
// A. 纯逻辑:序号按歌隔离 —— 改 A 不影响 B 的序号;跨用户隔离;
// B. **真实链路集成**:用真的 services/musicdl.js(只替换 import.meta.env 与 HTTP 传输层)
//    跑一遍「11 首同批查询」,断言 11 行全部拿到 true —— 这就是用户截图那一屏;
// C. 竞态保护没被削弱:同一首歌「查询在途 → 用户亲手切换」时,陈旧响应仍必须被丢弃;
// D. 静态门禁:两个调用点都必须传 song+userId(否则又会退回全局语义)。
//
// 运行: node scripts/favoriteBatchHearts.test.mjs

import assert from 'node:assert/strict';
import { readFile, writeFile, unlink } from 'node:fs/promises';

const failures = [];
const check = (fn, label) => {
  try { fn(); } catch (error) { failures.push(`${label}: ${error.message}`); }
};
const checkAsync = async (fn, label) => {
  try { await fn(); } catch (error) { failures.push(`${label}: ${error.message}`); }
};

// ---------------- 0. 浏览器垫片 ----------------
// 真模块用 window.dispatchEvent/addEventListener 做总线;Node 有 EventTarget,
// 直接复用它而不是自造派发器 —— 否则测的就不是生产路径。
class FakeWindow extends EventTarget {
  dispatchEvent(event) {
    super.dispatchEvent(event);
    return true;
  }
}
globalThis.window = new FakeWindow();
// 11 行同时订阅是真实场景(不是泄漏),把提醒阈值调开,免得日志里混进噪声警告。
if (typeof FakeWindow.prototype.setMaxListeners === 'function') {
  globalThis.window.setMaxListeners(64);
}
// 没有 IntersectionObserver → useInViewport 退化成 inView=true(照旧查询),
// 正是截图情形:11 行都在首屏,全部立刻发起查询。

const {
  clearFavoriteStatusCache,
  favoriteChangeSequence,
  favoriteStatusKey,
  onFavoriteChange,
  publishFavoriteChange,
  readFavoriteStatus,
  writeFavoriteStatus,
} = await import('../src/services/favoriteStatus.js');

const song = (id, source = 'qq', extra = null) => ({ id, source, name: `歌-${id}`, artist: `歌手-${id}`, extra });
const USER = 1;

// ---------------- A. 纯逻辑:序号按歌隔离 ----------------

check(() => {
  clearFavoriteStatusCache();
  const a = song('a');
  const b = song('b');

  // 初始都为 0(没有过变更)
  assert.equal(favoriteChangeSequence(a, USER), 0);
  assert.equal(favoriteChangeSequence(b, USER), 0);

  publishFavoriteChange({ song: a, userId: USER, favorited: true });
  assert.equal(favoriteChangeSequence(a, USER), 1, '被改的歌序号必须前进');
  assert.equal(favoriteChangeSequence(b, USER), 0, '**改 A 不得动 B 的序号**(本次 bug 的根)');

  publishFavoriteChange({ song: a, userId: USER, favorited: false });
  assert.equal(favoriteChangeSequence(a, USER), 2, '同一首歌再改继续前进');
  assert.equal(favoriteChangeSequence(b, USER), 0, 'B 依旧不受影响');
}, '序号按歌曲隔离(改 A 不动 B)');

check(() => {
  clearFavoriteStatusCache();
  // 缓存读写不算变更 —— 这是「查回来的结论」不是「用户的修改」。
  writeFavoriteStatus(song('c'), USER, true);
  readFavoriteStatus(song('c'), USER);
  assert.equal(favoriteChangeSequence(song('c'), USER), 0, '缓存读写不得推进序号');

  // 同 id 不同源是两首不同的歌,序号也要分开。
  publishFavoriteChange({ song: song('same', 'qq'), userId: USER, favorited: true });
  assert.equal(favoriteChangeSequence(song('same', 'qq'), USER), 1);
  assert.equal(favoriteChangeSequence(song('same', 'netease'), USER), 0, '同 id 不同源不得共用序号');

  // 跨用户隔离:账号 2 改同一首歌,不能让账号 1 的在途响应被误判成陈旧。
  publishFavoriteChange({ song: song('d'), userId: 2, favorited: true });
  assert.equal(favoriteChangeSequence(song('d'), 1), 0, '别的账号的变更不得污染本账号序号');
  assert.equal(favoriteChangeSequence(song('d'), 2), 1);

  // 无身份的歌返回 0,且不推进任何东西(调用方本来也不会为它发查询)。
  assert.equal(favoriteChangeSequence({ id: '', source: '' }, USER), 0);
  publishFavoriteChange({ song: { id: '', source: '' }, userId: USER, favorited: true });
  assert.equal(favoriteChangeSequence({ id: '', source: '' }, USER), 0);
  clearFavoriteStatusCache();
}, '序号按用户/按源隔离,缓存读写与无身份歌曲不推进');

check(() => {
  clearFavoriteStatusCache();
  writeFavoriteStatus(song('e'), USER, true);
  publishFavoriteChange({ song: song('e'), userId: USER, favorited: false });
  clearFavoriteStatusCache();
  // 清缓存要连序号一起清:否则登出再登录(deferred 到同一 userId)会继承旧序号,
  // 让新会话的在途查询被莫名其妙丢弃。
  assert.equal(readFavoriteStatus(song('e'), USER), undefined);
  assert.equal(favoriteChangeSequence(song('e'), USER), 0, '清缓存必须同时重置序号');
}, '清缓存同时重置序号');

check(() => {
  // 广播本身不受影响(回归保护:本次改动不该动总线语义)。
  clearFavoriteStatusCache();
  const seen = [];
  const off = onFavoriteChange((detail) => seen.push(detail));
  publishFavoriteChange({ song: song('f'), userId: 7, favorited: true });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].userId, '7');
  assert.equal(seen[0].favorited, true);
  off();
  clearFavoriteStatusCache();
}, '广播/订阅语义不变');

// ---------------- B. 真实链路:11 首同批查询必须全部点亮 ----------------
//
// 用真的 services/musicdl.js(合批队列/去重/分块/resolve 全跑真实代码),
// 只做两处等价替换:
//   ① import.meta.env.VITE_MUSICDL_API → ''(Node 无 import.meta.env);
//   ② axios 的 adapter → 假后端(返回「全部已收藏」,形状照抄 favorites.go);
// 这两处都不参与本次 bug 的逻辑,合批行为与生产一致。
//
// **顺序很重要**:musicdl 在模块顶层就 axios.create() 了,实例的 defaults 在那一刻
// 从 axios.defaults 合并而来。所以 adapter 必须在 import shim **之前**装好,
// 且用可变引用(而不是每次重装),否则第二批场景仍然打到真网络。

const shimUrl = new URL('../src/services/.favoriteBatchRepro.mjs', import.meta.url);

const buildShim = async () => {
  const original = await readFile(new URL('../src/services/musicdl.js', import.meta.url), 'utf8');
  // Node 的 ESM 不做扩展名推断而 Vite 会 —— 给相对导入补 .js,语义等价。
  const patched = original
    .replace('import.meta.env.VITE_MUSICDL_API', "''")
    .replace(/(from\s+')(\.[^']*?)(')/g, (whole, a, spec, b) => (
      /\.(js|mjs|json)$/.test(spec) ? whole : `${a}${spec}.js${b}`
    ));
  await writeFile(shimUrl, patched);
};

let batchCalls = [];
let favoritedIds = new Set();

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  await buildShim();
  const axios = (await import('axios')).default;
  // 装一次、读可变集合:每个场景只需重设 favoritedIds 与 batchCalls。
  axios.defaults.adapter = async (config) => {
    const body = config.data ? JSON.parse(config.data) : {};
    const requested = Array.isArray(body.songs) ? body.songs : [];
    if (String(config.url || '').includes('/favorites/status_batch')) {
      batchCalls.push(requested.map((s) => `${s.source}/${s.id}`));
    }
    return {
      data: {
        statuses: requested.map((s) => ({
          id: s.id,
          source: s.source,
          favorited: favoritedIds.has(`${s.source}/${s.id}`),
        })),
      },
      status: 200, statusText: 'OK', headers: {}, config,
    };
  };
  const { getFavoriteStatus } = await import(shimUrl.href);

  const resetBackend = (ids) => {
    clearFavoriteStatusCache();
    batchCalls = [];
    favoritedIds = new Set(ids);
  };

  await checkAsync(async () => {
    clearFavoriteStatusCache();
    batchCalls = [];
    const songs = Array.from({ length: 11 }, (_, i) => song(String(1000 + i), i === 5 ? 'netease' : 'qq'));
    resetBackend(songs.map((s) => `${s.source}/${s.id}`));

    // 挂载顺序照真实组件树:PlayerProvider 在 App 外层,播放条 effect 先于列表行。
    const player = { favorited: false };
    const rows = songs.map((s) => ({ song: s, favorited: false }));
    const unsubs = [];

    // SongRow 第 276-281 行:每一行都订阅广播。这一行不能省 ——
    // 正在播放那首会被播放条先广播一次,行自己靠订阅跟上(而不是靠自己的查询结论)。
    rows.forEach((row) => {
      const mine = favoriteStatusKey(row.song, USER);
      unsubs.push(onFavoriteChange((detail) => {
        if (detail.userId !== String(USER)) return;
        if (favoriteStatusKey(detail.song, USER) !== mine) return;
        row.favorited = !!detail.favorited;
      }));
    });

    {
      // PlayerContext 第 1726-1736 行
      const seqAtRequest = favoriteChangeSequence(songs[5], USER);
      getFavoriteStatus(songs[5]).then((ok) => {
        if (favoriteChangeSequence(songs[5], USER) !== seqAtRequest) return;
        publishFavoriteChange({ song: songs[5], userId: USER, favorited: ok });
        player.favorited = ok;
      });
    }
    rows.forEach((row) => {
      // SongRow 第 283-298 行
      const cached = readFavoriteStatus(row.song, USER);
      if (cached != null) { row.favorited = cached; return; }
      const seqAtRequest = favoriteChangeSequence(row.song, USER);
      getFavoriteStatus(row.song).then((ok) => {
        if (favoriteChangeSequence(row.song, USER) !== seqAtRequest) return;
        publishFavoriteChange({ song: row.song, userId: USER, favorited: ok });
        row.favorited = ok;
      });
    });

    await wait(150);
    unsubs.forEach((off) => off());

    const lit = rows.filter((r) => r.favorited).length;
    assert.equal(
      batchCalls.length, 1,
      `11 首应合并成 1 次 status_batch(实际 ${batchCalls.length} 次:${JSON.stringify(batchCalls)})`,
    );
    assert.equal(
      lit, 11,
      `「我喜欢」11 行应全部点亮 —— 这正是用户截图那一屏。实际点亮 ${lit} 行:`
      + rows.map((r, i) => `${i + 1}.${r.favorited ? '❤' : '♡'}`).join(' '),
    );
    assert.equal(player.favorited, true, '播放条也要点亮');
  }, '真实合批链路:11 首同批查询全部点亮');

  await checkAsync(async () => {
    clearFavoriteStatusCache();
    batchCalls = [];
    // 变体:只有第 3、7 首已收藏。必须精确保留这个分布,不能全亮也不能全灭
    // (全亮会是「不过滤」的另一半 bug)。
    const songs = Array.from({ length: 11 }, (_, i) => song(String(2000 + i)));
    resetBackend([songs[2], songs[6]].map((s) => `${s.source}/${s.id}`));

    const rows = songs.map((s) => ({ song: s, favorited: null }));
    rows.forEach((row) => {
      const seqAtRequest = favoriteChangeSequence(row.song, USER);
      getFavoriteStatus(row.song).then((ok) => {
        if (favoriteChangeSequence(row.song, USER) !== seqAtRequest) return;
        publishFavoriteChange({ song: row.song, userId: USER, favorited: ok });
        row.favorited = ok;
      });
    });
    await wait(150);

    const litIndexes = rows.map((r, i) => (r.favorited ? i : -1)).filter((i) => i >= 0);
    assert.deepEqual(litIndexes, [2, 6], `应只点亮第 3、7 首,实际 ${JSON.stringify(litIndexes)}`);
  }, '真实合批链路:部分收藏时按歌精确(exact)点亮');

  await checkAsync(async () => {
    clearFavoriteStatusCache();
    batchCalls = [];
    // 竞态保护必须还在:同一首歌「查询在途」期间用户亲手切换,
    // 那次查询的旧结论必须被丢弃,不能把用户刚点灭的心又点亮。
    const target = song('3000');
    const rows = [song('3001'), song('3002')]; // 陪跑,确保同批里还有别的歌
    resetBackend([`${target.source}/${target.id}`]);

    const state = { favorited: null };
    const seqAtRequest = favoriteChangeSequence(target, USER);
    const pending = getFavoriteStatus(target).then((ok) => {
      if (favoriteChangeSequence(target, USER) !== seqAtRequest) return;
      publishFavoriteChange({ song: target, userId: USER, favorited: ok });
      state.favorited = ok;
    });
    // 用户在响应回来前亲手取消收藏(乐观)
    publishFavoriteChange({ song: target, userId: USER, favorited: false });
    state.favorited = false;
    // 陪跑的行照常查询,不该被这两件事影响
    const others = rows.map((s) => ({ song: s, favorited: null }));
    others.forEach((row) => {
      const seq = favoriteChangeSequence(row.song, USER);
      getFavoriteStatus(row.song).then((ok) => {
        if (favoriteChangeSequence(row.song, USER) !== seq) return;
        row.favorited = ok;
      });
    });

    await pending;
    await wait(150);

    assert.equal(state.favorited, false, '用户刚点灭的心不得被陈旧响应重新点亮');
    assert.deepEqual(others.map((r) => r.favorited), [false, false], '别的歌照常拿到结论');
  }, '竞态保护仍在:陈旧响应丢弃按歌生效');
} finally {
  await unlink(shimUrl).catch(() => {});
}

// ---------------- C. 静态门禁:调用点必须传 song ----------------

const stripComments = (text) => text
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

const readSrc = async (rel) => stripComments(
  await readFile(new URL(`../src/${rel}`, import.meta.url), 'utf8'),
);

const songRowCode = await readSrc('components/SongRow.js');
const playerCode = await readSrc('contexts/PlayerContext.js');
const serviceCode = await readSrc('services/favoriteStatus.js');

check(() => {
  // 无参调用 favoriteChangeSequence() 会退回「全局」语义 —— 那正是本次 bug 的形态。
  // 门禁:每一处调用都必须带 song + userId 两个参数。
  const calls = songRowCode.match(/favoriteChangeSequence\s*\([^)]*\)/g) || [];
  assert.ok(calls.length >= 2, `SongRow 应有"取序号/比对序号"两处调用,实际 ${calls.length}`);
  calls.forEach((call) => {
    assert.match(call, /favoriteChangeSequence\(\s*rowSong\s*,\s*userId\s*\)/,
      `SongRow 的 favoriteChangeSequence 必须传 (rowSong, userId),实际: ${call}`);
  });

  const playerCalls = playerCode.match(/favoriteChangeSequence\s*\([^)]*\)/g) || [];
  assert.ok(playerCalls.length >= 2, `PlayerContext 应有"取序号/比对序号"两处调用,实际 ${playerCalls.length}`);
  playerCalls.forEach((call) => {
    assert.match(call, /favoriteChangeSequence\(\s*nowPlaying\s*,\s*favUserId\s*\)/,
      `PlayerContext 必须传 (nowPlaying, favUserId),实际: ${call}`);
  });
}, '门禁:序号查询必须按歌传参');

check(() => {
  // 序号容器必须按歌存(Map),不能退回单个全局计数器 —— 那正是本次 bug 的形态。
  // 这里对 favoriteStatus.js 做静态门禁:改动若把用户回调重新用全局整数,
  // 同批多行必然再次互相踩踏。
  const code = serviceCode;
  assert.match(
    code, /changeSequences\s*=\s*new Map\(\)/,
    '收藏变更序号必须按歌存(Map),不得回退成单个全局计数器',
  );
  assert.doesNotMatch(
    code, /^\s*let changeSequence\s*=/m,
    '不得再出现全局 `let changeSequence` 计数器(会让同批多行互相丢弃结论)',
  );
}, '门禁:序号按歌存 Map,不得回退全局计数器');

if (failures.length > 0) {
  console.error(`favoriteBatchHearts 回归测试失败 ${failures.length} 项:\n`);
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else {
  console.log(
    'favoriteBatchHearts 回归测试通过:收藏变更序号按歌隔离(改 A 不动 B);'
    + '真实合批链路下「我喜欢」11 首同批查询全部点亮(用户截图那一屏);'
    + '部分收藏时按歌精确点亮、不误亮不误灭;陈旧响应丢弃的竞态保护仍在且按歌生效;'
    + '两个调用点均按歌传参(门禁防止退回全局语义)。',
  );
}
