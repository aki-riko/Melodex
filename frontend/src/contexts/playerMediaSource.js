import { songIdentityKey } from '../utils/songIdentity.js';

export const CONTINUOUS_AUDIO_MIME = 'audio/mp4; codecs="flac"';
// 与 backend/internal/web/playback_chunk.go 保持一致的分块协议常量。
export const PLAYBACK_CHUNK_DURATION_SECONDS = 12;
// 每块约 12 秒。Chrome 对高码率 FLAC SourceBuffer 的限制按字节而非时长计算，
// 继续预取到 75~84 秒会在部分歌曲上先触发 QuotaExceededError。保留三个完整
// 分块的前向余量，同时在每次追加前回收已播放区间，避免等配额耗尽后才清理。
export const MAX_BUFFER_AHEAD_SECONDS = 36;
export const QUOTA_RETRY_BUFFER_AHEAD_SECONDS = 12;
export const PLAYBACK_CHUNK_MAX_ATTEMPTS = 6;
export const PLAYBACK_CHUNK_RETRY_BASE_MS = 500;
export const PLAYBACK_CHUNK_REQUEST_TIMEOUT_MS = 30000;

const waitForEvent = (target, successEvent, errorEvents = []) => new Promise((resolve, reject) => {
  const cleanup = () => {
    target.removeEventListener(successEvent, onSuccess);
    errorEvents.forEach((event) => target.removeEventListener(event, onError));
  };
  const onSuccess = () => {
    cleanup();
    resolve();
  };
  const onError = (event) => {
    cleanup();
    reject(event?.error || new Error(`${successEvent} 等待失败: ${event?.type || 'unknown'}`));
  };
  target.addEventListener(successEvent, onSuccess, { once: true });
  errorEvents.forEach((event) => target.addEventListener(event, onError, { once: true }));
});

const bufferedEnd = (sourceBuffer) => {
  const ranges = sourceBuffer?.buffered;
  if (!ranges?.length) return 0;
  try {
    return Number(ranges.end(ranges.length - 1) || 0);
  } catch {
    return 0;
  }
};

export const playbackChunkIndexForTime = (seconds) => Math.max(
  0,
  Math.floor(Math.max(0, Number(seconds || 0)) / PLAYBACK_CHUNK_DURATION_SECONDS),
);

export const bufferedRangeContains = (ranges, time, endMarginSeconds = 0.05) => {
  const target = Number(time);
  if (!ranges?.length || !Number.isFinite(target)) return false;
  for (let index = 0; index < ranges.length; index += 1) {
    const start = Number(ranges.start(index));
    const end = Number(ranges.end(index));
    if (target >= start && target <= end - endMarginSeconds) return true;
  }
  return false;
};

export const bufferedAheadSeconds = (sourceBuffer, currentTime = 0) => (
  Math.max(0, bufferedEnd(sourceBuffer) - Number(currentTime || 0))
);

export const shouldApplyBufferBackpressure = (aheadSeconds, maxAhead = MAX_BUFFER_AHEAD_SECONDS) => (
  Number(aheadSeconds || 0) > Number(maxAhead || 0)
);

// 连续播放管线失败时该给用户什么提示。
//
// 关键区别是"还有没有已缓冲的音频可以继续放":
//   - 有 → 让用户听已缓冲部分, 提示回到播放器重播(旧文案只覆盖这一种情况);
//   - 没有 → 一秒钟都没放出来。旧文案在这里是错的: "将播完已缓冲部分"其实什么都没有,
//     用户看到的是"提示播放, 但一直是静音", 以为播放器坏了却不知道该怎么办。
//     此时必须明确说没拿到音频, 并引导重试(而不是暗示正在播放)。
//
// 第三层(2026-10 补充):光说"请点一下播放重试"也不够。
// 真实案例:「天龙八部之宿敌」QQ 原唱下架后,后端报 no matching song identity,
// 这种情况重试永远不会成功。所以再区分 retryable:
//   - 不可重试 → 直接说"这首歌在源上已不可用",引导换源/换歌,而不是让人白点;
//   - 可重试 → 保留"重试"的说法。
// 让"原因 + 后续建议"拼接读起来顺口:原因已自带句末标点时不重复加。
const joinReason = (text) => (/[。！？;；]$/.test(text) ? text : `${text}；`);

