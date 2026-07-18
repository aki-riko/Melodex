import assert from 'node:assert/strict';
import {
  absolutePlaybackUrl,
  buildNativeQueue,
  isNativeAndroidPlayback,
  nativePlaybackSnapshot,
} from '../src/contexts/nativePlayback.js';

assert.equal(isNativeAndroidPlayback({ isNativePlatform: () => true, getPlatform: () => 'android' }), true);
assert.equal(isNativeAndroidPlayback({ isNativePlatform: () => true, getPlatform: () => 'ios' }), false);
assert.equal(isNativeAndroidPlayback({ isNativePlatform: () => false, getPlatform: () => 'android' }), false);

assert.equal(
  absolutePlaybackUrl('/music/download?stream=1', 'https://music.example'),
  'https://music.example/music/download?stream=1',
);

const songs = [
  { id: '2', source: 'qq', name: '凝眸', artist: '歌手乙', album: '专辑乙', cover: '/cover/2', duration: 120 },
  { id: '1', source: 'netease', name: '第一首', artist: '歌手甲', album: '专辑甲', cover: '/cover/1', duration: 180 },
];
const nativeQueue = buildNativeQueue(songs, {
  origin: 'https://music.example',
  streamUrl: (song) => `/music/download?id=${song.id}&stream=1`,
  coverUrl: (song) => song.cover,
});
assert.deepEqual(nativeQueue.map((item) => item.title), ['凝眸', '第一首']);
assert.deepEqual(nativeQueue.map((item) => item.url), [
  'https://music.example/music/download?id=2&stream=1',
  'https://music.example/music/download?id=1&stream=1',
]);
assert.equal(nativeQueue[0].coverUrl, 'https://music.example/cover/2');
assert.equal(nativeQueue[0].durationMs, 120000);

const snapshot = nativePlaybackSnapshot({
  currentIndex: 1,
  positionMs: 2500,
  durationMs: 180000,
  isPlaying: true,
  playWhenReady: true,
  playbackState: 3,
  mediaItemCount: 2,
}, songs);
assert.equal(snapshot.song.name, '第一首');
assert.deepEqual(snapshot.progress, { cur: 2.5, dur: 180 });
assert.equal(snapshot.isPaused, false);
assert.equal(snapshot.mediaItemCount, 2);

console.log('nativePlayback tests passed');
