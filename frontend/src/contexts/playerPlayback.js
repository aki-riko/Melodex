export const shouldPreferPlaybackCache = ({
  offline = false,
  visibilityState = globalThis.document?.visibilityState || 'visible',
} = {}) => Boolean(offline) || visibilityState === 'visible';

// 锁屏/后台切歌必须在 ended 或 MediaSession 回调的同一调用栈里启动。
// 在线后台跳过 IndexedDB 查询，避免当前音轨结束后异步任务被系统冻结，
// 导致下一首没有及时设置 src、媒体会话被回收。
export const beginPlaybackTransition = ({
  song,
  seq,
  offline = false,
  visibilityState,
  selectSong,
  loadAudio,
}) => {
  selectSong(song);
  return loadAudio(song, {
    autoplay: true,
    seq,
    preferCache: shouldPreferPlaybackCache({ offline, visibilityState }),
  });
};
