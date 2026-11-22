// 收藏三方同步契约测试(修「取消收藏后页面没有立刻刷新」)。
//
// 用户报的真实现象:在「我喜欢」歌单页点心形取消收藏,心形灭了,**但这首歌还留在列表里**,
// 只有重进页面才会少掉。
//
// 根因(读源码得出,不是猜):收藏这一件事在界面里有三处各自为政的状态 ——
//   · SongRow 每一行的 favorited + 文件级 Map 缓存
//   · PlayerBar 自己的 favorited(只在换歌时问一次服务器)
//   · MyPlaylist 的 useQuery(['collection-songs', id]) 列表数据
// 行内心形只改自己那一行,**没有通知列表查询缓存**;而同页的「更多 → 取消喜欢」
// 走 handleRemove 会 setQueryData,所以同一页两条路径一条对一条漏。
// 播放条同理(它连按钮都没有)。
//
// 所以修复不是"在三个地方各补一次调用",而是:**收藏变更只有一个出口**
// (services/favoriteStatus.js 的 publishFavoriteChange),所有视图订阅它。
// 这个测试锁住四件事:
//   A. 纯逻辑:列表按身份增删、回滚插回**原下标**且不产生重复、只有 favorite 参与同步;
//   B. 真事件总线(publishFavoriteChange → onFavoriteChange):跨用户不串、同歌不同源不串、
//      没有 id/source 的歌不广播;
//   C. 竞态:异步查状态晚于用户亲手切换时,必须能靠序号识别为陈旧结论(否则心会被点回去);
//   D. 静态门禁:三处入口都必须经由统一出口(SongRow 广播 + 通知所在页、PlayerBar 广播、
//      MyPlaylist 接 onFavoriteChange),防止以后有人再加一个"只改自己状态"的入口。
//
// 运行: node scripts/favoriteSync.test.mjs   (或 npm run test:favorites)

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const failures = [];
const check = (fn, label) => {
  try {
    fn();
  } catch (error) {
    failures.push(`${label}: ${error.message}`);
  }
};
const checkAsync = async (fn, label) => {
  try {
    await fn();
  } catch (error) {
    failures.push(`${label}: ${error.message}`);
  }
};

// ---------------- 0. 最小 window 垫片 ----------------
// services/favoriteStatus.js 用 window.dispatchEvent/addEventListener 做总线(与仓库
// 其它 bus 一致)。Node 没有 window,但它**有** EventTarget —— 直接复用真实实现,
// 而不是自己写一个假的派发器(那样测的就不是生产路径了)。
class FakeWindow extends EventTarget {
  dispatchEvent(event) {
    super.dispatchEvent(event);
    return true;
  }
}
globalThis.window = new FakeWindow();

const {
  FAVORITE_CHANGED,
  clearFavoriteStatusCache,
  favoriteChangeSequence,
  favoriteStatusKey,
  onFavoriteChange,
  publishFavoriteChange,
  readFavoriteStatus,
  writeFavoriteStatus,
} = await import('../src/services/favoriteStatus.js');
const {
  findSongIndexInList,
  insertSongIntoList,
  isFavoriteCollection,
  removeSongFromList,
} = await import('../src/utils/favoriteList.js');

const song = (id, source = 'qq', extra = null) => ({ id, source, name: `歌-${id}`, extra });

// ---------------- A. 纯逻辑 ----------------

check(() => {
  assert.equal(isFavoriteCollection('favorite'), true);
  assert.equal(isFavoriteCollection('manual'), false);
  assert.equal(isFavoriteCollection('imported'), false);
  // kind 未知 / 未加载时绝不能当成「我喜欢」——误判会把自建歌单里的歌删掉。
  assert.equal(isFavoriteCollection(undefined), false);
  assert.equal(isFavoriteCollection(null), false);
  assert.equal(isFavoriteCollection(''), false);
  assert.equal(isFavoriteCollection(' favorite '), true, '允许首尾空白(服务端字段可能带空格)');
}, '只有 favorite 参与列表同步');

