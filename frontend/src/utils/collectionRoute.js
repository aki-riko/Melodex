// 自建歌单页的「打开哪个歌单」纯逻辑(带 Node 契约测试)。
//
// 背景(修的是一个真实的双请求 bug):
//   MyPlaylist 有两个各自独立的「要打开某歌单」来源:
//     1. 哈希路由(#myplaylist/<id>,刷新/直达/前进后退)
//     2. services/playlistBus 的 requestOpenPlaylist 事件(侧栏点击后延 60ms 派发)
//   改造前这两个来源**各自**调一次 load(),于是点一下侧栏必然发两次
//   完全相同的 GET /music/collections/:id/songs(dev 下 React.StrictMode 还会再翻倍)。
//
// 现在两者都只负责「决定 collectionId」(通过 mergeCollectionSelection 收敛到唯一状态),
// 真正取数只由 react-query 按 ['collection-songs', String(id)] 这一个 key 完成一次。
// 这里把「收敛」和「hash 解析」抽成纯函数,以便用 Node 契约测试锁住:
//   · 同一歌单被两个来源分别通知时,结果必须是**同一个** selection(不能产生第二个 query key);
//   · 后到的来源不该把先到的 name/kind 抹成空(侧栏的 hash 分支只带 id,不带 name)。

export const COLLECTION_SONGS_QUERY_ROOT = 'collection-songs';

// query key 唯一入口:读取与乐观更新必须用同一个函数,否则会写到另一个 key 上
// (那正是「移除歌曲后界面没变、刷新又回来」这类 bug 的成因)。
// 没有选中歌单时(collectionId 为 null)返回同一个「空闲 key」而不是字符串 'null',
// 这样既不会误建一个看着像正常歌单的缓存项,也保证空态下只有一个静止的 key。
export const collectionSongsQueryKey = (collectionId) => [
  COLLECTION_SONGS_QUERY_ROOT,
  collectionId == null ? null : String(collectionId),
];

// 从 location.hash 解析歌单 id;非 #myplaylist/<id> 形态返回 null。
// 解析规则与改造前逐字一致(parseInt,非法则忽略),避免改变刷新/直达的行为。
export const parseCollectionIdFromHash = (hash) => {
  const parts = String(hash || '').replace(/^#/, '').split('/');
  if (parts[0].toLowerCase() !== 'myplaylist' || !parts[1]) return null;
  const id = parseInt(parts[1], 10);
  return Number.isNaN(id) ? null : id;
};

const cleanText = (value) => (typeof value === 'string' && value.trim() ? value : '');

// 把「新来的打开请求」并入当前 selection,收敛成唯一结果。
// 返回 null 表示没有可打开的歌单(组件此时显示「从左侧选择一个歌单」)。
//
// 规则:
//  · 同一 collectionId → 返回同一个对象语义上的合并结果(补齐 name/kind,不覆盖已有非空值);
//  · 不同 collectionId → 切换目标,新目标的 name/kind 照实(没有就是空),不继承上一个歌单的;
//  · incoming 没带 collectionId(例如切换页面时 bus 的推荐歌单事件) → 原样返回,不误清空。
export const mergeCollectionSelection = (current, incoming) => {
  const collectionId = incoming?.collectionId;
  if (collectionId == null) return current;

  const name = cleanText(incoming.name);
  const kind = cleanText(incoming.kind);

  if (current && current.collectionId === collectionId) {
    const mergedName = name || current.name || '';
    const mergedKind = kind || current.kind || undefined;
    // 内容没变就返回**原对象**:setState 相同引用会被 React 跳过,
    // 避免 hash 与 bus 两个来源重复通知时产生无意义的重新渲染。
    if (mergedName === (current.name || '') && mergedKind === current.kind) return current;
    return { collectionId, name: mergedName, kind: mergedKind };
  }
  return { collectionId, name, kind: kind || undefined };
};
