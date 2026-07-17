export const shouldRecoverUnexpectedBackgroundPause = ({
  reason,
  visibilityState = globalThis.document?.visibilityState || 'unknown',
  sourceKind = '',
  ended = false,
  playSeq = '',
  recoveredPlaySeq = '',
} = {}) => reason === 'unexpected'
  && visibilityState === 'hidden'
  && ['stream_preload', 'cache_preload'].includes(sourceKind)
  && !ended
  && Boolean(playSeq)
  && playSeq !== recoveredPlaySeq;

export const resumeUnexpectedBackgroundPause = async (audio) => {
  if (!audio || typeof audio.play !== 'function') return false;
  await audio.play();
  return !audio.paused;
};

// HTMLMediaElement 在自然结束时会先触发 pause，再触发 ended。
// 自动续播期间若立刻把 React/MediaSession 状态发布成 paused，Android
// 可能把已经启动的下一首再次暂停；最终是否停止应交给 ended 处理器决定。
export const shouldDeferPausedStateToEndedHandler = (reason = '') => reason === 'ended';
