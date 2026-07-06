export const UNAUTHORIZED_EVENT = 'melodex:unauthorized';

export const dispatchUnauthorized = (eventTarget = globalThis.window) => {
  if (!eventTarget?.dispatchEvent) return;
  const detail = { reason: 'playback-auth' };
  const EventCtor = globalThis.CustomEvent;
  const event = typeof EventCtor === 'function'
    ? new EventCtor(UNAUTHORIZED_EVENT, { detail })
    : { type: UNAUTHORIZED_EVENT, detail };
  eventTarget.dispatchEvent(event);
};

export const ensurePlaybackSession = async (getMe, { eventTarget = globalThis.window } = {}) => {
  if (typeof getMe !== 'function') return true;
  let me;
  try {
    me = await getMe();
  } catch {
    return true;
  }
  if (me?.authenticated === false) {
    dispatchUnauthorized(eventTarget);
    return false;
  }
  return true;
};
