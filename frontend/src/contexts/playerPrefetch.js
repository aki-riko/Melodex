import { songIdentityKey } from '../utils/songIdentity.js';

export const createPreparedAudio = ({
  currentSong,
  nextSong,
  mode = '',
  blob,
  mime = '',
  coverBlob = null,
  coverMime = '',
}) => {
  if (!currentSong || !nextSong || !blob) return null;

  return {
    currentKey: songIdentityKey(currentSong),
    nextKey: songIdentityKey(nextSong),
    mode,
    song: nextSong,
    blob,
    mime: mime || blob.type || 'application/octet-stream',
    coverBlob,
    coverMime,
  };
};

export const preparedAudioForTransition = (prepared, currentSong, nextSong, mode = '') => {
  if (!prepared?.blob || !currentSong || !nextSong) return null;
  if (prepared.currentKey !== songIdentityKey(currentSong)) return null;
  if (prepared.nextKey !== songIdentityKey(nextSong)) return null;
  if (prepared.mode !== mode) return null;
  return {
    blob: prepared.blob,
    mime: prepared.mime || prepared.blob.type || '',
    coverBlob: prepared.coverBlob || null,
    coverMime: prepared.coverMime || '',
  };
};
