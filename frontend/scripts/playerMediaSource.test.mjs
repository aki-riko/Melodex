import assert from 'node:assert/strict';
import {
  bufferedRangeContains,
  bufferedAheadSeconds,
  CONTINUOUS_AUDIO_MIME,
  ContinuousMediaSourcePlayback,
  describePipelineFailureNotice,
  fetchPlaybackChunkWithRetry,
  localProgressForSegment,
  MAX_BUFFER_AHEAD_SECONDS,
  PLAYBACK_CHUNK_DURATION_SECONDS,
  PLAYBACK_CHUNK_MAX_ATTEMPTS,
  PLAYBACK_CHUNK_REQUEST_TIMEOUT_MS,
  PLAYBACK_CHUNK_RETRY_BASE_MS,
  playbackChunkIndexForTime,
  QUOTA_RETRY_BUFFER_AHEAD_SECONDS,
  segmentForTimelineTime,
  shouldApplyBufferBackpressure,
  supportsContinuousMediaSource,
} from '../src/contexts/playerMediaSource.js';
import { buildPlaybackDiagnostic } from '../src/contexts/playerPlayback.js';
import { pickNextSong } from '../src/contexts/playerQueue.js';

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
assert.equal(PLAYBACK_CHUNK_DURATION_SECONDS, 12);
assert.equal(MAX_BUFFER_AHEAD_SECONDS, 36);
assert.equal(QUOTA_RETRY_BUFFER_AHEAD_SECONDS, 12);
assert.equal(PLAYBACK_CHUNK_MAX_ATTEMPTS, 6);
assert.equal(PLAYBACK_CHUNK_RETRY_BASE_MS, 500);
assert.equal(PLAYBACK_CHUNK_REQUEST_TIMEOUT_MS, 30000);
assert.equal(bufferedAheadSeconds({ buffered: { length: 1, end: () => 80 } }, 12), 68);
assert.equal(shouldApplyBufferBackpressure(37), true, '超过 36 秒前向缓冲时必须暂停追加');
assert.equal(shouldApplyBufferBackpressure(36), false, '缓冲回落到三个完整分块后应恢复追加');
assert.equal(playbackChunkIndexForTime(0), 0);
assert.equal(playbackChunkIndexForTime(11.99), 0);
assert.equal(playbackChunkIndexForTime(12), 1);
assert.equal(playbackChunkIndexForTime(125), 10, '125秒应直接请求第10个12秒分块');
assert.equal(
  bufferedRangeContains({ length: 1, start: () => 84, end: () => 132 }, 126),
  true,
  '目标仍在当前缓冲范围内时应原地跳转',
);
assert.equal(
  bufferedRangeContains({ length: 1, start: () => 84, end: () => 132 }, 20),
  false,
  '目标已被清理时必须重建播放管线',
);
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

const chunkFetchCalls = [];
const chunkRetryEvents = [];
const chunkResponse = await fetchPlaybackChunkWithRetry({
  url: '/music/playback_segment?id=a&source=qq&chunk=3',
  chunkIndex: 3,
  maxAttempts: 3,
  retryBaseMs: 1,
  waitImpl: async () => {},
  onRetry: (event) => chunkRetryEvents.push(event),
  fetchImpl: async (url) => {
    chunkFetchCalls.push(url);
    if (chunkFetchCalls.length === 1) throw new TypeError('network error');
    return {
      ok: true,
      status: 200,
      headers: {
        get: (name) => ({
          'content-type': 'audio/mp4; codecs="flac"',
          'x-melodex-chunk-index': '3',
          'x-melodex-chunk-final': '0',
          'x-melodex-playback-source': 'network',
        }[name.toLowerCase()] ?? null),
      },
      arrayBuffer: async () => Uint8Array.from([1, 2, 3, 4]).buffer,
    };
  },
});
assert.equal(chunkFetchCalls.length, 2, '网络错误后必须重试同一个短块');
assert.equal(chunkFetchCalls[0], chunkFetchCalls[1], '重试不得跳到下一块或更换媒体 URL');
assert.equal(chunkRetryEvents.length, 1, '每次短块重试都应留下诊断事件');
assert.deepEqual([...chunkResponse.bytes], [1, 2, 3, 4]);
assert.equal(chunkResponse.final, false);
assert.equal(chunkResponse.sourceKind, 'network');

