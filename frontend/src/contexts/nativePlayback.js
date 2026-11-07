import { Capacitor, registerPlugin } from '@capacitor/core';
import { normalizeSong } from '../utils/songFields.js';
import { songIdentityKey } from '../utils/songIdentity.js';

export const NativePlayback = registerPlugin('NativePlayback');

export const isNativeAndroidPlayback = (capacitor = Capacitor) =>
  Boolean(capacitor?.isNativePlatform?.()) && capacitor?.getPlatform?.() === 'android';

export const absolutePlaybackUrl = (value, origin = globalThis.location?.origin) => {
  if (!value) return '';
  if (!origin) throw new Error('无法确定播放地址的站点来源');
  return new URL(value, origin).href;
};

export const buildNativeQueue = (songs, {
  origin = globalThis.location?.origin,
  streamUrl,
  coverUrl,
} = {}) => {
  if (typeof streamUrl !== 'function') throw new Error('缺少原生播放地址生成器');
  return (Array.isArray(songs) ? songs : []).map((rawSong) => {
    const song = normalizeSong(rawSong);
    return {
      id: songIdentityKey(song),
      url: absolutePlaybackUrl(streamUrl(song), origin),
      title: song.name || '',
      artist: song.artist || '',
      album: song.album || '',
      coverUrl: absolutePlaybackUrl(coverUrl?.(song) || '', origin),
      durationMs: Math.max(0, Number(song.duration) || 0) * 1000,
    };
  });
};

export const nativePlaybackSnapshot = (state, queue) => {
  const list = Array.isArray(queue) ? queue : [];
  const index = Math.max(0, Math.min(Number(state?.currentIndex) || 0, Math.max(0, list.length - 1)));
  const song = list[index] || null;
  const reportedDuration = Math.max(0, Number(state?.durationMs) || 0) / 1000;
  // 注意:queue 里是歌曲模型,duration 单位是**秒**(不是 durationMs)。
  const songDuration = Math.max(0, Number(song?.duration) || 0);
  return {
    index,
    song,
    progress: {
      cur: Math.max(0, Number(state?.positionMs) || 0) / 1000,
      dur: resolvePlaybackDuration(reportedDuration, songDuration),
    },
    isPaused: !Boolean(state?.isPlaying),
    isPlaying: Boolean(state?.isPlaying),
    playWhenReady: Boolean(state?.playWhenReady),
    playbackState: Number(state?.playbackState) || 0,
    mediaItemCount: Math.max(0, Number(state?.mediaItemCount) || 0),
  };
};

// 决定进度条该用多少秒做 max —— 这个值直接决定拖动位置能不能换算对。
//
// 2026-11 修「手机拖到 2 分钟,ExoPlayer 却只请求了 2% 处的字节」:
// 旧逻辑是 `reportedDuration > 0 ? reportedDuration : songDuration`,只要原生
// 报了个正数就无条件采信。但 ExoPlayer 对流式源(FLAC/HTTP)在 prepare 早期
// 会报一个远小于真实值的 duration(只算已解析部分),于是 max 被压得很小,
// 用户拖到条的 45% 实际只算出几秒 —— seek 位置于是差了二十倍。
//
// 判据:歌曲元数据里的时长(来自服务端,可信)与原生值相差在 10% 以内才采信
// 原生值;否则一律用元数据。元数据缺失(<=0)时才退回原生值。
// 这样既保留了"原生实测时长更准"的能力(刮削不准时能被纠正),又不会让
// 一个明显错误的小值劫持整条时间轴。
export const DURATION_TRUST_RATIO = 0.1;

export const resolvePlaybackDuration = (reportedSeconds, songSeconds) => {
  const reported = Number(reportedSeconds);
  const song = Number(songSeconds);
  const hasReported = Number.isFinite(reported) && reported > 0;
  const hasSong = Number.isFinite(song) && song > 0;
  if (!hasSong) return hasReported ? reported : 0;
  if (!hasReported) return song;
  const diff = Math.abs(reported - song);
  return diff <= song * DURATION_TRUST_RATIO ? reported : song;
};
