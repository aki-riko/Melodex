import { songIdentityKey } from '../utils/songIdentity.js';

export const createPreparedAudio = ({
  currentSong,
  nextSong,
  mode = '',
  audio,
  sourceKind = '',
  objectUrl = '',
  coverBlob = null,
  coverMime = '',
}) => {
  if (!currentSong || !nextSong || !audio) return null;

  return {
    currentKey: songIdentityKey(currentSong),
    nextKey: songIdentityKey(nextSong),
    mode,
    song: nextSong,
    audio,
    sourceKind,
    objectUrl,
    coverBlob,
    coverMime,
  };
};

export const preparedAudioForTransition = (prepared, currentSong, nextSong, mode = '') => {
  if (!prepared?.audio || !currentSong || !nextSong) return null;
  if (prepared.currentKey !== songIdentityKey(currentSong)) return null;
  if (prepared.nextKey !== songIdentityKey(nextSong)) return null;
  if (prepared.mode !== mode) return null;
  return {
    audio: prepared.audio,
    sourceKind: prepared.sourceKind || '',
    objectUrl: prepared.objectUrl || '',
    coverBlob: prepared.coverBlob || null,
    coverMime: prepared.coverMime || '',
  };
};

// 双 audio 交接只在目标元素真正开始播放或自动播放明确失败时执行。
// 失败时也要把控制权交给已装载新歌曲的元素，否则旧歌可能继续出声，
// 而播放/暂停按钮却已经对应新歌曲。
export const handoffAudioElement = (currentAudio, targetAudio) => {
  if (!targetAudio || currentAudio === targetAudio) return null;
  if (currentAudio && !currentAudio.paused) {
    try { currentAudio.pause(); } catch { /* 陈旧元素可能已被浏览器释放 */ }
  }
  return {
    activeAudio: targetAudio,
    standbyAudio: currentAudio || null,
  };
};

export const isPreparedStandbyAudio = (prepared, audio, activeAudio) => Boolean(
  prepared?.audio
  && prepared.audio === audio
  && audio !== activeAudio,
);
