// 自建歌单「打开哪个歌单」与「请求次数」契约测试。
//
// 为什么需要:用户报的 bug 是「我的歌单」每次点击都慢,根因之一是点一次侧栏会发**两次**
// 完全相同的 GET /music/collections/:id/songs ——
//   ① 侧栏 onNavigate 改 hash → MyPlaylist 挂载 + hashchange → 从 hash 恢复 id → 取数
//   ② 60ms 后 playlistBus 的 requestOpenPlaylist 到达 → 又一次取数
// 两个来源各自调一次 load(),没有去重;dev 下 React.StrictMode 还会再翻倍。
//
// 现在两个来源都只负责「决定 collectionId」(mergeCollectionSelection 收敛),
// 取数只由 react-query 的单一个 key ['collection-songs', String(id)] 完成。
// 这个测试锁住三件事:
//   A. 纯逻辑:hash 解析、两个来源收敛到同一目标、query key 唯一入口;
//   B. 真·react-query(v3,与生产同一个 node_modules)在以下三种情形下都只发 1 次请求:
//      同一时刻两个订阅者、StrictMode 式「挂载→立刻卸载→再挂载」、5 分钟内复访不再请求;
//   C. 软门禁:MyPlaylist.js 里不得残留手写 setSongs / loadSeqRef 取数路径,
//      否则双请求会以另一种形式回来。
//
// 运行: node scripts/collectionRoute.test.mjs   (或 npm run test:collection-route)

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import {
  COLLECTION_SONGS_QUERY_ROOT,
  collectionSongsQueryKey,
  mergeCollectionSelection,
  parseCollectionIdFromHash,
} from '../src/utils/collectionRoute.js';

const require = createRequire(import.meta.url);
// 直接用生产同一份依赖:这样测的就不是"我以为的 react-query",而是实际实现。
const { QueryCache, QueryClient, QueryObserver } = require('react-query');

const failures = [];
const check = (fn, label) => {
  try {
    fn();
  } catch (error) {
    failures.push(`${label}: ${error.message}`);
  }
};

// ---------------- A. 纯逻辑 ----------------

check(() => {
  assert.equal(parseCollectionIdFromHash('#myplaylist/8'), 8);
  assert.equal(parseCollectionIdFromHash('#MyPlaylist/11'), 11, 'section 大小写不敏感');
  assert.equal(parseCollectionIdFromHash('myplaylist/8'), 8, '没有前导 # 也要认');
  assert.equal(parseCollectionIdFromHash('#myplaylist/8/songs'), 8, '多余路径段忽略');
  assert.equal(parseCollectionIdFromHash('#myplaylist'), null, '只有 section 没有 id → null');
  assert.equal(parseCollectionIdFromHash('#myplaylist/abc'), null, '非数字 id → null(与改造前 parseInt 一致)');
  assert.equal(parseCollectionIdFromHash('#download'), null, '别的页 → null');
  assert.equal(parseCollectionIdFromHash(''), null);
  assert.equal(parseCollectionIdFromHash(null), null);
}, 'hash 解析');

check(() => {
  // 唯一入口:读取与乐观更新必须得到同一个 key(否则会写到另一个 key 上)。
  assert.deepEqual(collectionSongsQueryKey(8), ['collection-songs', '8']);
  assert.deepEqual(collectionSongsQueryKey('8'), ['collection-songs', '8'], '数字/字符串 id 必须同 key');
  assert.equal(collectionSongsQueryKey(8)[0], COLLECTION_SONGS_QUERY_ROOT);
  assert.deepEqual(collectionSongsQueryKey(8), collectionSongsQueryKey(8), '同 id 两次调用 key 相等');
  assert.notDeepEqual(collectionSongsQueryKey(8), collectionSongsQueryKey(9), '不同歌单必须是不同 key');
  // 未选中歌单时用 null 段,而不是字符串 'null'(避免建出一个看着像正常歌单的缓存项)
  assert.deepEqual(collectionSongsQueryKey(null), ['collection-songs', null]);
  assert.notDeepEqual(collectionSongsQueryKey(null), collectionSongsQueryKey('null'), '未选中与 id="null" 不能撞 key');
}, 'query key 唯一入口');

