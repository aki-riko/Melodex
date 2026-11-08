import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  absolutePlaybackUrl,
  buildNativeQueue,
  isNativeAndroidPlayback,
  nativePlaybackSnapshot,
  nativeSeekDiagnostic,
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

// ---- seek 取证(2026-11):手机上拖动进度条后音频从 0 重来 ----
//
// 这一节的来历值得写清楚,否则后人会以为这些字段是随手加的。
// 生产日志里 13 次 Android 请求的 Range 全是 `bytes=570053-`,而该 FLAC 的
// 元数据区(STREAMINFO + 561KB 内嵌封面 + Vorbis comment + PADDING)恰好占满
// 前 570053 字节 —— 570053 就是第一个音频帧的偏移。也就是说播放器每次都在
// "从时间轴 0 开始"重新打开流,用户看到的就是"拖了还是从 0 开始"。
// 上一轮交接文档把 570053 换算成"5.7 秒",于是整条推理方向错了。
//
// 所以诊断必须能回答三件事,缺一不可:
//   ① JS 请求了多少毫秒;② 播放器认不认这首歌可以 seek;③ seek 后实际落在哪里。
{
  const diag = nativeSeekDiagnostic(120_500, {
    seekRequestedMs: 120_500,
    seekAppliedMs: 120_500,
    seekDurationMs: 269_583,
    seekPositionMs: 5_700,
    seekable: true,
    mediaItemType: 'audio/flac|flac',
  });
  assert.deepEqual(diag, {
    seek_requested_ms: 120500,
    seek_applied_ms: 120500,
    seek_duration_ms: 269583,
    seek_position_ms: 5700,
    seekable: 'true',
    media_item_type: 'audio/flac|flac',
  }, '正常 seek 的取证字段必须原样带到诊断里');

  // 关键判别:seekable=false 时 ExoPlayer 的 seekTo 会退化,这条必须能看出来。
  const unseekable = nativeSeekDiagnostic(120_000, {
    seekAppliedMs: 0, seekDurationMs: 269_583, seekPositionMs: 0,
    seekable: false, mediaItemType: 'audio/flac|flac',
  });
  assert.equal(unseekable.seekable, 'false', 'seekable=false 必须如实上报 —— 这是"拖了回 0"的直接嫌疑');
  assert.equal(unseekable.seek_applied_ms, 0, '落点 0 与请求 120000 的落差就是故障证据');

  // 旧插件不返回 seekable 时必须是空串(三态),不能伪造 false 误导判断。
  const legacy = nativeSeekDiagnostic(60_000, {});
  assert.equal(legacy.seekable, '', '未知必须留空,不能默认 false 污染结论');
  assert.equal(legacy.seek_duration_ms, 0, '缺失数值字段必须归零,避免 NaN 进日志');
  assert.equal(legacy.media_item_type, '', '缺失容器信息留空');

  // 非法/负数一律钳到 0,诊断通道不允许把 NaN 或负数写进服务端日志。
  const dirty = nativeSeekDiagnostic(-5, { seekAppliedMs: Number.NaN, seekDurationMs: -1 });
  assert.equal(dirty.seek_requested_ms, 0);
  assert.equal(dirty.seek_applied_ms, 0);
  assert.equal(dirty.seek_duration_ms, 0);
  assert.equal(nativeSeekDiagnostic('90.6', {}).seek_requested_ms, 91, '数字字符串应被接受并四舍五入');
}

// ---- 静态契约:seek 必须真的把诊断送到后端,否则等于没加 ----
const providerSource = await readFile(
  new URL('../src/contexts/NativePlayerProvider.js', import.meta.url),
  'utf8',
);
assert.match(
  providerSource,
  /reportPlaybackDiagnostic\(/,
  '原生 seek 必须经 /music/playback_diagnostics 上报 —— adb logcat 缓冲区会滚掉旧日志,'
  + '上一轮就是因此拿不到 seekTo 的证据',
);
assert.match(providerSource, /nativeSeekDiagnostic\(/, 'seek 上报必须复用 nativeSeekDiagnostic 整理字段');
assert.match(providerSource, /event: 'seek_requested'/, '事件名必须与后端白名单一致');

const diagSource = await readFile(
  new URL('../../backend/internal/web/playback_diagnostics.go', import.meta.url),
  'utf8',
);
assert.match(diagSource, /"seek_requested":\s*\{\}/, '后端白名单必须放行 seek_requested,否则上报被 400 拒绝');
assert.match(diagSource, /Seekable\s+string/, '后端必须接收 seekable 字段 —— 它是"能不能拖"的直接判据');

console.log('nativePlayback tests passed');