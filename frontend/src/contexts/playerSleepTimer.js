export const SLEEP_STOP_AFTER_TRACK_KEY = 'melodex_sleep_stop_after_track';
export const SLEEP_TIMER_PRESETS_MINUTES = [1, 15, 30, 45, 60, 90];

export const loadStopAfterTrackPreference = (storage = globalThis.localStorage) => {
  try {
    return storage?.getItem(SLEEP_STOP_AFTER_TRACK_KEY) !== '0';
  } catch {
    return true;
  }
};

export const saveStopAfterTrackPreference = (enabled, storage = globalThis.localStorage) => {
  try {
    storage?.setItem(SLEEP_STOP_AFTER_TRACK_KEY, enabled ? '1' : '0');
  } catch {
    // 浏览器禁止本地存储时,本次会话内状态仍可用。
  }
};

export const createSleepTimer = (minutes, now = Date.now()) => {
  const parsed = Number(minutes);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return {
    endsAt: now + Math.round(parsed * 60 * 1000),
    pendingEndOfTrack: false,
  };
};

export const getSleepTimerRemainingMs = (timer, now = Date.now()) => {
  if (!timer?.endsAt) return 0;
  return Math.max(0, timer.endsAt - now);
};

export const isSleepTimerDue = (timer, now = Date.now()) => {
  return Boolean(timer?.endsAt && timer.endsAt <= now);
};

export const shouldStopAtTrackEnd = (timer, stopAfterTrack, now = Date.now()) => {
  if (!timer || !stopAfterTrack) return false;
  return Boolean(timer.pendingEndOfTrack || isSleepTimerDue(timer, now));
};

export const formatSleepTimerRemaining = (ms) => {
  const totalSeconds = Math.ceil(Math.max(0, Number(ms) || 0) / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
};