check(() => {
  // 关键回归:hash 来源只带 id(没有 name),bus 来源带 name。
  // 无论谁先到,都必须收敛成「一个」selection,且不把 name 抹成空。
  const fromHash = mergeCollectionSelection(null, { collectionId: 8 });
  assert.deepEqual(fromHash, { collectionId: 8, name: '', kind: undefined }, 'hash 先到:只有 id');

  const thenBus = mergeCollectionSelection(fromHash, { collectionId: 8, name: '通勤', kind: 'manual' });
  assert.equal(thenBus.collectionId, 8);
  assert.equal(thenBus.name, '通勤', 'bus 后到应补上 name');
  assert.equal(thenBus.kind, 'manual');

  // bus 先到、hash 后到:不能把已有的 name/kind 清掉(改造前 hash 分支会 setMeta 成 name:'')
  const fromBus = mergeCollectionSelection(null, { collectionId: 8, name: '通勤', kind: 'manual' });
  const thenHash = mergeCollectionSelection(fromBus, { collectionId: 8 });
  assert.equal(thenHash.name, '通勤', 'hash 后到不得清空 name');
  assert.equal(thenHash.kind, 'manual', 'hash 后到不得清空 kind');

  // 内容没变化时返回原对象引用(React 会跳过 re-render,重复通知不产生无谓渲染)
  const same = mergeCollectionSelection(fromBus, { collectionId: 8, name: '通勤' });
  assert.equal(same, fromBus, '同目标同内容应返回同一个对象引用');
}, '两个来源收敛到同一目标');

check(() => {
  // 切到另一个歌单:不能继承上一个歌单的 name/kind(否则会显示错的名字)
  const prev = { collectionId: 8, name: '通勤', kind: 'manual' };
  const next = mergeCollectionSelection(prev, { collectionId: 9 });
  assert.deepEqual(next, { collectionId: 9, name: '', kind: undefined }, '切歌单不继承旧 name/kind');

  // 非自建歌单事件(推荐歌单走 Trending,没有 collectionId)不得把当前页清空
  assert.equal(mergeCollectionSelection(prev, { id: 'x', source: 'qq' }), prev, '无 collectionId 的 bus 事件应忽略');
  assert.equal(mergeCollectionSelection(prev, null), prev, 'null 事件应忽略');
  assert.equal(mergeCollectionSelection(prev, undefined), prev, 'undefined 事件应忽略');
}, '切换与忽略规则');

// ---------------- B. 真 react-query 请求次数 ----------------

// 统计 queryFn 被真正调用的次数(每次调用 ≈ 一次 GET /music/collections/:id/songs)。
const createCounter = () => {
  const stats = { calls: 0 };
  const queryFn = async ({ queryKey }) => {
    stats.calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 20)); // 模拟慢接口
    return [{ id: 'a', source: 'qq', name: `song-of-${queryKey[1]}` }];
  };
  return { stats, queryFn };
};

const makeObserver = (client, queryKey, queryFn) => new QueryObserver(client, {
  queryKey,
  queryFn,
  staleTime: 5 * 60 * 1000, // 与 App.js 全局 defaultOptions 一致,测试里显式写明避免漂移
  retry: false,
});

// B1:两个订阅者同时要同一个歌单(dev 下 StrictMode / 双来源同时挂载的等价情形) → 只 1 次
await (async () => {
  const client = new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false, retry: false } } });
  const { stats, queryFn } = createCounter();
  const key = collectionSongsQueryKey(8);
  const first = makeObserver(client, key, queryFn);
  const second = makeObserver(client, key, queryFn);
  first.subscribe(() => {});
  second.subscribe(() => {});
  await new Promise((resolve) => setTimeout(resolve, 120));
  try {
    assert.equal(stats.calls, 1, `同一歌单两个订阅者应只发 1 次请求,实际 ${stats.calls} 次`);
    assert.equal(first.getCurrentResult().isLoading, false, '首次请求完成后不应仍在 loading');
  } catch (error) {
    failures.push(`并发订阅去重: ${error.message}`);
  }
  first.destroy();
  second.destroy();
  client.clear();
})();

// B2:StrictMode 式「挂载 → 立刻卸载 → 再挂载」→ 仍然只 1 次
// (React 18 StrictMode 会把 effect 执行两次;若取数写在 useEffect 里手写 fetch,这里会是 2 次)
await (async () => {
  const client = new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false, retry: false } } });
  const { stats, queryFn } = createCounter();
  const key = collectionSongsQueryKey(8);
  const first = makeObserver(client, key, queryFn);
  const unsubscribe = first.subscribe(() => {});
  unsubscribe(); // StrictMode 的第一次卸载
  first.destroy();
  const remount = makeObserver(client, key, queryFn);
  remount.subscribe(() => {});
  await new Promise((resolve) => setTimeout(resolve, 150));
  try {
    assert.equal(stats.calls, 1, `挂载→卸载→再挂载应复用同一个 in-flight 请求,实际 ${stats.calls} 次`);
  } catch (error) {
    failures.push(`StrictMode 双调用: ${error.message}`);
  }
  remount.destroy();
  client.clear();
})();

