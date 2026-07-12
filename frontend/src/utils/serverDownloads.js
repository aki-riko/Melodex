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
