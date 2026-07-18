export const SW_UPDATE_QUERY = 'melodex:sw-update-query';
export const SW_UPDATE_RESPONSE = 'melodex:sw-update-capable';
export const SW_UPDATE_PROTOCOL = 1;

export const isAudioPlaybackActive = (documentLike = globalThis.document) => {
  const audio = documentLike?.querySelector?.('audio');
  return Boolean(audio && !audio.paused && !audio.ended);
};

const deferTask = (task) => {
  if (typeof globalThis.queueMicrotask === 'function') globalThis.queueMicrotask(task);
  else task();
};

const bindReloadSafetyListeners = (documentLike, reloadIfSafe) => {
  const audio = documentLike?.querySelector?.('audio');
  audio?.addEventListener?.('pause', reloadIfSafe);
  audio?.addEventListener?.('ended', reloadIfSafe);
  documentLike?.addEventListener?.('visibilitychange', reloadIfSafe);
};

const createReloadController = (documentLike, reload) => {
  const state = { pending: false, started: false, listenersBound: false };
  const reloadIfSafe = () => {
    if (!state.pending || state.started || isAudioPlaybackActive(documentLike)) return false;
    state.started = true;
    reload();
    return true;
  };
  const requestReload = () => {
    state.pending = true;
    if (reloadIfSafe()) return true;
    if (!state.listenersBound) {
      state.listenersBound = true;
      bindReloadSafetyListeners(documentLike, reloadIfSafe);
    }
    return false;
  };
  return { requestReload, isReloadPending: () => state.pending };
};

const createWorkerMessageHandler = (requestReload) => (event) => {
  if (event?.data?.type !== SW_UPDATE_QUERY) return;
  event.ports?.[0]?.postMessage?.({
    type: SW_UPDATE_RESPONSE,
    protocol: SW_UPDATE_PROTOCOL,
  });
  deferTask(requestReload);
};

export const createSafeServiceWorkerReloader = ({
  windowLike = globalThis.window,
  documentLike = globalThis.document,
  navigatorLike = globalThis.navigator,
  reload = () => windowLike?.location?.reload(),
} = {}) => {
  const reloadController = createReloadController(documentLike, reload);
  const handleWorkerMessage = createWorkerMessageHandler(reloadController.requestReload);

  const listen = () => {
    navigatorLike?.serviceWorker?.addEventListener?.('message', handleWorkerMessage);
  };

  return {
    listen,
    requestReload: reloadController.requestReload,
    handleWorkerMessage,
    isReloadPending: reloadController.isReloadPending,
  };
};

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
