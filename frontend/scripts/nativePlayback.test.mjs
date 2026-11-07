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

// ExoPlayer prepare 完成前 durationMs 是 C.TIME_UNSET(原生折成 0)。
// 直接把 0 当时长会让 `<input type="range" max=0>` 把拇指钉在最左边,
// 用户拖完就"跳回开头"——和回弹同一个观感,所以必须用队列里的歌曲时长兜底。
const preparingSnapshot = nativePlaybackSnapshot({
  currentIndex: 1,
  positionMs: 0,
  durationMs: 0,
  isPlaying: false,
  playWhenReady: false,
  playbackState: 2,
  mediaItemCount: 2,
}, songs);
assert.deepEqual(
  preparingSnapshot.progress,
  { cur: 0, dur: 180 },
  '原生还没报时长时,应退回队列里已知的歌曲时长(秒),避免进度条被 max=0 钉死在 0',
);

// 原生报出真实时长后必须优先使用它(刮削不准的元数据不能压住实测值)。
const measuredSnapshot = nativePlaybackSnapshot({
  currentIndex: 1, positionMs: 0, durationMs: 175500, mediaItemCount: 2,
}, songs);
assert.equal(measuredSnapshot.progress.dur, 175.5, '原生实测时长必须优先于歌曲元数据');

console.log('nativePlayback tests passed');
