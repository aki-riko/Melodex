// 极简事件总线:侧栏点歌单 → 切到热门页并打开该歌单详情。
// 复用 downloadBus 的思路,用浏览器原生事件,避免引全局状态库。
const EVENT = 'tunescout:open-playlist';

// meta: 推荐歌单 {id, source, name} 或 自建歌单 {collectionId, name}
export const requestOpenPlaylist = (meta) => {
  // 延到下一拍派发:调用方常先 navigate 切页,目标组件需先挂载好监听器再收事件。
  setTimeout(() => {
    window.dispatchEvent(new CustomEvent(EVENT, { detail: meta }));
  }, 60);
};

export const onOpenPlaylist = (handler) => {
  const listener = (e) => handler(e.detail);
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
};
