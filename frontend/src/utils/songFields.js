import { normalizeSongIdentity } from './songIdentity';

const textValue = (value) => (value == null ? '' : String(value));

const numberValue = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

const objectExtra = (extra) => {
  if (!extra || typeof extra !== 'object' || Array.isArray(extra)) return null;
  return extra;
};

const extraValue = (extra, key) => {
  const obj = objectExtra(extra);
  return obj ? textValue(obj[key]).trim() : '';
};

export const normalizeSong = (song = {}) => {
  const input = song || {};
  const identity = normalizeSongIdentity(input);
  const extra = identity.extra;
  const album = textValue(input.album ?? input.Album ?? extraValue(extra, 'album')).trim();
  const albumId = textValue(input.album_id ?? input.AlbumID ?? extraValue(extra, 'album_id')).trim();

  return {
    ...input,
    id: identity.id,
    source: identity.source,
    name: textValue(input.name ?? input.Name).trim(),
    artist: textValue(input.artist ?? input.Artist).trim(),
    album,
    album_id: albumId,
    cover: textValue(input.cover ?? input.Cover).trim(),
    duration: numberValue(input.duration ?? input.Duration),
    ext: textValue(input.ext ?? input.Ext).trim(),
    size: numberValue(input.size ?? input.Size),
    bitrate: numberValue(input.bitrate ?? input.Bitrate),
    is_vip: Boolean(input.is_vip ?? input.IsVIP),
    extra: extra ?? null,
  };
};

export const normalizeSongs = (songs) => (Array.isArray(songs) ? songs.map(normalizeSong) : []);

export const songExtraWithStandardFields = (song) => {
  const normalized = normalizeSong(song);
  const extra = objectExtra(normalized.extra) ? { ...normalized.extra } : {};
  if (normalized.album && !textValue(extra.album).trim()) extra.album = normalized.album;
  if (normalized.album_id && !textValue(extra.album_id).trim()) extra.album_id = normalized.album_id;
  return Object.keys(extra).length ? extra : null;
};

export const songWritePayload = (song) => {
  const normalized = normalizeSong(song);
  return {
    id: normalized.id,
    source: normalized.source,
    name: normalized.name,
    artist: normalized.artist,
    album: normalized.album,
    album_id: normalized.album_id,
    cover: normalized.cover,
    duration: normalized.duration,
    extra: songExtraWithStandardFields(normalized),
  };
};
