export const shouldPreferPlaybackCache = ({
  offline = false,
  visibilityState = globalThis.document?.visibilityState || 'visible',
} = {}) => Boolean(offline) || visibilityState === 'visible';

// 后台 React 渲染可能晚于音频事件；播放控制必须以同步 ref 为权威，
// state 只作为首次恢复等极短窗口的兜底。
export const resolveCurrentPlaybackSong = (refSong, stateSong = null) => refSong || stateSong || null;

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

export const buildPlaybackDiagnostic = ({
  event,
  audio,
  song,
  nextSong = null,
  reason = '',
  mode = '',
  queueLength = 0,
  visibilityState = globalThis.document?.visibilityState || 'unknown',
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
  current_time: Number(audio?.currentTime || 0),
  duration: Number(audio?.duration || 0),
  buffered_end: lastBufferedEnd(audio),
  paused: Boolean(audio?.paused),
  ended: Boolean(audio?.ended),
  ready_state: Number(audio?.readyState || 0),
  network_state: Number(audio?.networkState || 0),
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
