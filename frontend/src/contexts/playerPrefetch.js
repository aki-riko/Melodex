import { songIdentityKey } from '../utils/songIdentity.js';

export const prepareNextAudioBlob = async ({
  currentSong,
  nextSong,
  mode = '',
  offline = false,
  userId = 0,
  signal,
  getCachedAudio,
  fetchOnlineAudio,
}) => {
  if (!currentSong || !nextSong) return null;
  const result = offline
    ? await getCachedAudio(nextSong, userId)
    : await fetchOnlineAudio(nextSong, { signal });
  if (!result?.blob) return null;

  return {
    currentKey: songIdentityKey(currentSong),
    nextKey: songIdentityKey(nextSong),
    mode,
    song: nextSong,
    blob: result.blob,
    mime: result.mime || result.blob.type || 'application/octet-stream',
  };
};

export const preparedAudioForTransition = (prepared, currentSong, nextSong, mode = '') => {
  if (!prepared?.blob || !currentSong || !nextSong) return null;
  if (prepared.currentKey !== songIdentityKey(currentSong)) return null;
  if (prepared.nextKey !== songIdentityKey(nextSong)) return null;
  if (prepared.mode !== mode) return null;
  return { blob: prepared.blob, mime: prepared.mime || prepared.blob.type || '' };
};