await assert.rejects(
  fetchPlaybackChunkWithRetry({
    url: '/music/playback_segment?id=a&source=qq&chunk=0',
    chunkIndex: 0,
    maxAttempts: 6,
    waitImpl: async () => {
      throw new Error('非重试错误不应进入等待');
    },
    fetchImpl: async () => ({
      ok: false,
      status: 400,
      headers: { get: () => null },
    }),
  }),
  /HTTP 400/,
  '参数错误不可盲目重试',
);

class FakeEventTarget {
  constructor() {
    this.listeners = new Map();
  }

  addEventListener(name, callback) {
    const callbacks = this.listeners.get(name) || new Set();
    callbacks.add(callback);
    this.listeners.set(name, callbacks);
  }

  removeEventListener(name, callback) {
    this.listeners.get(name)?.delete(callback);
  }

  emit(name) {
    [...(this.listeners.get(name) || [])].forEach((callback) => callback({ type: name }));
  }
}

class FakeSourceBuffer extends FakeEventTarget {
  constructor() {
    super();
    this.mode = '';
    this.updating = false;
    this.timestampOffset = 0;
    this.rangeStart = 0;
    this.end = 0;
    this.buffered = {
      get length() { return 1; },
      start: () => this.rangeStart,
      end: () => this.end,
    };
  }

  appendBuffer() {
    this.updating = true;
    queueMicrotask(() => {
      if (this.end === 0 && this.timestampOffset > 0) {
        this.rangeStart = this.timestampOffset;
        this.end = this.timestampOffset;
      }
      this.end += 12;
      this.updating = false;
      this.emit('updateend');
    });
  }

  remove() {
    queueMicrotask(() => this.emit('updateend'));
  }
}

class FakeMediaSource extends FakeEventTarget {
  static isTypeSupported(mime) {
    return mime === CONTINUOUS_AUDIO_MIME;
  }

  constructor() {
    super();
    this.readyState = 'closed';
    this.buffer = new FakeSourceBuffer();
  }

  addSourceBuffer() {
    return this.buffer;
  }

  endOfStream() {
    this.readyState = 'ended';
  }
}

class QuotaSensitiveSourceBuffer extends FakeSourceBuffer {
  constructor() {
    super();
    this.start = 0;
    this.quotaErrors = 0;
    this.buffered = {
      get length() { return 1; },
      start: () => this.start,
      end: () => this.end,
    };
  }

  appendBuffer() {
    // 对应生产真实失败：旧策略会先积累 75~84 秒高码率 FLAC，再被 Chrome
    // 拒绝追加。测试把容量收紧到 48 秒，验证追加前主动回收，不依赖报错后补救。
    if (this.end - this.start >= 48) {
      this.quotaErrors += 1;
      throw new DOMException('SourceBuffer is full', 'QuotaExceededError');
    }
    super.appendBuffer();
  }

  remove(_start, end) {
    this.updating = true;
    queueMicrotask(() => {
      this.start = Math.max(this.start, end);
      this.updating = false;
      this.emit('updateend');
    });
  }
}

class QuotaSensitiveMediaSource extends FakeMediaSource {
  constructor() {
    super();
    this.buffer = new QuotaSensitiveSourceBuffer();
  }
}

const requestedChunkURLs = [];
const fakeAudio = new FakeEventTarget();
Object.assign(fakeAudio, {
  src: '',
  currentTime: 0,
  load() {},
  play: async () => {},
});
const playback = new ContinuousMediaSourcePlayback({
  audio: fakeAudio,
  MediaSourceCtor: FakeMediaSource,
  createObjectURL: (mediaSource) => {
    queueMicrotask(() => {
      mediaSource.readyState = 'open';
      mediaSource.emit('sourceopen');
    });
    return 'blob:one-media-source';
  },
  revokeObjectURL: () => {},
  getSegmentUrl: (_song, chunkIndex) => `/chunk/${chunkIndex}`,
  getNextSong: () => null,
  fetchImpl: async (url) => {
    requestedChunkURLs.push(url);
    const chunkIndex = Number(url.split('/').at(-1));
    return {
      ok: true,
      status: 200,
      headers: {
        get: (name) => ({
          'content-type': 'audio/mp4',
          'x-melodex-chunk-index': String(chunkIndex),
          'x-melodex-chunk-final': chunkIndex === 1 ? '1' : '0',
        }[name.toLowerCase()] ?? null),
      },
      arrayBuffer: async () => Uint8Array.from([chunkIndex + 1]).buffer,
    };
  },
});
await playback.start(songs[0]);
await playback.appendPromise;
assert.equal(fakeAudio.src, 'blob:one-media-source', '整首歌所有短块必须共用一个 MediaSource URL');
assert.deepEqual(requestedChunkURLs, ['/chunk/0', '/chunk/1'], '短块必须按序请求直到 final');
assert.equal(playback.segments[0].complete, true, '全部短块追加后歌曲段才可标记完成');
assert.equal(playback.segments[0].end, 24, '歌曲时间轴应累加每个完整短块');

