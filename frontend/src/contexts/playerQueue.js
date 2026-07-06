import { songIdentityKey } from '../utils/songIdentity.js';

export const MODES = ['order', 'loop', 'repeat', 'shuffle'];

export const pickNextSong = ({
  list,
  current,
  mode = 'loop',
  forward = true,
  auto = false,
  random = Math.random,
}) => {
  const songs = Array.isArray(list) ? list : [];
  if (!songs.length) return null;

  const curKey = songIdentityKey(current);
  const idx = songs.findIndex((song) => songIdentityKey(song) === curKey);
  if (mode === 'shuffle' && songs.length > 1) {
    let nextIdx = idx;
    while (nextIdx === idx) nextIdx = Math.floor(random() * songs.length);
    return songs[nextIdx];
  }

  const step = forward ? 1 : -1;
  const rawNext = idx + step;
  if (auto && mode === 'order' && rawNext >= songs.length) return null;
  return songs[(rawNext + songs.length) % songs.length];
};

export const isCurrentAudioEvent = (audio, currentSeq, currentSong) => {
  const dataset = audio?.dataset || {};
  if (!currentSong || !dataset.playSeq || !dataset.songKey) return false;
  return dataset.playSeq === String(currentSeq)
    && dataset.songKey === songIdentityKey(currentSong);
};