check(() => {
  const list = [song('a'), song('b'), song('c')];
  assert.equal(findSongIndexInList(list, song('b')), 1);
  assert.equal(findSongIndexInList(list, song('zzz')), -1);
  assert.equal(findSongIndexInList(null, song('a')), -1);
  assert.equal(findSongIndexInList([], song('a')), -1);

  const removed = removeSongFromList(list, song('b'));
  assert.deepEqual(removed.map((s) => s.id), ['a', 'c'], '按身份精确摘除中间那首');
  assert.deepEqual(list.map((s) => s.id), ['a', 'b', 'c'], '不得原地修改(缓存里是共享对象)');

  // 找不到时返回**同一个引用**:react-query 的 replaceEqualDeep 会据此跳过无意义重渲染。
  assert.equal(removeSongFromList(list, song('zzz')), list, '未命中必须返回原引用');
  assert.deepEqual(removeSongFromList(null, song('a')), [], '非数组兜底成空数组');
}, '列表摘歌按身份且不原地修改');

check(() => {
  // 同名不同源不能互相误删(身份 = source + id + extra 哈希)。
  const list = [song('1', 'qq'), song('1', 'netease')];
  const removed = removeSongFromList(list, song('1', 'netease'));
  assert.deepEqual(removed.map((s) => s.source), ['qq'], '只删网易那首,QQ 那首必须还在');
}, '不同源同名歌曲互不干扰');

check(() => {
  const list = [song('a'), song('c')];
  const restored = insertSongIntoList(list, song('b'), 1);
  assert.deepEqual(restored.map((s) => s.id), ['a', 'b', 'c'], '回滚必须插回原下标,不是追加到末尾');

  // 重复回滚(失败重试 / StrictMode 双调用)不得让同一首歌出现两次。
  const again = insertSongIntoList(restored, song('b'), 1);
  assert.equal(again, restored, '已存在时返回原引用,不重复插入');

  assert.deepEqual(insertSongIntoList(list, song('z'), 99).map((s) => s.id), ['a', 'c', 'z'], '越界夹到末尾');
  assert.deepEqual(insertSongIntoList(list, song('z'), -5).map((s) => s.id), ['z', 'a', 'c'], '负数夹到开头');
  assert.deepEqual(insertSongIntoList(list, song('z'), undefined).map((s) => s.id), ['a', 'c', 'z'], '无下标则追加');
  assert.deepEqual(insertSongIntoList(null, song('z'), 0).map((s) => s.id), ['z'], '空列表也能插入');
}, '回滚插回原位且不产生重复');

// ---------------- B. 真事件总线 ----------------

check(() => {
  clearFavoriteStatusCache();
  const seen = [];
  const off = onFavoriteChange((detail) => seen.push(detail));

  publishFavoriteChange({ song: song('s1'), userId: 7, favorited: true });
  assert.equal(seen.length, 1, '广播必须送到订阅者');
  assert.equal(seen[0].favorited, true);
  assert.equal(seen[0].userId, '7', 'userId 统一成字符串,避免 7 与 "7" 比较失败');
  assert.equal(seen[0].song.id, 's1');

  publishFavoriteChange({ song: song('s2'), userId: 7, favorited: false });
  assert.equal(seen.length, 2, '取消收藏同样要广播(这正是用户报的场景)');
  assert.equal(seen[1].favorited, false);

  off();
  publishFavoriteChange({ song: song('s3'), userId: 7, favorited: true });
  assert.equal(seen.length, 2, '退订后不再收到');
}, '广播/订阅往返');

check(() => {
  clearFavoriteStatusCache();
  const seen = [];
  const off = onFavoriteChange((detail) => seen.push(detail));
  // 没有 id/source 的歌(占位行/本地无身份)不可能有收藏态,不该污染总线。
  publishFavoriteChange({ song: { id: '', source: '' }, userId: 1, favorited: true });
  publishFavoriteChange({ song: { id: 'x' }, userId: 1, favorited: true });
  assert.equal(seen.length, 0, '无身份的歌不得广播');
  off();
  assert.equal(seen.length, 0);
}, '无身份歌曲不广播');

