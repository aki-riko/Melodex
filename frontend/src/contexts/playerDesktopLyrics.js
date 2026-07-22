export const DESKTOP_LYRICS_PROTOCOL = 'melodex.desktop-lyrics.v1';

const finiteNumber = (value, fallback = 0) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
};

export const desktopLyricsWebSocketURL = (apiBase = '', locationLike = globalThis.location) => {
  const origin = locationLike?.origin;
  if (!origin) throw new Error('无法确定 Melodex 服务地址');
  const base = new URL(apiBase || origin, `${origin}/`);
  base.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
  base.pathname = '/api/v1/desktop-lyrics/browser';
  base.search = '';
  base.hash = '';
  return base.toString();
};

const normalizedTrack = (track) => {
  if (!track) return null;
  return {
    id: String(track.id || ''),
    source: String(track.source || ''),
    name: String(track.name || ''),
    artist: String(track.artist || ''),
  };
};

export const normalizedDesktopLyricsLines = (lines) => (
  Array.isArray(lines) ? lines.slice(0, 5000).map((line) => ({
    t: Math.max(0, finiteNumber(line?.t)),
    end: Math.max(0, finiteNumber(line?.end)),
    text: String(line?.text || ''),
    words: Array.isArray(line?.words) ? line.words.map((word) => ({
      t: Math.max(0, finiteNumber(word?.t)),
      end: Math.max(0, finiteNumber(word?.end)),
      s: String(word?.s || ''),
    })) : null,
  })) : []
);

export const desktopLyricsTrackMessage = ({ track, lines, position, duration, paused, currentIndex }) => ({
  type: 'track',
  track: normalizedTrack(track),
  lyrics: normalizedDesktopLyricsLines(lines),
  position: Math.max(0, finiteNumber(position)),
  duration: Math.max(0, finiteNumber(duration)),
  paused: Boolean(paused),
  current_index: Number.isInteger(currentIndex) ? currentIndex : -1,
});

export const desktopLyricsProgressMessage = ({ position, duration, paused, currentIndex }) => ({
  type: 'progress',
  position: Math.max(0, finiteNumber(position)),
  duration: Math.max(0, finiteNumber(duration)),
  paused: Boolean(paused),
  current_index: Number.isInteger(currentIndex) ? currentIndex : -1,
});

export const dispatchDesktopLyricsCommand = (rawMessage, callbacks) => {
  let message;
  try {
    message = typeof rawMessage === 'string' ? JSON.parse(rawMessage) : rawMessage;
  } catch {
    return false;
  }
  if (message?.type !== 'command') return false;
  const command = message.command;
  const callback = command === 'prev'
    ? callbacks?.prev
    : command === 'toggle'
      ? callbacks?.toggle
      : command === 'next'
        ? callbacks?.next
        : null;
  if (typeof callback !== 'function') return false;
  callback();
  return true;
};
