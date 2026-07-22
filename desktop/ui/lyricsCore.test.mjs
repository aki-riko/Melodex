import assert from 'node:assert/strict';
import {
  desktopLyricsDeviceWebSocketURL,
  lyricFrame,
  lyricIndexAt,
  lyricWordFill,
} from './lyricsCore.js';

const lyrics = [
  { t: 1, end: 4, text: '从前从前' },
  { t: 4, end: 8, text: '有个人爱你很久' },
  { t: 8, end: 12, text: '但偏偏' },
];

assert.equal(desktopLyricsDeviceWebSocketURL('https://music.example.test/'), 'wss://music.example.test/rest/desktop-lyrics/device');
assert.equal(desktopLyricsDeviceWebSocketURL('http://127.0.0.1:8329/'), 'ws://127.0.0.1:8329/rest/desktop-lyrics/device');
assert.equal(lyricIndexAt(lyrics, 0.5), -1);
assert.equal(lyricIndexAt(lyrics, 4.5), 1);
assert.deepEqual(lyricFrame(lyrics, 4.5), {
  index: 1,
  previous: lyrics[0],
  current: lyrics[1],
  next: lyrics[2],
});
assert.deepEqual(lyricFrame(lyrics, 0.5), {
  index: -1,
  previous: null,
  current: null,
  next: lyrics[0],
});
assert.equal(lyricWordFill({ t: 2, end: 4 }, 1), 0);
assert.equal(lyricWordFill({ t: 2, end: 4 }, 3), 0.5);
assert.equal(lyricWordFill({ t: 2, end: 4 }, 5), 1);

console.log('desktop lyrics UI core tests passed');