export const describePipelineFailureNotice = ({ song, bufferedSeconds = 0, reason = '', retryable = true } = {}) => {
  const name = song?.name || '当前歌曲';
  if (Number(bufferedSeconds) > 0.5) {
    return `「${name}」连续播放缓冲异常，将播完已缓冲部分；请回到播放器重新播放。`;
  }
  const detail = String(reason || '').trim();
  if (!retryable) {
    // 后端已给出中文原因时直接用,不要把技术错误码丢给用户
    const hint = detail || '这首歌在当前音乐源上暂时无法播放';
    return `「${name}」${joinReason(hint)}换一个源或换一首试试。`;
  }
  if (detail) {
    return `「${name}」播放失败：${joinReason(detail)}请点一下播放重试。`;
  }
  return `「${name}」没能取到音频数据，播放已停止；请点一下播放重试。`;
};

const waitForPlaybackProgress = (audio, timeoutMs = 1000) => new Promise((resolve) => {
  let timer = null;
  const finish = () => {
    audio?.removeEventListener?.('timeupdate', finish);
    if (timer != null) globalThis.clearTimeout?.(timer);
    resolve();
  };
  audio?.addEventListener?.('timeupdate', finish, { once: true });
  timer = globalThis.setTimeout?.(finish, timeoutMs);
});

const abortError = () => new DOMException('播放会话已取消', 'AbortError');

const waitForRetryDelay = (delayMs, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) {
    reject(abortError());
    return;
  }
  let timer = null;
  const cleanup = () => {
    if (timer != null) globalThis.clearTimeout?.(timer);
    signal?.removeEventListener?.('abort', onAbort);
  };
  const onAbort = () => {
    cleanup();
    reject(abortError());
  };
  timer = globalThis.setTimeout?.(() => {
    cleanup();
    resolve();
  }, delayMs);
  signal?.addEventListener?.('abort', onAbort, { once: true });
});

const playbackChunkError = (message, retryable = true) => {
  const error = new Error(message);
  error.retryable = retryable;
  return error;
};

// 读取后端 502 的中文原因。
// 后端在 playback_segment 打开音频失败时会把原因放在响应体里
// (例如"这首歌在当前音乐源需要付费或会员才能播放…")。
// 取不到就返回空串,由调用方回退到通用文案 —— 绝不能因为读响应体抛错而掩盖原始失败。
const readPlaybackErrorText = async (response) => {
  try {
    const text = await response.text?.();
    if (!text) return '';
    const trimmed = String(text).trim();
    if (!trimmed) return '';
    // 太长的是 HTML 错误页/堆栈,不适合直接给用户看
    if (trimmed.length > 120 || trimmed.startsWith('<')) return '';
    return trimmed;
  } catch {
    return '';
  }
};

