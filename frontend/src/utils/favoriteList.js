import { songIdentityKey } from './songIdentity.js';

// 「我喜欢」列表与收藏状态之间的同步规则(纯函数,带 Node 契约测试)。
//
// 为什么需要:用户报的 bug 是「在『我喜欢』页点心形取消收藏,这首歌没有从列表里消失」。
// 根因不是缓存过期,而是**两条路径只对了一条**:
//   · 「更多 → 取消喜欢」走 MyPlaylist 的 handleRemove,会 setQueryData 把歌摘掉 ✓
//   · 行内心形 / 菜单「取消收藏」走 SongRow 的 handleFavorite,只改了自己那一行的
//     favorited 与模块级 favoriteStatusCache,列表查询缓存完全没动 ✗
// 于是界面呈现为"心形灭了,歌还在",只有重新进页面才会少掉这首。
//
// 修法:心形切换后通知所在页面(见 SongRow 的 onFavoriteChange),页面用这里的纯函数
// 对 ['collection-songs', id] 的缓存做乐观增删。乐观意味着失败必须能放回原位,
// 所以移除时要记住原下标(insertSongIntoList 用它插回原位,而不是粗暴追加到末尾)。

// 与后端 collectionKindFavorite 对应(favorites.go / collection_models.go)。
export const FAVORITE_COLLECTION_KIND = 'favorite';

// 当前打开的是不是「我喜欢」。kind 可能来自 selection(侧栏点击)或 collections 列表,
// 两边都可能是 undefined(老数据/尚未加载),一律按"不是"处理 ——
// 宁可不同步,也绝不能把自建歌单里的歌误删。
export const isFavoriteCollection = (kind) => String(kind ?? '').trim() === FAVORITE_COLLECTION_KIND;

// 歌曲在列表里的位置(按 songIdentityKey,与列表 key 同一套身份,避免同名不同源撞车)。
export const findSongIndexInList = (list, song) => {
  if (!Array.isArray(list) || list.length === 0) return -1;
  const target = songIdentityKey(song);
  return list.findIndex((item) => songIdentityKey(item) === target);
};

// 移除一首歌。找不到时**返回原数组引用**:setQueryData 拿回同一个引用,
// react-query 的 replaceEqualDeep 会认为数据没变,不会产生无意义的重渲染。
export const removeSongFromList = (list, song) => {
  if (!Array.isArray(list)) return [];
  const index = findSongIndexInList(list, song);
  if (index < 0) return list;
  return [...list.slice(0, index), ...list.slice(index + 1)];
};

// 把之前乐观移除的那首歌插回**原下标**(回滚用)。下标越界/负数一律夹到合法范围,
// 列表里已有同一首歌时不再重复插入 —— 回滚绝不能造成"同一首歌出现两次"。
export const insertSongIntoList = (list, song, index) => {
  const base = Array.isArray(list) ? list : [];
  if (findSongIndexInList(base, song) >= 0) return base;
  const raw = Number.isFinite(Number(index)) ? Math.trunc(Number(index)) : base.length;
  const at = Math.max(0, Math.min(raw, base.length));
  return [...base.slice(0, at), song, ...base.slice(at)];
};
