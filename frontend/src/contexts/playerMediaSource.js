import { songIdentityKey } from '../utils/songIdentity.js';

export const CONTINUOUS_AUDIO_MIME = 'audio/mp4; codecs="flac"';
export const MAX_BUFFER_AHEAD_SECONDS = 75;
export const QUOTA_RETRY_BUFFER_AHEAD_SECONDS = 30;
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

export const bufferedAheadSeconds = (sourceBuffer, currentTime = 0) => (
  Math.max(0, bufferedEnd(sourceBuffer) - Number(currentTime || 0))
);

export const shouldApplyBufferBackpressure = (aheadSeconds, maxAhead = MAX_BUFFER_AHEAD_SECONDS) => (
  Number(aheadSeconds || 0) > Number(maxAhead || 0)
);

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
      const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
      throw playbackChunkError(`媒体分块请求失败: HTTP ${response.status || 0}`, retryable);
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

  async start(song, { autoplay = true } = {}) {
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
    this.abortController = new AbortController();
    this.appendPromise = this.appendSong(song)
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

  async appendSong(song) {
    if (this.destroyed) throw new DOMException('播放会话已取消', 'AbortError');
    const start = bufferedEnd(this.sourceBuffer);
    const segment = {
      id: `${this.segments.length}:${songIdentityKey(song)}`,
      song,
      start,
      end: Number.POSITIVE_INFINITY,
      complete: false,
    };
    this.segments.push(segment);

    let bytes = 0;
    let chunkIndex = 0;
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
    await this.waitForAppendWindow();
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
      // 已播放区间，再等前向缓冲降到 30 秒后仅重试一次；仍失败则把错误交给
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
    this.audio.currentTime = segment.start + progress.cur;
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
    });
    this.onError(error, song);
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
