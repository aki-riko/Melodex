import { getDownloadUrl } from './musicdl';

const DB_NAME = 'melodex-offline-audio';
const DB_VERSION = 1;
const TRACK_STORE = 'tracks';

export const OFFLINE_AUDIO_CHANGED = 'melodex:offline-audio-changed';

const nowISO = () => new Date().toISOString();
const userKey = (userId) => String(userId || 0);
const textValue = (value) => (value == null ? '' : String(value));

const stableStringify = (value) => {
  if (value == null) return '';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
};

const hashText = (text) => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
};

export const normalizeOfflineSong = (song) => {
  let extra = song?.extra ?? song?.Extra ?? null;
  if (typeof extra === 'string') {
    const raw = extra.trim();
    if (!raw || raw === '{}' || raw === 'null') {
      extra = null;
    } else {
      try { extra = JSON.parse(raw); } catch { extra = raw; }
    }
  }
  return {
    id: textValue(song?.id ?? song?.ID),
    source: textValue(song?.source ?? song?.Source),
    name: textValue(song?.name ?? song?.Name),
    artist: textValue(song?.artist ?? song?.Artist),
    album: textValue(song?.album ?? song?.Album),
    cover: textValue(song?.cover ?? song?.Cover),
    duration: Number(song?.duration ?? song?.Duration ?? 0) || 0,
    extra,
  };
};

export const canCacheSong = (song) => {
  const s = normalizeOfflineSong(song);
  return !!s.id && !!s.source && s.source !== 'local';
};

export const offlineExtraHash = (song) => hashText(stableStringify(normalizeOfflineSong(song).extra));

export const offlineSongKey = (song, userId) => {
  const s = normalizeOfflineSong(song);
  return `${userKey(userId)}:${s.source}:${s.id}:${offlineExtraHash(song)}`;
};

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

export const cacheSong = async (song, { userId = 0, onProgress, signal } = {}) => {
  if (!canCacheSong(song)) throw new Error('这首歌缺少来源或 ID,无法缓存到本机');

  const normalized = normalizeOfflineSong(song);
  const key = offlineSongKey(song, userId);
  const existing = await getRecordByKey(key);
  if (existing?.blob) {
    onProgress?.({ phase: 'done', received: existing.size || existing.blob.size || 0, total: existing.size || existing.blob.size || 0, percent: 100 });
    return existing;
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
