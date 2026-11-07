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

// ---- 时长仲裁:原生小值不得劫持时间轴 ----
//
// 2026-11 真实故障:手机拖到 2 分钟(约 45%),服务端却只收到 570053 字节的请求。
// 该文件 27,065,496 字节、时长 269 秒,570053 仅占 2.1% ≈ 5.7 秒 —— 差约 20 倍。
// 根因是 ExoPlayer 对流式 FLAC 在 prepare 早期报了一个远小于真实值的 duration,
// 而旧逻辑"只要 >0 就采信",于是进度条 max 被压小,拖动比例换算全错。
{
  const streamed = nativePlaybackSnapshot({
    currentIndex: 1, positionMs: 0, durationMs: 31_000, mediaItemCount: 2,
  }, songs);
  assert.equal(
    streamed.progress.dur,
    180,
    '原生报的时长与歌曲元数据差 10% 以上时必须用元数据 —— 否则进度条 max 被压小,'
    + '用户拖到中间只会算出几秒,seek 位置差一个数量级',
  );
}

// 原生值接近元数据(10% 内)时仍采信原生 —— 保留"实测更准能纠正刮削"的能力。
{
  const close = nativePlaybackSnapshot({
    currentIndex: 1, positionMs: 0, durationMs: 168_000, mediaItemCount: 2,
  }, songs);
  assert.equal(close.progress.dur, 168, '差异在容差内应以原生实测为准(元数据 180 秒 -6.7%)');
}

// 元数据缺失时退回原生值(不能因为没元数据就报 0)。
{
  const noMeta = nativePlaybackSnapshot({
    currentIndex: 0, positionMs: 0, durationMs: 200_000, mediaItemCount: 2,
  }, [{ ...songs[0], duration: 0 }, songs[1]]);
  assert.equal(noMeta.progress.dur, 200, '歌曲元数据缺失时应采信原生时长');
}

// 两边都没有时给 0,由界面自行处理(不能出现 NaN)。
{
  const none = nativePlaybackSnapshot({
    currentIndex: 0, positionMs: 0, durationMs: 0, mediaItemCount: 2,
  }, [{ ...songs[0], duration: 0 }, songs[1]]);
  assert.equal(none.progress.dur, 0);
}

console.log('nativePlayback tests passed');
