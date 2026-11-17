import { normalizeSong } from '../utils/songFields.js';
import { songIdentityKey } from '../utils/songIdentity.js';

// 收藏状态的唯一真相中转站。
//
// 为什么需要(用户报的 bug):「在『我喜欢』页点心形取消收藏,这首歌没有从列表里消失」。
// 根因不是缓存过期,而是**同一件事有三处各自为政的状态**:
//   · SongRow 每一行自己的 favorited (+ 文件级 favoriteStatusCache)
//   · PlayerBar 自己的 favorited(只在换歌时问一次服务器)
//   · MyPlaylist 的 useQuery(['collection-songs', id]) 列表数据
// 于是任何一个入口切换收藏,其余两处毫不知情:
//   · 行内心形取消收藏 → 列表里那首歌还在(要重进页面才少);
//   · 播放条取消收藏 → 列表/行内的心还是亮的;
//   · 列表里「取消喜欢」→ 播放条的心还是亮的。
// 每条都单独补一次调用只是把补丁叠三遍,第四个入口出现时又会漏。所以:
// **谁改的收藏都必须经过这里广播一次**,缓存与事件都在这一处落地。
//
// 缓存 key 带 userId:同一台设备换账号绝不能串收藏态(与下载归属同一套纪律)。
export const FAVORITE_CHANGED = 'melodex:favorite-changed';

const statusCache = new Map();

// 单调递增的变更序号。用途:换歌/挂载时发出的「查收藏状态」请求是异步的,
// 若它晚于用户亲手切换才返回,会把刚改好的状态又覆盖回旧值。
// 发请求前记下序号,回来时若序号变了就丢弃这次响应。
let changeSequence = 0;

export const favoriteChangeSequence = () => changeSequence;

const userKey = (userId) => String(userId || 0);

export const favoriteStatusKey = (song, userId) => {
  const s = normalizeSong(song);
  // 没有身份的歌(缺 id/source)不可能有收藏态,用空串当 key 会被所有空歌共享,
  // 所以这里返回 null 让调用方直接跳过,而不是悄悄共用一条缓存。
  if (!s.id || !s.source) return null;
  return `${userKey(userId)}:${songIdentityKey(s)}`;
};

// 读到 undefined 表示「这条还没有可信结论」,调用方应去问服务器;
// 读到 false 也是有效结论,不能和 undefined 混为一谈。
export const readFavoriteStatus = (song, userId) => {
  const key = favoriteStatusKey(song, userId);
  if (key == null) return undefined;
  return statusCache.get(key);
};

export const writeFavoriteStatus = (song, userId, favorited) => {
  const key = favoriteStatusKey(song, userId);
  if (key == null) return;
  statusCache.set(key, !!favorited);
};

// 清空缓存(登出/切换账号时调用)。key 里已带 userId,这里只是防止内存常驻增长。
export const clearFavoriteStatusCache = () => {
  statusCache.clear();
};

// 广播一次收藏变更:先落缓存(即使当前没有组件挂载,下次挂载也能直接拿到正确值),
// 再派发事件给所有在住的视图。
// song 必须带 id+source;userId 用于跨账号隔离。
export const publishFavoriteChange = ({ song, userId, favorited }) => {
  const s = normalizeSong(song);
  if (!s.id || !s.source) return;
  writeFavoriteStatus(s, userId, favorited);
  changeSequence += 1;
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return;
  window.dispatchEvent(new CustomEvent(FAVORITE_CHANGED, {
    detail: {
      song: s,
      userId: userKey(userId),
      favorited: !!favorited,
    },
  }));
};

// 订阅收藏变更。返回取消订阅函数(与仓库其它 bus 同样式)。
export const onFavoriteChange = (handler) => {
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') {
    return () => {};
  }
  const listener = (event) => handler(event.detail || {});
  window.addEventListener(FAVORITE_CHANGED, listener);
  return () => window.removeEventListener(FAVORITE_CHANGED, listener);
};
