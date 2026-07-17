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
