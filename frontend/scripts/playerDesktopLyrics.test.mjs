import assert from 'node:assert/strict';
import {
  DESKTOP_LYRICS_WINDOW_SIZE,
  desktopLyricsErrorMessage,
  desktopLyricFrame,
  desktopLyricWordProgress,
  requestDesktopLyricsWindow,
  supportsDesktopLyrics,
} from '../src/contexts/playerDesktopLyrics.js';

const lines = [
  { t: 1, text: '第一行' },
  { t: 4, text: '第二行' },
  { t: 7, text: '第三行' },
];

assert.deepEqual(desktopLyricFrame(lines, 1), {
  previous: lines[0],
  current: lines[1],
  next: lines[2],
}, '桌面歌词应同时给出上一行、当前行和下一行');
assert.deepEqual(desktopLyricFrame(lines, -1), {
  previous: null,
  current: null,
  next: lines[0],
}, '首个时间戳前应把第一行视为下一行');
assert.equal(desktopLyricWordProgress({ t: 2, end: 4 }, 1), 0, '逐字开始前进度应为0');
assert.equal(desktopLyricWordProgress({ t: 2, end: 4 }, 3), 0.5, '逐字播放中应按时间线性填色');
assert.equal(desktopLyricWordProgress({ t: 2, end: 4 }, 5), 1, '逐字结束后进度应为1');

let requestedOptions = null;
const supportedWindow = {
  documentPictureInPicture: {
    requestWindow: async (options) => {
      requestedOptions = options;
      return { document: {}, closed: false };
    },
  },
};
assert.equal(supportsDesktopLyrics(supportedWindow), true, '存在 requestWindow 时应启用桌面歌词');
assert.equal(supportsDesktopLyrics({}), false, '不支持文档画中画时应禁用能力');
await requestDesktopLyricsWindow(supportedWindow);
assert.deepEqual(requestedOptions, DESKTOP_LYRICS_WINDOW_SIZE, '桌面歌词应请求稳定的默认窗口尺寸');
assert.throws(() => requestDesktopLyricsWindow({}), /不支持文档画中画/, '不支持时应返回明确错误');
assert.equal(
  desktopLyricsErrorMessage({ name: 'AbortError' }),
  '桌面歌词窗口被浏览器取消或阻止。',
  '浏览器取消系统窗口时不能静默无反馈',
);
assert.equal(
  desktopLyricsErrorMessage(new Error('系统拒绝')),
  '桌面歌词打开失败：系统拒绝',
  '其他打开失败应保留真实错误原因',
);

console.log('playerDesktopLyrics tests passed');
