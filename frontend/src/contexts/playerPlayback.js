export const shouldPreferPlaybackCache = ({
  offline = false,
  visibilityState = globalThis.document?.visibilityState || 'visible',
} = {}) => Boolean(offline) || visibilityState === 'visible';

// 后台 React 渲染可能晚于音频事件；播放控制必须以同步 ref 为权威，
// state 只作为首次恢复等极短窗口的兜底。
export const resolveCurrentPlaybackSong = (refSong, stateSong = null) => refSong || stateSong || null;

// 连续播放必须直接在同一个媒体元素上替换源，不能先 removeAttribute('src')
// 再 load 空源；后者会让 Chromium 移除当前播放器并短暂释放 MediaSession。
export const replaceAudioSource = (audio, {
  src,
  playSeq,
  songKey,
  sourceKind,
  objectUrl = '',
  revokeObjectURL = globalThis.URL?.revokeObjectURL?.bind(globalThis.URL),
} = {}) => {
  if (!audio || !src) return false;
  const previousObjectUrl = audio.dataset?.objectUrl || '';
  if (audio.dataset) {
    delete audio.dataset.objectUrl;
    audio.dataset.playSeq = String(playSeq);
    audio.dataset.songKey = songKey;
    audio.dataset.sourceKind = sourceKind;
  }
  audio.src = src;
  if (objectUrl && audio.dataset) audio.dataset.objectUrl = objectUrl;
  audio.load();
  if (previousObjectUrl && previousObjectUrl !== objectUrl) revokeObjectURL?.(previousObjectUrl);
  return true;
};

export const lastBufferedEnd = (audio) => {
  const ranges = audio?.buffered;
  const count = Number(ranges?.length || 0);
  if (!count) return 0;
  try {
    return Number(ranges.end(count - 1) || 0);
  } catch {
    return 0;
  }
};

const finitePlaybackNumber = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
};

export const buildPlaybackDiagnostic = ({
  event,
  audio,
  song,
  nextSong = null,
  reason = '',
  mode = '',
  queueLength = 0,
  visibilityState = globalThis.document?.visibilityState || 'unknown',
  pageID = '',
  bundle = '',
  activeAudio = null,
  standbyAudio = null,
  mediaSessionState = globalThis.navigator?.mediaSession?.playbackState || '',
  wasDiscarded = Boolean(globalThis.document?.wasDiscarded),
  userActivation = globalThis.navigator?.userActivation,
  pageElapsedMs = globalThis.performance?.now?.(),
  deviceInfo = '',
}) => ({
  event,
  source: song?.source || '',
  song_id: song?.id || '',
  next_source: nextSong?.source || '',
  next_song_id: nextSong?.id || '',
  play_seq: audio?.dataset?.playSeq || '',
  source_kind: audio?.dataset?.sourceKind || '',
  visibility: visibilityState,
  reason: String(reason || '').slice(0, 160),
  mode,
  queue_length: queueLength,
  current_time: finitePlaybackNumber(audio?.currentTime),
  duration: finitePlaybackNumber(audio?.duration),
  buffered_end: finitePlaybackNumber(lastBufferedEnd(audio)),
  paused: Boolean(audio?.paused),
  ended: Boolean(audio?.ended),
  ready_state: Number(audio?.readyState || 0),
  network_state: Number(audio?.networkState || 0),
  page_id: pageID,
  bundle,
  audio_slot: audio?.dataset?.audioSlot || '',
  active_audio_slot: activeAudio?.dataset?.audioSlot || '',
  standby_audio_slot: standbyAudio?.dataset?.audioSlot || '',
  media_session_state: mediaSessionState,
  was_discarded: wasDiscarded,
  user_activation_supported: Boolean(userActivation),
  user_activation_active: Boolean(userActivation?.isActive),
  user_activation_has_been_active: Boolean(userActivation?.hasBeenActive),
  page_elapsed_ms: finitePlaybackNumber(pageElapsedMs),
  device_info: String(deviceInfo || '').slice(0, 160),
});

// 锁屏/后台切歌必须在 ended 或 MediaSession 回调的同一调用栈里启动。
// 在线后台跳过 IndexedDB 查询，避免当前音轨结束后异步任务被系统冻结，
// 导致下一首没有及时设置 src、媒体会话被回收。
export const beginPlaybackTransition = ({
  song,
  seq,
  offline = false,
  visibilityState,
  preparedAudio = null,
  selectSong,
  loadAudio,
}) => {
  selectSong(song);
  return loadAudio(song, {
    autoplay: true,
    seq,
    preferCache: shouldPreferPlaybackCache({ offline, visibilityState }),
    preparedAudio,
  });
};