const fetchPlaybackChunkOnce = async ({
  url,
  chunkIndex,
  fetchImpl,
  signal,
  timeoutMs,
}) => {
  if (signal?.aborted) throw abortError();
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener?.('abort', onAbort, { once: true });
  const timeout = globalThis.setTimeout?.(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      credentials: 'include',
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!response.ok) {
      // 5xx 不一定是"网络抖了"。后端现在会带 X-Melodex-Playback-Retryable:
      //   · 0 → 这首歌在源上已不可用(下架/版权),重试永远不会好
      //   · 1/缺失 → 临时故障,可重试
      // 以及一段中文原因(响应体)。据此决定重试与否,并把真实原因带到提示里,
      // 否则用户只会看到"请点一下播放重试"却永远播不出来。
      const retryableHeader = response.headers?.get?.('x-melodex-playback-retryable');
      const backendReason = await readPlaybackErrorText(response);
      let retryable;
      if (retryableHeader === '0') retryable = false;
      else if (retryableHeader === '1') retryable = true;
      else retryable = response.status === 408 || response.status === 429 || response.status >= 500;
      throw playbackChunkError(
        backendReason || `媒体分块请求失败: HTTP ${response.status || 0}`,
        retryable,
      );
    }
    const contentType = response.headers?.get?.('content-type') || '';
    if (!contentType.toLowerCase().includes('audio/mp4')) {
      throw playbackChunkError(`媒体分块类型错误: ${contentType || 'unknown'}`, false);
    }
    const responseChunkHeader = response.headers?.get?.('x-melodex-chunk-index');
    const responseChunk = Number(responseChunkHeader);
    if (responseChunkHeader != null && responseChunkHeader !== ''
      && Number.isFinite(responseChunk) && responseChunk !== chunkIndex) {
      throw playbackChunkError(`媒体分块序号错误: ${responseChunk}`, false);
    }
    const buffer = await response.arrayBuffer();
    if (!buffer?.byteLength) throw playbackChunkError('媒体分块为空');
    return {
      bytes: new Uint8Array(buffer),
      final: response.headers?.get?.('x-melodex-chunk-final') === '1',
      sourceKind: response.headers?.get?.('x-melodex-playback-source') || '',
    };
  } catch (error) {
    if (signal?.aborted) throw abortError();
    if (controller.signal.aborted && error?.name === 'AbortError') {
      throw playbackChunkError(`媒体分块请求超时: ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    if (timeout != null) globalThis.clearTimeout?.(timeout);
    signal?.removeEventListener?.('abort', onAbort);
  }
};

export const fetchPlaybackChunkWithRetry = async ({
  url,
  chunkIndex,
  fetchImpl = globalThis.fetch?.bind(globalThis),
  signal,
  maxAttempts = PLAYBACK_CHUNK_MAX_ATTEMPTS,
  retryBaseMs = PLAYBACK_CHUNK_RETRY_BASE_MS,
  timeoutMs = PLAYBACK_CHUNK_REQUEST_TIMEOUT_MS,
  waitImpl = waitForRetryDelay,
  onRetry = () => {},
}) => {
  if (!fetchImpl) throw new Error('当前环境不支持媒体分块请求');
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fetchPlaybackChunkOnce({ url, chunkIndex, fetchImpl, signal, timeoutMs });
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      lastError = error;
      if (error?.retryable === false || attempt >= maxAttempts) break;
      const delayMs = Math.min(retryBaseMs * (2 ** (attempt - 1)), 5000);
      onRetry({ attempt, delayMs, error });
      await waitImpl(delayMs, signal);
    }
  }
  throw lastError || new Error('媒体分块请求失败');
};

const songDurationSeconds = (song, fallback = 0) => {
  const raw = Number(song?.duration || 0);
  if (raw > 10000) return raw / 1000;
  return raw > 0 ? raw : Math.max(0, fallback);
};

export const supportsContinuousMediaSource = ({
  MediaSourceCtor = globalThis.MediaSource,
} = {}) => Boolean(
  MediaSourceCtor
  && typeof MediaSourceCtor.isTypeSupported === 'function'
  && MediaSourceCtor.isTypeSupported(CONTINUOUS_AUDIO_MIME),
);

export const segmentForTimelineTime = (segments, timelineTime, activeIndex = -1) => {
  if (!Array.isArray(segments) || !segments.length) return null;
  const time = Number(timelineTime || 0);
  const epsilon = 0.03;
  for (let index = Math.max(0, activeIndex); index < segments.length; index += 1) {
    const segment = segments[index];
    const end = Number.isFinite(segment.end) ? segment.end : Number.POSITIVE_INFINITY;
    if (time + epsilon >= segment.start && time < end - epsilon) return { segment, index };
  }
  for (let index = 0; index < Math.max(0, activeIndex); index += 1) {
    const segment = segments[index];
    const end = Number.isFinite(segment.end) ? segment.end : Number.POSITIVE_INFINITY;
    if (time + epsilon >= segment.start && time < end - epsilon) return { segment, index };
  }
  const last = segments[segments.length - 1];
  if (time + epsilon >= last.start) return { segment: last, index: segments.length - 1 };
  return { segment: segments[0], index: 0 };
};

export const localProgressForSegment = (segment, timelineTime) => {
  if (!segment) return { cur: 0, dur: 0 };
  const cur = Math.max(0, Number(timelineTime || 0) - Number(segment.start || 0));
  const appendedDuration = Number.isFinite(segment.end)
    ? Math.max(0, segment.end - segment.start)
    : 0;
  const dur = songDurationSeconds(segment.song, appendedDuration) || appendedDuration;
  return { cur: dur > 0 ? Math.min(cur, dur) : cur, dur };
};

export class ContinuousMediaSourcePlayback {
  constructor({
    audio,
    getSegmentUrl,
    getNextSong,
    onBeforeSegmentChange = () => true,
    onSegmentChange = () => {},
    onDiagnostic = () => {},
    onError = () => {},
    fetchImpl = globalThis.fetch?.bind(globalThis),
    MediaSourceCtor = globalThis.MediaSource,
    createObjectURL = globalThis.URL?.createObjectURL?.bind(globalThis.URL),
    revokeObjectURL = globalThis.URL?.revokeObjectURL?.bind(globalThis.URL),
  }) {
    this.audio = audio;
    this.getSegmentUrl = getSegmentUrl;
    this.getNextSong = getNextSong;
    this.onBeforeSegmentChange = onBeforeSegmentChange;
    this.onSegmentChange = onSegmentChange;
    this.onDiagnostic = onDiagnostic;
    this.onError = onError;
    this.fetchImpl = fetchImpl;
    this.MediaSourceCtor = MediaSourceCtor;
    this.createObjectURL = createObjectURL;
    this.revokeObjectURL = revokeObjectURL;
    this.mediaSource = null;
    this.sourceBuffer = null;
    this.objectUrl = '';
    this.abortController = null;
    this.segments = [];
    this.activeIndex = -1;
    this.appendPromise = null;
    this.destroyed = false;
    this.queueEnded = false;
    this.failed = false;
  }

  async start(song, { autoplay = true, startAtSeconds = 0 } = {}) {
    if (!this.audio || !this.fetchImpl || !this.createObjectURL) {
      throw new Error('当前环境不支持连续媒体管线');
    }
    if (!supportsContinuousMediaSource({ MediaSourceCtor: this.MediaSourceCtor })) {
      throw new Error(`浏览器不支持 ${CONTINUOUS_AUDIO_MIME}`);
    }

    this.mediaSource = new this.MediaSourceCtor();
    this.objectUrl = this.createObjectURL(this.mediaSource);
    this.audio.src = this.objectUrl;
    this.audio.load();

    // 必须在用户点击播放的调用链内先调用 play()。等待 sourceopen 后再调用会丢失
    // transient user activation；Promise 会在首个媒体分段可播放后自然 resolve。
    const playPromise = autoplay ? this.audio.play() : Promise.resolve();
    await waitForEvent(this.mediaSource, 'sourceopen', ['sourceclose']);
    if (this.destroyed) throw new DOMException('播放会话已取消', 'AbortError');

    this.sourceBuffer = this.mediaSource.addSourceBuffer(CONTINUOUS_AUDIO_MIME);
    this.sourceBuffer.mode = 'sequence';
    const requestedStart = Math.max(0, Number(startAtSeconds || 0));
    const startChunkIndex = playbackChunkIndexForTime(requestedStart);
    if (startChunkIndex > 0) {
      this.sourceBuffer.timestampOffset = startChunkIndex * PLAYBACK_CHUNK_DURATION_SECONDS;
    }
    this.abortController = new AbortController();
    this.appendPromise = this.appendSong(song, {
      startChunkIndex,
      segmentStart: 0,
      onFirstChunkReady: requestedStart > 0
        ? () => { this.audio.currentTime = requestedStart; }
        : null,
    })
      .then(() => this.appendNextAfter(song))
      .catch((error) => this.handlePipelineError(error, song))
      .finally(() => { this.appendPromise = null; });

    await playPromise;
    return true;
  }

  async appendNextAfter(song) {
    if (this.destroyed) return;
    const nextSong = this.getNextSong?.(song) || null;
    if (!nextSong) {
      this.queueEnded = true;
      return;
    }
    await this.appendSong(nextSong);
  }

  async appendSong(song, {
    startChunkIndex = 0,
    segmentStart,
    onFirstChunkReady = null,
  } = {}) {
    if (this.destroyed) throw new DOMException('播放会话已取消', 'AbortError');
    const start = Number.isFinite(segmentStart) ? segmentStart : bufferedEnd(this.sourceBuffer);
    const segment = {
      id: `${this.segments.length}:${songIdentityKey(song)}`,
      song,
      start,
      end: Number.POSITIVE_INFINITY,
      complete: false,
    };
    this.segments.push(segment);

    let bytes = 0;
    let chunkIndex = Math.max(0, Number(startChunkIndex || 0));
    let firstChunk = true;
    while (!this.destroyed) {
      const chunk = await fetchPlaybackChunkWithRetry({
        url: this.getSegmentUrl(song, chunkIndex),
        chunkIndex,
        fetchImpl: this.fetchImpl,
        signal: this.abortController.signal,
        onRetry: ({ attempt, delayMs, error }) => this.onDiagnostic({
          event: 'mse_chunk_retry',
          song,
          reason: `chunk=${chunkIndex};attempt=${attempt};delay_ms=${delayMs};error=${error?.name || 'Error'}:${error?.message || ''}`,
        }),
      });
      bytes += chunk.bytes.byteLength;
      await this.appendBytes(chunk.bytes);
      if (this.destroyed) throw abortError();
      if (firstChunk) {
        firstChunk = false;
        onFirstChunkReady?.({ chunkIndex, song });
      }
      if (this.activeIndex < 0) this.activateSegment(0);
      this.onDiagnostic({
        event: 'mse_chunk_ready',
        song,
        bytes: chunk.bytes.byteLength,
        reason: `chunk=${chunkIndex};final=${chunk.final ? 1 : 0};source=${chunk.sourceKind}`,
      });
      if (chunk.final) break;
      chunkIndex += 1;
    }
    if (this.destroyed) throw new DOMException('播放会话已取消', 'AbortError');

    const end = bufferedEnd(this.sourceBuffer);
    if (!(end > start)) throw new Error('媒体分段没有产生可播放时长');
    segment.end = end;
    segment.complete = true;
    this.onDiagnostic({ event: 'mse_segment_ready', song, start, end, bytes });
    return segment;
  }

  async appendBytes(value) {
    // 主动回收比 QuotaExceededError 后补救可靠。真实 Chrome 会出现 remove() 已
    // 成功但本次媒体会话仍拒绝再次 appendBuffer() 的情况。
    await this.removePlayedBuffer();
    await this.waitForAppendWindow();
    // waitForAppendWindow 期间播放时间会继续前进；用最新时间再清理一次，否则
    // 恰好回落到上限时会跳出等待，却把刚播放完的旧字节继续留在配额里。
    await this.removePlayedBuffer(true);
    if (this.sourceBuffer.updating) {
      await waitForEvent(this.sourceBuffer, 'updateend', ['error', 'abort']);
    }
    const chunk = value.byteOffset === 0 && value.byteLength === value.buffer.byteLength
      ? value.buffer
      : value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
    try {
      this.sourceBuffer.appendBuffer(chunk);
    } catch (error) {
      if (error?.name !== 'QuotaExceededError') throw error;
      // Chromium 的 SourceBuffer 字节配额可能先于时长阈值触发。先强制回收
      // 已播放区间，再等前向缓冲降到 12 秒后仅重试一次；仍失败则把错误交给
      // 上层回退，禁止在同一块上无限重试。
      await this.removePlayedBuffer(true);
      await this.waitForAppendWindow(QUOTA_RETRY_BUFFER_AHEAD_SECONDS);
      this.sourceBuffer.appendBuffer(chunk);
    }
    await waitForEvent(this.sourceBuffer, 'updateend', ['error', 'abort']);
  }

  async waitForAppendWindow(maxAhead = MAX_BUFFER_AHEAD_SECONDS) {
    while (!this.destroyed && shouldApplyBufferBackpressure(
      bufferedAheadSeconds(this.sourceBuffer, this.audio?.currentTime || 0),
      maxAhead,
    )) {
      await this.removePlayedBuffer();
      await waitForPlaybackProgress(this.audio);
    }
    if (this.destroyed) throw new DOMException('播放会话已取消', 'AbortError');
  }

  handleTimeUpdate(timelineTime = this.audio?.currentTime || 0) {
    const located = segmentForTimelineTime(this.segments, timelineTime, this.activeIndex);
    if (!located) return { cur: 0, dur: 0, segment: null };
    if (located.index !== this.activeIndex) {
      if (this.onBeforeSegmentChange({ ...located.segment, index: located.index }) === false) {
        if (this.audio) {
          this.audio.currentTime = located.segment.start;
          this.audio.pause();
        }
        const previous = this.segments[this.activeIndex];
        return { ...localProgressForSegment(previous, previous?.end || timelineTime), segment: previous };
      }
      this.activateSegment(located.index);
      this.removePlayedBuffer().catch((error) => {
        this.onDiagnostic({ event: 'mse_buffer_cleanup_failed', reason: String(error) });
      });
    }

    const active = this.segments[this.activeIndex];
    if (active?.complete && this.activeIndex === this.segments.length - 1 && !this.appendPromise && !this.queueEnded) {
      this.appendPromise = this.appendNextAfter(active.song)
        .catch((error) => this.handlePipelineError(error, active.song))
        .finally(() => { this.appendPromise = null; });
    }
    if (this.queueEnded && active?.complete && this.activeIndex === this.segments.length - 1) {
      this.endStreamWhenReady();
    }

    return { ...localProgressForSegment(active, timelineTime), segment: active };
  }

  activateSegment(index) {
    const segment = this.segments[index];
    if (!segment) return;
    this.activeIndex = index;
    this.onSegmentChange({ ...segment, index });
  }

  seekLocal(seconds) {
    const segment = this.segments[this.activeIndex];
    if (!segment || !this.audio) return false;
    const progress = localProgressForSegment(segment, segment.start + Number(seconds || 0));
    const timelineTime = segment.start + progress.cur;
    if (!bufferedRangeContains(this.sourceBuffer?.buffered, timelineTime)) return false;
    this.audio.currentTime = timelineTime;
    return true;
  }

  currentLocalProgress(timelineTime = this.audio?.currentTime || 0) {
    return localProgressForSegment(this.segments[this.activeIndex], timelineTime);
  }

  async removePlayedBuffer(force = false) {
    const buffer = this.sourceBuffer;
    if (!buffer || this.destroyed || buffer.updating) return;
    const removeEnd = Math.max(0, Number(this.audio?.currentTime || 0) - 5);
    if (removeEnd <= 0 || !buffer.buffered?.length) return;
    const rangeStart = buffer.buffered.start(0);
    if (removeEnd <= rangeStart + (force ? 0.25 : 10)) return;
    buffer.remove(rangeStart, removeEnd);
    await waitForEvent(buffer, 'updateend', ['error', 'abort']);
  }

  endStreamWhenReady() {
    if (!this.mediaSource || this.mediaSource.readyState !== 'open' || this.sourceBuffer?.updating) return;
    try {
      this.mediaSource.endOfStream();
    } catch (error) {
      this.onDiagnostic({ event: 'mse_end_of_stream_failed', reason: String(error) });
    }
  }

  handlePipelineError(error, song) {
    if (this.destroyed || this.failed || error?.name === 'AbortError') return;
    this.failed = true;
    this.queueEnded = true;
    const current = this.segments[this.segments.length - 1];
    const end = bufferedEnd(this.sourceBuffer);
    if (current && end > current.start) {
      current.end = end;
      current.complete = true;
    }
    this.onDiagnostic({
      event: 'mse_pipeline_error',
      song,
      reason: `${error?.name || 'Error'}:${error?.message || ''}`,
      buffered_end: end,
      current_time: Number(this.audio?.currentTime || 0),
    });
    this.onError(error, song, {
      bufferedSeconds: Math.max(0, end - Number(this.audio?.currentTime || 0)),
      // 把后端给出的中文原因与"是否值得重试"带给提示层。
      // error.message 来自 readPlaybackErrorText / playbackChunkError。
      reason: String(error?.message || ''),
      retryable: error?.retryable !== false,
    });
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.abortController?.abort();
    if (this.sourceBuffer?.updating) {
      try { this.sourceBuffer.abort(); } catch { /* source 已关闭 */ }
    }
    if (this.mediaSource?.readyState === 'open') {
      try { this.mediaSource.endOfStream(); } catch { /* source 已关闭 */ }
    }
    if (this.objectUrl) this.revokeObjectURL?.(this.objectUrl);
    this.objectUrl = '';
  }
}
