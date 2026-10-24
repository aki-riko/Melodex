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

// 扩展名归一化:后端新增的 ext 字段是小写无点的音频后缀(如 "flac"/"mp3")。
// 旧记录缺 ext 时由 rel_path 的后缀兜底,保证前端在旧后端/旧数据上也能判定音质。
export const normalizeServerDownloadExtension = (value) => {
  const text = String(value ?? '').trim().toLocaleLowerCase();
  if (!text) return '';
  const withoutDot = text.startsWith('.') ? text.slice(1) : text;
  return /^[a-z0-9]{1,8}$/.test(withoutDot) ? withoutDot : '';
};

export const serverDownloadRecordExtension = (record) => {
  const explicit = normalizeServerDownloadExtension(record?.ext ?? record?.Ext);
  if (explicit) return explicit;
  const relPath = String(record?.rel_path ?? record?.relPath ?? '').trim().replace(/\\/g, '/');
  const base = relPath.split('/').pop() || '';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? normalizeServerDownloadExtension(base.slice(dot + 1)) : '';
};

// size_bytes 是后端新增的磁盘文件字节数。缺失/非法一律按 0 处理(0 = 无证据),
// 绝不用 0 去参与码率比较,否则会把每首歌都误判成"磁盘更差"。
export const serverDownloadRecordSizeBytes = (record) => {
  const size = Number(record?.size_bytes ?? record?.sizeBytes);
  return Number.isFinite(size) && size > 0 ? size : 0;
};

// 把 /music/downloads 的列表整理成「歌曲 → 下载记录」的索引。
// 同一身份只保留第一条:后端按 created_at DESC 返回,与播放时解析服务器副本的顺序一致,
// 因此第一条就是当前实际会被播放的那份文件。
export const buildServerDownloadIndex = (downloads) => {
  const exact = new Map();
  const titleArtist = new Map();
  for (const item of Array.isArray(downloads) ? downloads : []) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const record = {
      ...item,
      ext: serverDownloadRecordExtension(item),
      size_bytes: serverDownloadRecordSizeBytes(item),
    };
    const exactKey = serverDownloadStatusKey(item.source, item.song_id);
    if (exactKey && !exact.has(exactKey)) exact.set(exactKey, record);
    const fallbackKey = serverDownloadTitleArtistKey(item.name, item.artist);
    if (fallbackKey && !titleArtist.has(fallbackKey)) titleArtist.set(fallbackKey, record);
  }
  return { exact, titleArtist };
};

// 返回匹配到的下载记录(不只是布尔),语义与 serverDownloadMatchesKnownKeys 一致:
// 有完整来源身份时只按 source+song_id 精确匹配,身份缺失才退回完整歌名+歌手。
// 未命中(含本地源)返回 null。
export const serverDownloadRecordForSong = (song, index) => {
  if (!song || !index) return null;
  if (LOCAL_SOURCES.has(String(songSource(song) || '').trim())) return null;
  const exactKey = serverDownloadSongKey(song);
  if (exactKey) return index.exact?.get(exactKey) || null;
  const fallbackKey = serverDownloadTitleArtistKey(song?.name ?? song?.Name, song?.artist ?? song?.Artist);
  return (fallbackKey && index.titleArtist?.get(fallbackKey)) || null;
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
