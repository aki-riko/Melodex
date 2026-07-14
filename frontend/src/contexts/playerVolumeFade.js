export const PLAYER_PAUSE_FADE_MS = 220;

export const shouldResumePlayback = (audioPaused, currentIntent = '') => {
  if (currentIntent === 'pause') return true;
  if (currentIntent === 'play') return false;
  return Boolean(audioPaused);
};

const clampVolume = (value) => Math.min(1, Math.max(0, Number(value) || 0));

const currentTime = () => {
  const monotonicNow = globalThis.performance?.now?.();
  return Number.isFinite(monotonicNow) ? monotonicNow : Date.now();
};

const requestFrame = (callback) => {
  // 后台标签页会暂停 requestAnimationFrame,定时器即使被限流也会继续推进并按墙钟时间收敛。
  return globalThis.setTimeout(() => callback(currentTime()), 16);
};

const cancelFrame = (frameID) => {
  globalThis.clearTimeout(frameID);
};

export const fadeAudioVolume = (audio, targetVolume, options = {}) => {
  if (!audio) return () => {};

  const requestedDurationMs = Math.max(0, Number(options.durationMs ?? PLAYER_PAUSE_FADE_MS) || 0);
  const schedule = options.requestFrame || requestFrame;
  const cancelScheduled = options.cancelFrame || cancelFrame;
  const readNow = options.now || currentTime;
  const from = clampVolume(audio.volume);
  const to = clampVolume(targetVolume);
  const durationMs = from === to ? 0 : requestedDurationMs;
  let frameID = null;
  const startedAt = readNow();
  let cancelled = false;

  if (durationMs === 0) {
    audio.volume = to;
    options.onComplete?.();
    return () => {};
  }

  const step = (timestamp) => {
    if (cancelled) return;
    const progress = Math.min(1, Math.max(0, (timestamp - startedAt) / durationMs));
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