check(() => {
  clearFavoriteStatusCache();
  // 缓存必须跨账号隔离:同一台设备换账号不能串收藏态。
  writeFavoriteStatus(song('s1'), 1, true);
  assert.equal(readFavoriteStatus(song('s1'), 1), true);
  assert.equal(readFavoriteStatus(song('s1'), 2), undefined, '另一个账号读不到,应去问服务器');

  // 「没查过」与「查过且未收藏」必须是两个态,不能都用 false 混过去。
  writeFavoriteStatus(song('s2'), 1, false);
  assert.equal(readFavoriteStatus(song('s2'), 1), false, '查过且未收藏是有效结论 false');
  assert.equal(readFavoriteStatus(song('s3'), 1), undefined, '没查过是 undefined');

  assert.equal(favoriteStatusKey({ id: '', source: 'qq' }, 1), null, '缺身份返回 null,由调用方跳过');
  clearFavoriteStatusCache();
}, '收藏缓存按用户隔离且区分 undefined/false');

check(() => {
  clearFavoriteStatusCache();
  // 跨账号广播:userId 不符的订阅者必须自己过滤掉(两处订阅者都按此判断)。
  const seen = [];
  const off = onFavoriteChange((detail) => seen.push(detail));
  publishFavoriteChange({ song: song('s1'), userId: 2, favorited: true });
  assert.equal(seen[0].userId, '2');
  assert.notEqual(seen[0].userId, '1', '账号 1 的视图靠这条过滤,不能串到账号 2 的状态');
  off();
  clearFavoriteStatusCache();
}, '跨账号广播可被订阅者过滤');

check(() => {
  // 事件名是契约的一部分:改动它会让所有订阅者静默失联(不报错,只是不同步)。
  assert.equal(FAVORITE_CHANGED, 'melodex:favorite-changed');
}, '事件名锁定');

// ---------------- C. 竞态:陈旧响应不得覆盖用户操作 ----------------

check(() => {
  // 这不是假想竞态:换歌 / 首次进视口时都会异步问一次收藏状态。
  // 若用户在响应回来前点灭了心,而响应(旧值 true)随后到达,心会自己亮回去。
  // 修法是发请求前后比对序号 —— 这里验证序号确实只在真正的变更后才前进。
  // 注意序号是**按歌**的(见 scripts/favoriteBatchHearts.test.mjs:
  // 全局序号会让同批多行的结论互相丢弃,那正是用户截图里只剩一首亮心的 bug)。
  clearFavoriteStatusCache();
  const target = song('s1');
  const before = favoriteChangeSequence(target, 1);
  // 只查缓存、不发广播:序号不变
  readFavoriteStatus(target, 1);
  writeFavoriteStatus(target, 1, true);
  assert.equal(favoriteChangeSequence(target, 1), before, '缓存读写不算变更,不得推进序号');

  publishFavoriteChange({ song: target, userId: 1, favorited: false });
  const afterChange = favoriteChangeSequence(target, 1);
  assert.ok(afterChange > before, '真正的收藏变更必须推进序号(陈旧响应据此被丢弃)');

  // 无身份的歌不广播 → 也不推进序号
  publishFavoriteChange({ song: { id: '' }, userId: 1, favorited: true });
  assert.equal(favoriteChangeSequence(target, 1), afterChange, '被忽略的广播不推进序号');
  // 改别的歌不影响这首歌的序号(按歌隔离;全局序号时这里必然失败)。
  publishFavoriteChange({ song: song('s2'), userId: 1, favorited: true });
  assert.equal(favoriteChangeSequence(target, 1), afterChange, '改别的歌不得动这首歌的序号');
  clearFavoriteStatusCache();
}, '变更序号只在真实变更时按歌推进');

// ---------------- D. 静态门禁:三处入口都必须走统一出口 ----------------

const stripComments = (text) => text
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

const songRowCode = stripComments(await readFile(new URL('../src/components/SongRow.js', import.meta.url), 'utf8'));
const myPlaylistCode = stripComments(await readFile(new URL('../src/components/MyPlaylist.js', import.meta.url), 'utf8'));
// 播放条那段检查要用**原始源码**:它靠注释里的段落标题定位,而 stripComments 会把标题吃掉。
const playerRaw = await readFile(new URL('../src/contexts/PlayerContext.js', import.meta.url), 'utf8');
const playerCode = stripComments(playerRaw);

