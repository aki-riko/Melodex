export const scheduleServiceWorkerUpdates = (registration, {
  intervalMs,
  setIntervalFn = globalThis.setInterval,
  logger = globalThis.console,
} = {}) => {
  const parsedInterval = Number(intervalMs);
  if (!registration || typeof registration.update !== 'function') return null;
  if (!Number.isFinite(parsedInterval) || parsedInterval <= 0) return null;

  return setIntervalFn(() => {
    try {
      const pending = registration.update();
      if (pending && typeof pending.catch === 'function') {
        pending.catch((err) => logger?.warn?.('检查 PWA 更新失败', err));
      }
    } catch (err) {
      logger?.warn?.('检查 PWA 更新失败', err);
    }
  }, parsedInterval);
};
