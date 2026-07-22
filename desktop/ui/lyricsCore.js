export const desktopLyricsDeviceWebSocketURL = (baseURL) => {
  const url = new URL('/rest/desktop-lyrics/device', baseURL);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
};

export const lyricIndexAt = (lyrics, position) => {
  const lines = Array.isArray(lyrics) ? lyrics : [];
  let index = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (Number(lines[i]?.t) <= position) index = i;
    else break;
  }
  return index;
};

export const lyricFrame = (lyrics, position) => {
  const lines = Array.isArray(lyrics) ? lyrics : [];
  const index = lyricIndexAt(lines, position);
  return {
    index,
    previous: index > 0 ? lines[index - 1] : null,
    current: index >= 0 ? lines[index] : null,
    next: lines[index + 1] || null,
  };
};

export const lyricWordFill = (word, position) => {
  const start = Number(word?.t) || 0;
  const end = Math.max(start, Number(word?.end) || start);
  if (position <= start) return 0;
  if (position >= end || end === start) return 1;
  return Math.max(0, Math.min(1, (position - start) / (end - start)));
};
