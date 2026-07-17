import { coverProxyUrl, getDownloadUrl } from './musicdl';
import { normalizeSongIdentity, songExtraHash, songIdentityKey } from '../utils/songIdentity';
import { normalizeSong } from '../utils/songFields';
import { audioBlobLooksPlayable } from '../utils/audioProbe';

const DB_NAME = 'melodex-offline-audio';
const DB_VERSION = 1;
const TRACK_STORE = 'tracks';

export const OFFLINE_AUDIO_CHANGED = 'melodex:offline-audio-changed';

const nowISO = () => new Date().toISOString();
const userKey = (userId) => String(userId || 0);
const textValue = (value) => (value == null ? '' : String(value));

export const normalizeOfflineSong = (song) => {
  const normalized = normalizeSong(song);
  const identity = normalizeSongIdentity(normalized);
  return {
    id: identity.id,
    source: identity.source,
    name: textValue(normalized.name),
    artist: textValue(normalized.artist),
    album: textValue(normalized.album),
    cover: textValue(normalized.cover),
    duration: Number(normalized.duration || 0) || 0,
    extra: identity.extra,
  };
};

export const canCacheSong = (song) => {
  const s = normalizeOfflineSong(song);
  return !!s.id && !!s.source && s.source !== 'local';
};

export const offlineExtraHash = songExtraHash;

export const offlineSongKey = (song, userId) => `${userKey(userId)}:${songIdentityKey(song)}`;

const emitChanged = (detail) => {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(OFFLINE_AUDIO_CHANGED, { detail }));
};

const openDB = () => new Promise((resolve, reject) => {
  if (typeof indexedDB === 'undefined') {
    reject(new Error('当前浏览器不支持 IndexedDB'));
    return;
  }
  const req = indexedDB.open(DB_NAME, DB_VERSION);
  req.onupgradeneeded = () => {
    const db = req.result;
    if (!db.objectStoreNames.contains(TRACK_STORE)) {
      const store = db.createObjectStore(TRACK_STORE, { keyPath: 'key' });
      store.createIndex('userId', 'userId', { unique: false });
      store.createIndex('cachedAt', 'cachedAt', { unique: false });
    }
  };
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error || new Error('打开离线缓存失败'));
});

const requestResult = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error || new Error('IndexedDB 操作失败'));
});

const txDone = (tx) => new Promise((resolve, reject) => {
  tx.oncomplete = () => resolve();
  tx.onerror = () => reject(tx.error || new Error('IndexedDB 事务失败'));
  tx.onabort = () => reject(tx.error || new Error('IndexedDB 事务中止'));
});

const withStore = async (mode, fn) => {
  const db = await openDB();
  try {
    const tx = db.transaction(TRACK_STORE, mode);
    const done = txDone(tx);
    const result = await fn(tx.objectStore(TRACK_STORE));
    await done;
    return result;
  } finally {
    db.close();
  }
};

const getRecordByKey = (key) => withStore('readonly', (store) => requestResult(store.get(key)));

const putRecord = (record) => withStore('readwrite', (store) => {
  store.put(record);
  return record;
});

const deleteRecordByKey = (key) => withStore('readwrite', (store) => {
  store.delete(key);
  return true;
});

const filenameFromDisposition = (value) => {
  if (!value) return '';
  const utf8 = value.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8?.[1]) {
    try { return decodeURIComponent(utf8[1].replace(/"/g, '')); } catch { return utf8[1].replace(/"/g, ''); }
  }
  const ascii = value.match(/filename="?([^";]+)"?/i);
  return ascii?.[1] || '';
};

const extFromMime = (mime) => {
  if (mime.includes('flac')) return 'flac';
  if (mime.includes('ogg')) return 'ogg';
  if (mime.includes('wav')) return 'wav';
  if (mime.includes('aac')) return 'aac';
  if (mime.includes('mp4') || mime.includes('m4a')) return 'm4a';
  return 'mp3';
};

const responseToBlob = async (response, mime, onProgress) => {
  const total = Number(response.headers.get('content-length') || 0) || 0;
  if (!response.body || !response.body.getReader) {
    const blob = await response.blob();
    onProgress?.({ phase: 'caching', received: blob.size, total, percent: total ? 100 : null });
    return blob;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    chunks.push(value);
    received += value.byteLength;
    onProgress?.({
      phase: 'caching',
      received,
      total,
      percent: total ? Math.min(100, Math.round((received / total) * 100)) : null,
    });
  }
  return new Blob(chunks, { type: mime || 'application/octet-stream' });
};

const fetchCoverBlob = async (song, signal) => {
  const url = coverProxyUrl(song);
  if (!url) return null;
  try {
    const response = await fetch(url, { credentials: 'include', signal });
    if (!response.ok) return null;
    const mime = response.headers.get('content-type') || '';
    const blob = await response.blob();
    const blobMime = blob.type || mime;
    if (!blob.size || blob.size > 8 * 1024 * 1024) return null;
    if (blobMime && !blobMime.toLowerCase().startsWith('image/')) return null;
    return { blob, mime: blobMime || 'image/jpeg' };
  } catch {
    return null;
  }
};