check(() => {
  assert.match(songRowCode, /publishFavoriteChange\(/, 'SongRow 切换收藏必须广播(否则列表/播放条不知情)');
  assert.match(songRowCode, /subscribeFavoriteChange\(/, 'SongRow 必须订阅别处发起的收藏变更');
  assert.match(songRowCode, /onFavoriteChange\?\.\(/, 'SongRow 必须通知所在页面(SongRow 自己改不到列表缓存)');
  // 旧的文件级 Map 缓存已并入统一中枢;若它回来了,就说明又分裂出第二份真相。
  assert.doesNotMatch(songRowCode, /favoriteStatusCache/, '不得再保有独立的收藏缓存 Map(应统一走 services/favoriteStatus)');
}, 'SongRow:收藏唯一出口');

check(() => {
  assert.match(myPlaylistCode, /onFavoriteChange=\{handleRowFavoriteChange\}/, '「我喜欢」页必须接住行的收藏变更');
  assert.match(myPlaylistCode, /isFavoriteCollection\(/, '只有「我喜欢」才随收藏增删,自建歌单不受影响');
  assert.match(myPlaylistCode, /removeSongFromList\(/, '取消收藏必须把歌从列表缓存里摘掉(用户报的正是这条)');
  assert.match(myPlaylistCode, /insertSongIntoList\(/, '失败回滚必须把歌插回列表');
  // 取数仍只能有一处(与 collectionRoute 测试同一条纪律,防止有人为了"刷新"再加一条 fetch)。
  const fetchCalls = myPlaylistCode.match(/getCollectionSongs\s*\(/g) || [];
  assert.equal(fetchCalls.length, 1, `同步收藏不得新增第二条取数路径(实际 ${fetchCalls.length} 处)`);
}, 'MyPlaylist:列表随收藏增删');

check(() => {
  assert.match(playerCode, /publishFavoriteChange\(/, '播放条切换收藏必须广播');
  assert.match(playerCode, /onFavoriteChange\(/, '播放条必须订阅别处发起的收藏变更');
  assert.match(playerCode, /onToggleFavorite/, '播放条的心形必须接同一个切换 handler');
}, 'PlayerBar:收藏唯一出口');

// 桌面播放条历史上**没有**收藏按钮(用户实测反馈)。这里锁住它存在,
// 且必须带可访问名称与 aria-pressed(否则读屏无法判断收藏态)。
check(() => {
  // 用**未剥注释**的源码切片:段落标题 "<桌面端:完整播放条>" / "<移动端:迷你条>" 都在注释里。
  const start = playerRaw.indexOf('桌面端:完整播放条');
  const end = playerRaw.indexOf('移动端:迷你条');
  assert.ok(start > 0 && end > start, '必须能定位到桌面播放条那一段');
  const desktopBar = playerRaw.slice(start, end);
  const heartBtn = desktopBar.match(/<button[\s\S]{0,900}?aria-label=\{[^}]*favorited[^}]*\}/);
  assert.ok(heartBtn, '桌面播放条必须有收藏按钮(带 aria-label 反映收藏态)');
  assert.match(desktopBar, /aria-pressed=\{favorited\}/, '收藏按钮必须有 aria-pressed');
  assert.match(desktopBar, /onClick=\{onToggleFavorite\}/, '收藏按钮必须接统一切换 handler');
}, '桌面播放条有收藏按钮');

if (failures.length > 0) {
  console.error(`favoriteSync 契约测试失败 ${failures.length} 项:\n`);
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else {
  console.log(
    'favoriteSync 契约测试通过:收藏变更唯一出口(广播+缓存按用户隔离)、'
    + '「我喜欢」列表随取消收藏立刻摘歌且失败插回原位、陈旧异步响应被序号丢弃、'
    + '三处入口(SongRow/PlayerBar/MyPlaylist)均接入统一总线、桌面播放条已有收藏按钮。',
  );
}