// B3:5 分钟内复访 → 0 次新请求、且不进入 loading(即不重放骨架,复访秒开)
await (async () => {
  const client = new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false, retry: false } } });
  const { stats, queryFn } = createCounter();
  const key = collectionSongsQueryKey(8);
  const first = makeObserver(client, key, queryFn);
  const unsubscribe = first.subscribe(() => {});
  await new Promise((resolve) => setTimeout(resolve, 80));
  const callsAfterFirstOpen = stats.calls;
  unsubscribe();
  first.destroy();

  // 离开页面(切到别的歌单,这一次**本来就该**发请求),再回到原歌单
  const other = makeObserver(client, collectionSongsQueryKey(9), queryFn);
  other.subscribe(() => {});
  await new Promise((resolve) => setTimeout(resolve, 80));
  other.destroy();
  const callsBeforeRevisit = stats.calls;

  const revisit = makeObserver(client, key, queryFn);
  revisit.subscribe(() => {});
  const result = revisit.getCurrentResult();
  await new Promise((resolve) => setTimeout(resolve, 80));
  try {
    assert.equal(result.isLoading, false, '有缓存数据时复访不得进入 isLoading(否则会闪骨架)');
    assert.ok(result.data, '复访应立即拿到缓存数据');
    assert.equal(result.data[0].name, 'song-of-8', '复访拿到的必须是这个歌单自己的缓存');
    assert.equal(stats.calls, callsBeforeRevisit, `5 分钟内复访不应产生新请求(实际 +${stats.calls - callsBeforeRevisit})`);
  } catch (error) {
    failures.push(`复访秒开: ${error.message}`);
  }
  revisit.destroy();
  client.clear();
})();

// B4:换歌单 = 换 key,必须真的去取另一个歌单的数据(不能把 A 的数据当成 B)
await (async () => {
  const client = new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false, retry: false } } });
  const { stats, queryFn } = createCounter();
  const a = makeObserver(client, collectionSongsQueryKey(8), queryFn);
  a.subscribe(() => {});
  await new Promise((resolve) => setTimeout(resolve, 80));
  a.destroy();
  const b = makeObserver(client, collectionSongsQueryKey(9), queryFn);
  b.subscribe(() => {});
  await new Promise((resolve) => setTimeout(resolve, 80));
  try {
    assert.equal(stats.calls, 2, '两个不同歌单应各自取数(共 2 次)');
    assert.equal(b.getCurrentResult().data[0].name, 'song-of-9', '不同歌单不得串数据');
  } catch (error) {
    failures.push(`换歌单隔离: ${error.message}`);
  }
  b.destroy();
  client.clear();
})();

// ---------------- C. 软门禁:组件里不得残留手写取数路径 ----------------

const myPlaylistSource = await readFile(new URL('../src/components/MyPlaylist.js', import.meta.url), 'utf8');
// 去掉注释后再扫描,避免说明文字里的 "setSongs" 造成误报。
const myPlaylistCode = myPlaylistSource
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

check(() => {
  assert.doesNotMatch(myPlaylistCode, /setSongs/, '不得再用 setSongs 手写歌曲状态(取数必须只由 useQuery 完成)');
  assert.doesNotMatch(myPlaylistCode, /loadSeqRef/, '不得保留 loadSeqRef 手写竞态防护(useQuery 天然解决)');
  assert.doesNotMatch(myPlaylistCode, /const\s+load\s*=/, '不得保留 load() 手写取数函数');
  // 只能有**一处**取数调用(useQuery 的 queryFn)。多出来的那一处就是第二条取数路径 ——
  // 无论它挂在 hash effect 还是 bus 回调里,都会让「点一次 = 两次请求」以另一种形式回来。
  const fetchCalls = myPlaylistCode.match(/getCollectionSongs\s*\(/g) || [];
  assert.equal(
    fetchCalls.length,
    1,
    `getCollectionSongs 必须只出现 1 次(queryFn 内),实际 ${fetchCalls.length} 处 —— 多出来的就是第二条取数路径`,
  );
}, 'MyPlaylist 无手写取数路径');

check(() => {
  assert.match(myPlaylistCode, /useQuery\(/, '取数必须走 useQuery');
  assert.match(myPlaylistCode, /collectionSongsQueryKey/, 'query key 必须来自唯一入口(读取与乐观更新一致)');
  assert.match(myPlaylistCode, /mergeCollectionSelection/, 'hash 与 bus 两个来源必须收敛到同一目标');
  assert.match(myPlaylistCode, /parseCollectionIdFromHash/, 'hash 解析必须走可测试的纯函数');
  // 骨架只在首次无数据时出现:loading 不能写成 state.isFetching(那样复访也会闪)
  assert.match(myPlaylistCode, /state\.isLoading/, 'loading 必须基于 isLoading(仅首次无数据),不能用 isFetching');
  assert.doesNotMatch(myPlaylistCode, /state\.isFetching/, '不得用 isFetching 决定骨架 —— 复访后台校验时会闪');
}, 'MyPlaylist 取数契约');

if (failures.length > 0) {
  console.error(`collectionRoute 契约测试失败 ${failures.length} 项:\n`);
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else {
  console.log('collectionRoute 契约测试通过：hash/bus 收敛为唯一目标、query key 唯一入口、同一歌单只发 1 次请求（含 StrictMode 双挂载与 5 分钟内复访）、换歌单不串数据、组件无手写取数路径。');
}
