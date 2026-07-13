const normalizedText = (value) => String(value || '').trim().replace(/\s+/g, ' ').toLocaleLowerCase();

export const serverDownloadStatusKey = (source, songId) => {
  const normalizedSource = String(source || '').trim();
  const normalizedID = String(songId || '').trim();
  return normalizedSource && normalizedID ? `${normalizedSource}\u0000${normalizedID}` : '';
};

export const serverDownloadTitleArtistKey = (name, artist) => {
  const normalizedName = normalizedText(name);
  const normalizedArtist = normalizedText(artist);
  return normalizedName && normalizedArtist ? `${normalizedName}\u0000${normalizedArtist}` : '';
};

export const serverDownloadEventBelongsToUser = (detail, userId) => {
  const expected = String(userId || '');
  return !!expected && String(detail?.userId || '') === expected;
};

export const serverSaveSucceeded = (result) => result?.saved === true && result?.recorded === true;

const songSource = (song) => song?.source ?? song?.Source;
const songID = (song) => song?.id ?? song?.ID;
const LOCAL_SOURCES = new Set(['local', 'local-file', 'local_music']);

export const serverDownloadSongKey = (song) => serverDownloadStatusKey(songSource(song), songID(song));

export const serverDownloadMatchesKnownKeys = (song, exactKeys, titleArtistKeys) => {
  if (LOCAL_SOURCES.has(String(songSource(song) || '').trim())) return true;
  const exactKey = serverDownloadSongKey(song);
  if (exactKey) return exactKeys?.has(exactKey) === true;
  const fallbackKey = serverDownloadTitleArtistKey(song?.name ?? song?.Name, song?.artist ?? song?.Artist);
  return !!fallbackKey && titleArtistKeys?.has(fallbackKey) === true;
};

const existingDownloadKeys = (downloads) => new Set(
  (Array.isArray(downloads) ? downloads : [])
    .map((item) => serverDownloadStatusKey(item?.source, item?.song_id))
    .filter(Boolean),
);

const classifyBatchSong = (song, existingKeys, seenKeys) => {
  if (LOCAL_SOURCES.has(String(songSource(song) || '').trim())) return 'already';
  const key = serverDownloadSongKey(song);
  if (!key) return 'invalid';
  if (existingKeys.has(key)) return 'already';
  // 只按精确来源身份去重，避免漏掉 Live、重制版等同名录音。
  if (seenKeys.has(key)) return 'duplicates';
  seenKeys.add(key);
  return 'pending';
};

export const planServerDownloadBatch = (songs, downloads) => {
  const list = Array.isArray(songs) ? songs : [];
  const counts = { already: 0, duplicates: 0, invalid: 0 };
  const pending = [];
  const existingKeys = existingDownloadKeys(downloads);
  const seenKeys = new Set();

  for (const song of list) {
    const classification = classifyBatchSong(song, existingKeys, seenKeys);
    if (classification === 'pending') pending.push(song);
    else counts[classification] += 1;
  }

  return {
    pending,
    total: list.length,
    skipped: counts.already + counts.duplicates,
    ...counts,
  };
};
