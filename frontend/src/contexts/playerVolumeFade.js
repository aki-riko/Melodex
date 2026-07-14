export const PLAYER_PAUSE_FADE_MS = 220;

export const shouldResumePlayback = (audioPaused, currentIntent = '') => {
  if (currentIntent === 'pause') return true;
  if (currentIntent === 'play') return false;
  return Boolean(audioPaused);
};

const clampVolume = (value) => Math.min(1, Math.max(0, Number(value) || 0));

export const pauseAudioImmediately = (audio, restoreVolume) => {
  if (!audio) return false;
  audio.pause();
  audio.volume = clampVolume(restoreVolume);
  return true;
};

export const resumeAudioImmediately = async (audio, restoreVolume) => {
  if (!audio) return false;
  // MediaSession 回调可能在页面后台触发,不能等待 requestAnimationFrame 淡入。
  audio.volume = clampVolume(restoreVolume);
  await audio.play();
  return true;
};

const requestFrame = (callback) => {
  if (typeof globalThis.requestAnimationFrame === 'function') {
    return globalThis.requestAnimationFrame(callback);
  }
  return globalThis.setTimeout(() => callback(globalThis.performance?.now?.() || Date.now()), 16);
};

const cancelFrame = (frameID) => {
  if (typeof globalThis.cancelAnimationFrame === 'function') {
    globalThis.cancelAnimationFrame(frameID);
    return;
  }
  globalThis.clearTimeout(frameID);
};

export const fadeAudioVolume = (audio, targetVolume, options = {}) => {
  if (!audio) return () => {};

  const requestedDurationMs = Math.max(0, Number(options.durationMs ?? PLAYER_PAUSE_FADE_MS) || 0);
  const schedule = options.requestFrame || requestFrame;
  const cancelScheduled = options.cancelFrame || cancelFrame;
  const from = clampVolume(audio.volume);
  const to = clampVolume(targetVolume);
  const durationMs = from === to ? 0 : requestedDurationMs;
  let frameID = null;
  let startedAt = null;
  let cancelled = false;

  const step = (timestamp) => {
    if (cancelled) return;
    if (startedAt === null) startedAt = timestamp;
    const progress = durationMs === 0 ? 1 : Math.min(1, Math.max(0, (timestamp - startedAt) / durationMs));
    audio.volume = clampVolume(from + ((to - from) * progress));
    if (progress < 1) {
      frameID = schedule(step);
      return;
    }
    options.onComplete?.();
  };

  frameID = schedule(step);
  return () => {
    cancelled = true;
    if (frameID !== null) cancelScheduled(frameID);
  };
};
