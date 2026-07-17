export const shouldRecoverUnexpectedBackgroundPause = ({
  reason,
  visibilityState = globalThis.document?.visibilityState || 'unknown',
  sourceKind = '',
  ended = false,
  playSeq = '',
  recoveredPlaySeq = '',
} = {}) => reason === 'unexpected'
  && visibilityState === 'hidden'
  // 仅保留给纯离线 Blob 播放的防御性恢复；在线续播不再依赖
  // 暂停补偿，而是由单一常驻 audio 维持 Android MediaSession。
  && sourceKind === 'cache_preload'
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