const repeatRequests = [];
const repeatAudio = new FakeEventTarget();
Object.assign(repeatAudio, {
  src: '',
  currentTime: 0,
  load() {},
  play: async () => {},
});
const repeatPlayback = new ContinuousMediaSourcePlayback({
  audio: repeatAudio,
  MediaSourceCtor: FakeMediaSource,
  createObjectURL: (mediaSource) => {
    queueMicrotask(() => {
      mediaSource.readyState = 'open';
      mediaSource.emit('sourceopen');
    });
    return 'blob:repeat-media-source';
  },
  revokeObjectURL: () => {},
  getSegmentUrl: (song, chunkIndex) => `/repeat/${song.id}/${chunkIndex}`,
  getNextSong: (current) => pickNextSong({
    list: songs,
    current,
    mode: 'repeat',
    forward: true,
    auto: true,
  }),
  fetchImpl: async (url) => {
    repeatRequests.push(url);
    return {
      ok: true,
      status: 200,
      headers: {
        get: (name) => ({
          'content-type': 'audio/mp4',
          'x-melodex-chunk-index': '0',
          'x-melodex-chunk-final': '1',
        }[name.toLowerCase()] ?? null),
      },
      arrayBuffer: async () => Uint8Array.from([1]).buffer,
    };
  },
});
await repeatPlayback.start(songs[0]);
await repeatPlayback.appendPromise;
assert.deepEqual(
  repeatRequests,
  ['/repeat/a/0', '/repeat/a/0'],
  'MSE 自动预接下一段时,单曲循环必须再次追加当前歌曲而不是队列下一首',
);
assert.equal(repeatAudio.src, 'blob:repeat-media-source', '单曲循环也必须保持同一个 MediaSource URL');

const randomSeekRequests = [];
const randomSeekAudio = new FakeEventTarget();
Object.assign(randomSeekAudio, {
  src: '',
  currentTime: 0,
  load() {},
  play: async () => {},
});
const randomSeekPlayback = new ContinuousMediaSourcePlayback({
  audio: randomSeekAudio,
  MediaSourceCtor: FakeMediaSource,
  createObjectURL: (mediaSource) => {
    queueMicrotask(() => {
      mediaSource.readyState = 'open';
      mediaSource.emit('sourceopen');
    });
    return 'blob:random-seek-media-source';
  },
  revokeObjectURL: () => {},
  getSegmentUrl: (_song, chunkIndex) => `/seek/${chunkIndex}`,
  getNextSong: () => null,
  fetchImpl: async (url) => {
    randomSeekRequests.push(url);
    const chunkIndex = Number(url.split('/').at(-1));
    return {
      ok: true,
      status: 200,
      headers: {
        get: (name) => ({
          'content-type': 'audio/mp4',
          'x-melodex-chunk-index': String(chunkIndex),
          'x-melodex-chunk-final': '1',
        }[name.toLowerCase()] ?? null),
      },
      arrayBuffer: async () => Uint8Array.from([chunkIndex + 1]).buffer,
    };
  },
});
await randomSeekPlayback.start(songs[0], { startAtSeconds: 15.5 });
await randomSeekPlayback.appendPromise;
assert.deepEqual(randomSeekRequests, ['/seek/1'], '生产15.5秒回跳不得从第0块重新顺序下载');
assert.equal(randomSeekPlayback.sourceBuffer.timestampOffset, 12, '目标分块必须放到原歌曲时间轴位置');
assert.equal(randomSeekAudio.currentTime, 15.5, '首个目标分块就绪后应立即应用生产点击进度');
assert.equal(randomSeekPlayback.seekLocal(5), false, '未缓冲区间不能伪装成原地 seek 成功');
assert.equal(randomSeekPlayback.seekLocal(20), true, '目标分块内的后续点击应直接完成');
assert.equal(randomSeekAudio.currentTime, 20);

