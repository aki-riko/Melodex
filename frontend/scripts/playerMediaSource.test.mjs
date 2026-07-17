import assert from 'node:assert/strict';
import {
  bufferedAheadSeconds,
  CONTINUOUS_AUDIO_MIME,
  localProgressForSegment,
  MAX_BUFFER_AHEAD_SECONDS,
  QUOTA_RETRY_BUFFER_AHEAD_SECONDS,
  segmentForTimelineTime,
  shouldApplyBufferBackpressure,
  supportsContinuousMediaSource,
} from '../src/contexts/playerMediaSource.js';

const songs = [
  { source: 'qq', id: 'a', name: '凝眸（对唱版）', duration: 219 },
  { source: 'qq', id: 'b', name: '凝眸', duration: 221 },
  { source: 'qq', id: 'c', name: '下一首', duration: 180 },
];
const segments = [
  { id: '0:a', song: songs[0], start: 0, end: 219, complete: true },
  { id: '1:b', song: songs[1], start: 219, end: 440, complete: true },
  { id: '2:c', song: songs[2], start: 440, end: 620, complete: true },
];

assert.equal(CONTINUOUS_AUDIO_MIME, 'audio/mp4; codecs="flac"');
assert.equal(MAX_BUFFER_AHEAD_SECONDS, 75);
assert.equal(QUOTA_RETRY_BUFFER_AHEAD_SECONDS, 30);
assert.equal(bufferedAheadSeconds({ buffered: { length: 1, end: () => 80 } }, 12), 68);
assert.equal(shouldApplyBufferBackpressure(76), true, '超过 75 秒前向缓冲时必须暂停追加');
assert.equal(shouldApplyBufferBackpressure(45), false, '缓冲消耗后应恢复网络读取和追加');
assert.equal(
  supportsContinuousMediaSource({ MediaSourceCtor: { isTypeSupported: (mime) => mime === CONTINUOUS_AUDIO_MIME } }),
  true,
  '浏览器声明支持 FLAC/fMP4 时应启用连续管线',
);
assert.equal(
  supportsContinuousMediaSource({ MediaSourceCtor: { isTypeSupported: () => false } }),
  false,
  '不支持目标 MIME 时必须回退原生 audio src',
);

assert.equal(segmentForTimelineTime(segments, 218.9, 0).segment.id, '0:a');
assert.equal(
  segmentForTimelineTime(segments, 219.05, 0).segment.id,
  '1:b',
  '跨过真实失败的歌曲边界后应切换时间轴元数据，而不是结束 audio',
);
assert.equal(segmentForTimelineTime(segments, 440.1, 1).segment.id, '2:c');
assert.deepEqual(
  localProgressForSegment(segments[1], 219.7),
  { cur: 0.6999999999999886, dur: 221 },
  '全局 MediaSource 时间必须映射为当前歌曲局部进度',
);
assert.deepEqual(
  localProgressForSegment({ song: { duration: 0 }, start: 10, end: 42 }, 20),
  { cur: 10, dur: 32 },
  '缺少歌曲时长时应使用实际追加区间',
);

console.log('playerMediaSource tests passed');
