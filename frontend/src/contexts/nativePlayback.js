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
  return {
    index,
    song: list[index] || null,
    progress: {
      cur: Math.max(0, Number(state?.positionMs) || 0) / 1000,
      dur: Math.max(0, Number(state?.durationMs) || 0) / 1000,
    },
    isPaused: !Boolean(state?.isPlaying),
    isPlaying: Boolean(state?.isPlaying),
    playWhenReady: Boolean(state?.playWhenReady),
    playbackState: Number(state?.playbackState) || 0,
    mediaItemCount: Math.max(0, Number(state?.mediaItemCount) || 0),
  };
};
