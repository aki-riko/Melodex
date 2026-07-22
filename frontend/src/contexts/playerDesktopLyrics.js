export const DESKTOP_LYRICS_WINDOW_SIZE = Object.freeze({
  width: 760,
  height: 240,
});

export const supportsDesktopLyrics = (hostWindow = globalThis.window) => (
  typeof hostWindow?.documentPictureInPicture?.requestWindow === 'function'
);

export const requestDesktopLyricsWindow = (hostWindow = globalThis.window) => {
  if (!supportsDesktopLyrics(hostWindow)) {
    throw new Error('当前浏览器不支持文档画中画');
  }
  return hostWindow.documentPictureInPicture.requestWindow(DESKTOP_LYRICS_WINDOW_SIZE);
};

export const desktopLyricsErrorMessage = (error) => {
  if (error?.name === 'AbortError') return '桌面歌词窗口被浏览器取消或阻止。';
  return `桌面歌词打开失败：${error?.message || '未知错误'}`;
};

export const desktopLyricFrame = (lines, activeIndex) => {
  const safeLines = Array.isArray(lines) ? lines : [];
  const index = Number.isInteger(activeIndex) ? activeIndex : -1;
  return {
    previous: index > 0 ? safeLines[index - 1] : null,
    current: index >= 0 ? safeLines[index] || null : null,
    next: safeLines[index + 1] || null,
  };
};

export const desktopLyricWordProgress = (word, currentTime) => {
  if (!word || currentTime <= word.t) return 0;
  if (currentTime >= word.end) return 1;
  if (word.end <= word.t) return 1;
  return Math.max(0, Math.min(1, (currentTime - word.t) / (word.end - word.t)));
};