export const cacheSong = async (song, { userId = 0, onProgress, signal } = {}) => {
  if (!canCacheSong(song)) throw new Error('这首歌缺少来源或 ID,无法缓存到本机');

  const normalized = normalizeOfflineSong(song);
  const key = offlineSongKey(song, userId);
  const existing = await getRecordByKey(key);
  if (existing?.blob) {
    let record = existing;
    if (!existing.coverBlob && normalized.cover) {
      try {
        const cover = await fetchCoverBlob(song, signal);
        if (cover?.blob) {
          record = { ...existing, coverBlob: cover.blob, coverMime: cover.mime || '' };
          await putRecord(record);
          emitChanged({ action: 'cache', key, userId: record.userId });
        }
      } catch (err) {
        console.warn('补齐离线封面失败', err);
      }
    }
    onProgress?.({ phase: 'done', received: record.size || record.blob.size || 0, total: record.size || record.blob.size || 0, percent: 100 });
    return record;
  }

  onProgress?.({ phase: 'preparing', received: 0, total: 0, percent: null });
  const response = await fetch(getDownloadUrl(song), {
    credentials: 'include',
    signal,
  });
  if (!response.ok) {
    throw new Error(`缓存失败:HTTP ${response.status}`);
  }

  const mime = response.headers.get('content-type') || 'application/octet-stream';
  const blob = await responseToBlob(response, mime, onProgress);
  if (!blob.size) throw new Error('缓存失败:音频为空');
  if (!(await audioBlobLooksPlayable(blob, mime))) {
    throw new Error('缓存失败:响应不是可播放的音频');
  }
  const cover = await fetchCoverBlob(song, signal);

  const record = {
    key,
    userId: userKey(userId),
    source: normalized.source,
    id: normalized.id,
    extraHash: offlineExtraHash(song),
    name: normalized.name,
    artist: normalized.artist,
    album: normalized.album,
    cover: normalized.cover,
    duration: normalized.duration,
    extra: normalized.extra,
    size: blob.size,
    mime: blob.type || mime,
    filename: filenameFromDisposition(response.headers.get('content-disposition')) || `${normalized.name || normalized.id}.${extFromMime(mime)}`,
    cachedAt: nowISO(),
    lastPlayedAt: null,
    blob,
    coverBlob: cover?.blob || null,
    coverMime: cover?.mime || '',
  };

  await putRecord(record);
  onProgress?.({ phase: 'done', received: blob.size, total: blob.size, percent: 100 });
  emitChanged({ action: 'cache', key, userId: record.userId });
  return record;
};

export const getCachedSong = (song, userId = 0) => {
  if (!canCacheSong(song)) return Promise.resolve(null);
  return getRecordByKey(offlineSongKey(song, userId));
};

export const getPlayableCachedSong = async (song, userId = 0, { deleteInvalid = true } = {}) => {
  const record = await getCachedSong(song, userId);
  if (!record?.blob) return null;
  if (await audioBlobLooksPlayable(record.blob, record.mime || record.blob.type || '')) {
    return record;
  }
  if (deleteInvalid) {
    await deleteRecordByKey(record.key);
    emitChanged({ action: 'delete', key: record.key, userId: userKey(userId), reason: 'invalid-audio' });
  }
  return null;
};

export const isSongCached = async (song, userId = 0) => {
  const record = await getCachedSong(song, userId);
  return !!record?.blob;
};

export const listCachedSongs = async (userId = 0) => {
  const uid = userKey(userId);
  const rows = await withStore('readonly', (store) => requestResult(store.index('userId').getAll(uid)));
  return (rows || []).sort((a, b) => String(b.cachedAt || '').localeCompare(String(a.cachedAt || '')));
};

export const deleteCachedSong = async (song, userId = 0) => {
  if (!canCacheSong(song)) return false;
  const key = offlineSongKey(song, userId);
  await deleteRecordByKey(key);
  emitChanged({ action: 'delete', key, userId: userKey(userId) });
  return true;
};

export const deleteCachedRecord = async (key, userId = 0) => {
  const record = await getRecordByKey(key);
  if (!record || record.userId !== userKey(userId)) return false;
  await deleteRecordByKey(key);
  emitChanged({ action: 'delete', key, userId: userKey(userId) });
  return true;
};

export const deleteAllCachedSongs = async (userId = 0) => {
  const rows = await listCachedSongs(userId);
  await Promise.all(rows.map((row) => deleteRecordByKey(row.key)));
  emitChanged({ action: 'clear', userId: userKey(userId) });
  return rows.length;
};

export const touchCachedSong = async (song, userId = 0) => {
  const record = await getCachedSong(song, userId);
  if (!record) return null;
  const next = { ...record, lastPlayedAt: nowISO() };
  await putRecord(next);
  emitChanged({ action: 'touch', key: next.key, userId: next.userId });
  return next;
};

export const getStorageEstimate = async () => {
  const storage = typeof navigator !== 'undefined' ? navigator.storage : null;
  const estimate = storage?.estimate ? await storage.estimate() : {};
  const persisted = storage?.persisted ? await storage.persisted() : false;
  return {
    usage: estimate.usage || 0,
    quota: estimate.quota || 0,
    persisted: !!persisted,
  };
};

export const requestPersistentStorage = async () => {
  const storage = typeof navigator !== 'undefined' ? navigator.storage : null;
  if (!storage?.persist) return false;
  return !!(await storage.persist());
};