const quotaAudio = new FakeEventTarget();
Object.assign(quotaAudio, {
  src: '',
  currentTime: 0,
  load() {},
  play: async () => {},
});
const quotaAudioAddEventListener = quotaAudio.addEventListener.bind(quotaAudio);
quotaAudio.addEventListener = (name, callback) => {
  quotaAudioAddEventListener(name, callback);
  if (name === 'timeupdate') {
    queueMicrotask(() => {
      quotaAudio.currentTime += 12;
      quotaAudio.emit('timeupdate');
    });
  }
};
const quotaPlayback = new ContinuousMediaSourcePlayback({
  audio: quotaAudio,
  MediaSourceCtor: QuotaSensitiveMediaSource,
  createObjectURL: (mediaSource) => {
    queueMicrotask(() => {
      mediaSource.readyState = 'open';
      mediaSource.emit('sourceopen');
    });
    return 'blob:quota-sensitive-media-source';
  },
  revokeObjectURL: () => {},
  getSegmentUrl: (_song, chunkIndex) => `/quota/${chunkIndex}`,
  getNextSong: () => null,
  fetchImpl: async (url) => {
    const chunkIndex = Number(url.split('/').at(-1));
    return {
      ok: true,
      status: 200,
      headers: {
        get: (name) => ({
          'content-type': 'audio/mp4',
          'x-melodex-chunk-index': String(chunkIndex),
          'x-melodex-chunk-final': chunkIndex === 9 ? '1' : '0',
        }[name.toLowerCase()] ?? null),
      },
      arrayBuffer: async () => Uint8Array.from([chunkIndex + 1]).buffer,
    };
  },
});
await quotaPlayback.start(songs[0]);
await quotaPlayback.appendPromise;
assert.equal(
  quotaPlayback.sourceBuffer.quotaErrors,
  0,
  '高码率长音频必须在 Chrome 配额报错前主动回收已播放区间',
);
assert.equal(quotaPlayback.segments[0].complete, true);
assert.equal(quotaPlayback.segments[0].end, 120);

// ===== 连续播放失败文案 =====
// 现场事故(2026-10): 后端 /music/playback_segment 一直 502, 前端 MSE 重试 6 次后
// 走到 onError。旧文案无论有没有缓冲都说"将播完已缓冲部分", 而实际上一秒都没缓冲,
// 用户看到的是"提示在播, 但一直静音", 完全不知道该怎么办。
assert.match(
  describePipelineFailureNotice({ song: { name: '爱情讯息' }, bufferedSeconds: 0 }),
  /没能取到音频数据.*播放已停止/,
  '零缓冲时必须明确告知没拿到音频, 不能谎称"将播完已缓冲部分"',
);
assert.doesNotMatch(
  describePipelineFailureNotice({ song: { name: '爱情讯息' }, bufferedSeconds: 0 }),
  /将播完已缓冲部分/,
  '零缓冲时禁止出现"将播完已缓冲部分"',
);
assert.match(
  describePipelineFailureNotice({ song: { name: '爱情讯息' }, bufferedSeconds: 30 }),
  /将播完已缓冲部分.*重新播放/,
  '有缓冲时应保留原文案, 让用户听完已缓冲部分',
);
assert.match(
  describePipelineFailureNotice({ bufferedSeconds: 0 }),
  /当前歌曲/,
  '缺少歌名时也要有可读文案',
);

