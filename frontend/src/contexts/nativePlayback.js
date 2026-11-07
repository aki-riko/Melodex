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
  // ExoPlayer 在 prepare 完成前 duration 是 C.TIME_UNSET(原生侧已折成 0)。
  // 若直接把 0 当时长,界面上那条 `<input type="range" max=0>` 会把拇指永远
  // 压在最左边 —— 用户拖完看到"跳回开头",与回弹是同一个观感。所以用队列里
  // 已知的歌曲时长兜底,等原生的真实时长回来后自然接管。
  // 注意:queue 里是歌曲模型,duration 单位是**秒**(不是 durationMs)。
  const fallbackDuration = Math.max(0, Number(song?.duration) || 0);
  return {
    index,
    song,
    progress: {
      cur: Math.max(0, Number(state?.positionMs) || 0) / 1000,
      dur: reportedDuration > 0 ? reportedDuration : fallbackDuration,
    },
    isPaused: !Boolean(state?.isPlaying),
    isPlaying: Boolean(state?.isPlaying),
    playWhenReady: Boolean(state?.playWhenReady),
    playbackState: Number(state?.playbackState) || 0,
    mediaItemCount: Math.max(0, Number(state?.mediaItemCount) || 0),
  };
};
