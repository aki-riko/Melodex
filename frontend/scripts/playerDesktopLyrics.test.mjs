import assert from 'node:assert/strict';
import {
  DESKTOP_LYRICS_PROTOCOL,
  desktopLyricsProgressMessage,
  desktopLyricsTrackMessage,
  desktopLyricsWebSocketURL,
  dispatchDesktopLyricsCommand,
} from '../src/contexts/playerDesktopLyrics.js';

const lines = [
  { t: 1, end: 4, text: '第一行', words: null },
  { t: 4, end: 7, text: '第二行', words: [{ t: 4, end: 5, s: '第' }, { t: 5, end: 7, s: '二行' }] },
];

assert.equal(DESKTOP_LYRICS_PROTOCOL, 'melodex.desktop-lyrics.v1');
assert.equal(
  desktopLyricsWebSocketURL('', { origin: 'https://music.example.test' }),
  'wss://music.example.test/api/v1/desktop-lyrics/browser',
  'HTTPS 页面必须使用 WSS 同源桥',
);
assert.equal(
  desktopLyricsWebSocketURL('http://localhost:8329', { origin: 'http://localhost:3000' }),
  'ws://localhost:8329/api/v1/desktop-lyrics/browser',
  '开发环境必须跟随已配置的后端基址',
);

const track = desktopLyricsTrackMessage({
  track: { id: 1, source: 'qq', name: '晴天', artist: '周杰伦', cover: '不发送' },
  lines,
  position: 4.5,
  duration: 269,
  paused: false,
  currentIndex: 1,
});
assert.deepEqual(track.track, { id: '1', source: 'qq', name: '晴天', artist: '周杰伦' });
assert.equal(track.lyrics[1].words[1].s, '二行', '逐字时间轴必须完整传给原生助手');
assert.equal(track.current_index, 1);
assert.equal('cover' in track.track, false, '桌面歌词协议不应携带无关封面');

assert.deepEqual(
  desktopLyricsProgressMessage({ position: 5, duration: 269, paused: true, currentIndex: 1 }),
  { type: 'progress', position: 5, duration: 269, paused: true, current_index: 1 },
  '高频进度消息只携带必要状态',
);

const calls = [];
const callbacks = {
  prev: () => calls.push('prev'),
  toggle: () => calls.push('toggle'),
  next: () => calls.push('next'),
};
for (const command of ['prev', 'toggle', 'next']) {
  assert.equal(dispatchDesktopLyricsCommand(JSON.stringify({ type: 'command', command }), callbacks), true);
}
assert.deepEqual(calls, ['prev', 'toggle', 'next'], '助手三种控制必须准确映射到浏览器播放器');
assert.equal(
  dispatchDesktopLyricsCommand('{"type":"command","command":"seek"}', callbacks),
  false,
  '协议外控制不得获得播放器权限',
);
assert.equal(dispatchDesktopLyricsCommand('not-json', callbacks), false, '畸形消息不能触发控制');

const nullTrack = desktopLyricsTrackMessage({
  track: null,
  lines: null,
  position: Number.NaN,
  duration: -1,
  paused: true,
  currentIndex: null,
});
assert.deepEqual(nullTrack, {
  type: 'track',
  track: null,
  lyrics: [],
  position: 0,
  duration: 0,
  paused: true,
  current_index: -1,
}, '空播放器状态必须形成可清屏的安全消息');

console.log('playerDesktopLyrics tests passed');
