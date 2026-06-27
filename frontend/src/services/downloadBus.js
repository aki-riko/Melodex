// 极简事件总线:让发现页(TrackModal)能触发跳转到下载页并预填搜索词。
// 避免引入额外的全局状态库,用浏览器原生事件即可。
const EVENT = 'melodex:go-download';

export const requestDownloadSearch = (keyword) => {
  window.dispatchEvent(new CustomEvent(EVENT, { detail: { keyword } }));
};

export const onDownloadSearch = (handler) => {
  const listener = (e) => handler(e.detail?.keyword || '');
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
};
