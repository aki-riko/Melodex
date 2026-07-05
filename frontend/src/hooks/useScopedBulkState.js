import { useCallback, useSyncExternalStore } from 'react';

const normalizeKey = (key) => String(key ?? '');

const stores = new Map();

const getStore = (scope, idleState) => {
  const normalizedScope = normalizeKey(scope) || 'default';
  if (!stores.has(normalizedScope)) {
    stores.set(normalizedScope, {
      idleState,
      stateByKey: {},
      runningKeys: new Set(),
      listeners: new Set(),
      version: 0,
    });
  }
  return stores.get(normalizedScope);
};

const notify = (store) => {
  store.version += 1;
  store.listeners.forEach((listener) => listener());
};

export const useScopedBulkState = (idleState, scope = 'default') => {
  const store = getStore(scope, idleState);

  useSyncExternalStore(
    (listener) => {
      store.listeners.add(listener);
      return () => store.listeners.delete(listener);
    },
    () => store.version,
    () => store.version
  );

  const getState = useCallback((key) => store.stateByKey[normalizeKey(key)] || store.idleState, [store]);

  const setForKey = useCallback((key, nextState) => {
    const normalized = normalizeKey(key);
    if (!normalized) return;
    const previous = store.stateByKey[normalized] || store.idleState;
    const value = typeof nextState === 'function' ? nextState(previous) : nextState;
    store.stateByKey = { ...store.stateByKey, [normalized]: value };
    notify(store);
  }, [store]);

  const runForKey = useCallback(async (key, initialState, worker) => {
    const normalized = normalizeKey(key);
    if (!normalized || store.runningKeys.has(normalized)) return false;
    store.runningKeys.add(normalized);
    setForKey(normalized, initialState);
    try {
      await worker((nextState) => setForKey(normalized, nextState));
    } finally {
      store.runningKeys.delete(normalized);
    }
    return true;
  }, [setForKey, store]);

  return { getState, runForKey };
};