// ---- 不可重试的失败必须引导"换源/换歌", 而不是让人反复点播放 ----
//
// 真实案例(2026-10-25)：「天龙八部之宿敌」QQ 原唱下架,后端
//   provider returned no matching song identity
// 用户看到的却只是"请点一下播放重试",点几十次也不会好。
// 后端现在会在 502 响应体给出中文原因 + X-Melodex-Playback-Retryable: 0,
// 前端据此走这个分支。
{
  const irreversible = describePipelineFailureNotice({
    song: { name: '天龙八部之宿敌' },
    bufferedSeconds: 0,
    reason: '这首歌在当前音乐源上已不可用(可能已下架)',
    retryable: false,
  });
  assert.match(irreversible, /已不可用/, '不可重试时要说明歌曲不可用');
  assert.match(irreversible, /换一个源或换一首/, '不可重试时要引导换源/换歌');
  assert.doesNotMatch(
    irreversible,
    /点一下播放重试/,
    '不可重试时绝不能建议重试 —— 那是无效引导',
  );

  // 后端没给原因时也要有可读兜底
  const noReason = describePipelineFailureNotice({
    song: { name: '某某' }, bufferedSeconds: 0, retryable: false,
  });
  assert.match(noReason, /已不可用/, '缺原因时不可重试也要有兜底文案');
  assert.doesNotMatch(noReason, /点一下播放重试/);

  // 可重试时保留"重试"引导, 并带上后端给的原因
  const retryableNotice = describePipelineFailureNotice({
    song: { name: '某某' },
    bufferedSeconds: 0,
    reason: '音频源暂时不可用,请稍后重试',
    retryable: true,
  });
  assert.match(retryableNotice, /音频源暂时不可用/, '可重试时应展示后端原因');
  assert.match(retryableNotice, /点一下播放重试/, '可重试时应保留重试引导');

  // 有缓冲时永远优先"播完已缓冲部分"(不能让用户以为立刻断了)
  const withBuffer = describePipelineFailureNotice({
    song: { name: '某某' }, bufferedSeconds: 30, reason: '任意', retryable: false,
  });
  assert.match(withBuffer, /将播完已缓冲部分/, '有缓冲时仍应优先告知会播完已缓冲部分');
}

// 生产故障复现: 每个短块都 502。管线必须在有限次重试后失败, 并把"已缓冲时长=0"
// 传给 onError —— 这正是上面文案分支的依据。
const failingAudio = new FakeEventTarget();
Object.assign(failingAudio, {
  src: '',
  currentTime: 0,
  load() {},
  play: async () => {},
});
const pipelineErrors = [];
const failingPlayback = new ContinuousMediaSourcePlayback({
  audio: failingAudio,
  MediaSourceCtor: FakeMediaSource,
  createObjectURL: (mediaSource) => {
    queueMicrotask(() => {
      mediaSource.readyState = 'open';
      mediaSource.emit('sourceopen');
    });
    return 'blob:failing-media-source';
  },
  revokeObjectURL: () => {},
  getSegmentUrl: (_song, chunkIndex) => `/failing/${chunkIndex}`,
  getNextSong: () => null,
  onError: (error, song, detail) => pipelineErrors.push({ error, song, detail }),
  fetchImpl: async () => ({ ok: false, status: 502, headers: { get: () => null } }),
});
await failingPlayback.start(songs[0]);
await failingPlayback.appendPromise;
assert.equal(failingPlayback.failed, true, '短块持续 502 时管线必须进入 failed 状态');
assert.equal(pipelineErrors.length, 1, '管线失败只上报一次, 不能反复刷提示');
assert.equal(
  pipelineErrors[0].detail.bufferedSeconds,
  0,
  '一块都没追加成功时必须上报 0 秒缓冲 —— 上层据此选择"没取到音频"文案',
);
assert.match(
  String(pipelineErrors[0].error?.message || ''),
  /HTTP 502/,
  '失败原因必须保留上游状态码, 便于定位是后端还是网络',
);

const diagnostic = buildPlaybackDiagnostic({
  event: 'media_session_action',
  audio: {
    currentTime: Number.NaN,
    duration: Number.POSITIVE_INFINITY,
    buffered: { length: 1, end: () => Number.POSITIVE_INFINITY },
  },
  userActivation: { isActive: false, hasBeenActive: true },
  pageElapsedMs: 901234.5,
  deviceInfo: 'model=test-phone;platform_version=15',
});
assert.equal(diagnostic.current_time, 0, 'NaN 播放时间不得进入诊断 JSON');
assert.equal(diagnostic.duration, 0, 'MediaSource 的 Infinity duration 必须归一化为 0');
assert.equal(diagnostic.buffered_end, 0, '非有限缓冲终点不得进入诊断 JSON');
assert.equal(diagnostic.user_activation_supported, true);
assert.equal(diagnostic.user_activation_active, false);
assert.equal(diagnostic.user_activation_has_been_active, true);
assert.equal(diagnostic.page_elapsed_ms, 901234.5);
assert.equal(diagnostic.device_info, 'model=test-phone;platform_version=15');

console.log('playerMediaSource tests passed');
