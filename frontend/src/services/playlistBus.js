// 极简事件总线:侧栏点歌单 → 切到热门页并打开该歌单详情。
// 复用 downloadBus 的思路,用浏览器原生事件,避免引全局状态库。
const EVENT = 'tunescout:open-playlist';

// meta: { id, source, name }
export const requestOpenPlaylist = (meta) => {
  window.dispatchEvent(new CustomEvent(EVENT, { detail: meta }));
};

export const onOpenPlaylist = (handler) => {
  const listener = (e) => handler(e.detail);
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
};
