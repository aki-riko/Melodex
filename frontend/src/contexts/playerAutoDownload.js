import {
  serverDownloadRecordExtension,
  serverDownloadRecordSizeBytes,
} from '../utils/serverDownloads.js';

// 「播放时自动下载到服务器」偏好。默认开启(缺省即 true),用户可在设置关闭。
// PlayerContext 在每次歌曲开始播放时实时读取此开关,Settings 页读写它。
const AUTO_DOWNLOAD_ON_PLAY_KEY = 'melodex_auto_download_on_play';
const LOCAL_SOURCES = new Set(['local', 'local-file', 'local_music']);

// 磁盘上这些扩展名是有损格式。源声明无损(has_lossless=1)而磁盘是有损时必须升级。
const LOSSY_AUDIO_EXTENSIONS = new Set([
  'mp3', 'ogg', 'oga', 'aac', 'm4a', 'wma', 'opus', 'mp4', 'm4b', 'aiff', 'aif',
]);
// 磁盘上这些是无损格式,不需要再为「音质」重复下载。
const LOSSLESS_AUDIO_EXTENSIONS = new Set([
  'flac', 'wav', 'alac', 'ape', 'wv', 'tta', 'dsf', 'dff',
]);

// 估算码率(字节数 ÷ 时长)明显低于在线码率多少倍才算「磁盘更差」。
// 取 0.7 而非 1.0:搜索结果的 bitrate 常是预览值且有抖动,只有差距足够大
// (如 128k vs 320k、128k vs 无损)才值得重下,避免同一首歌反复重写文件。
export const SERVER_COPY_UPGRADE_BITRATE_RATIO = 0.7;

// 估算需要可靠时长/体积,过短的文件(前奏试听、错误样本)不参与比较。
const MIN_ESTIMATE_DURATION_SECONDS = 30;

export const loadAutoDownloadOnPlay = (storage = globalThis.localStorage) => {
  try {
    return storage?.getItem(AUTO_DOWNLOAD_ON_PLAY_KEY) !== '0';
  } catch {
    return true;
  }
};

export const saveAutoDownloadOnPlay = (enabled, storage = globalThis.localStorage) => {
  try {
    storage?.setItem(AUTO_DOWNLOAD_ON_PLAY_KEY, enabled ? '1' : '0');
  } catch {
    // 浏览器禁止本地存储时,本次会话内状态仍可用。
  }
};

const songNumber = (song, key) => {
  const value = Number(song?.[key] ?? song?.[`${key[0].toUpperCase()}${key.slice(1)}`]);
  return Number.isFinite(value) && value > 0 ? value : 0;
};

const songExtraText = (song, key) => {
  let extra = song?.extra ?? song?.Extra;
  if (typeof extra === 'string') {
    const raw = extra.trim();
    try {
      extra = raw && raw !== '{}' && raw !== 'null' ? JSON.parse(raw) : null;
    } catch {
      extra = null;
    }
  }
  const value = extra && typeof extra === 'object' && !Array.isArray(extra) ? extra[key] : undefined;
  return String(value ?? song?.[key] ?? '').trim();
};

// 由「文件字节数 ÷ 时长」估算磁盘副本码率(kbps)。无法可靠估算时返回 0(= 没有证据)。
export const estimateServerCopyBitrate = (record, duration) => {
  const size = serverDownloadRecordSizeBytes(record);
  const seconds = Number(duration);
  if (size <= 0 || !Number.isFinite(seconds) || seconds < MIN_ESTIMATE_DURATION_SECONDS) return 0;
  return Math.round((size * 8) / seconds / 1000);
};

// 服务器副本是否需要为音质重下。保守原则:只在有**正面证据**证明磁盘更差时返回 true。
//   - 无 record → false(没下载过不属于升级)
//   - 本地源 → false(本地文件不经这套下载链路)
//   - 磁盘有损 + 源声明 has_lossless='1' → true
//   - 磁盘已是无损 → false(无损之间不比体积)
//   - 仅有可比较码率证据且估算码率明显偏低(< 在线码率 0.7 倍) → true
//   - 其余 → false(绝不在每次播放时无谓重下)
export const serverCopyNeedsUpgrade = (song, record) => {
  if (!song || !record || typeof record !== 'object' || Array.isArray(record)) return false;
  const source = String(song?.source ?? song?.Source ?? '').trim();
  if (LOCAL_SOURCES.has(source)) return false;

  const extension = serverDownloadRecordExtension(record);
  const losslessDeclared = songExtraText(song, 'has_lossless') === '1';

  if (LOSSLESS_AUDIO_EXTENSIONS.has(extension)) return false;
  if (losslessDeclared && LOSSY_AUDIO_EXTENSIONS.has(extension)) return true;
  // 扩展名未知(旧记录/无后缀)时不能断言磁盘是有损,只能等码率证据。
  if (extension && !LOSSY_AUDIO_EXTENSIONS.has(extension)) return false;

  const onlineBitrate = songNumber(song, 'bitrate');
  if (onlineBitrate <= 0) return false;
  const estimatedBitrate = estimateServerCopyBitrate(record, song?.duration ?? song?.Duration);
  if (estimatedBitrate <= 0) return false;
  return estimatedBitrate < onlineBitrate * SERVER_COPY_UPGRADE_BITRATE_RATIO;
};

// downloadedCopy 是 ServerDownloadsContext 提供的「歌曲 → 匹配到的下载记录」查询函数。
// 兼容旧的布尔查询函数 isDownloaded:返回 true/false 时取不到记录,按「已下载但无升级证据」
// 处理(= 维持旧行为,绝不因缺证据重下)。
const resolveDownloadedCopy = (song, downloadedCopy) => {
  if (typeof downloadedCopy !== 'function') return { downloaded: false, copy: null };
  const value = downloadedCopy(song);
  if (!value) return { downloaded: false, copy: null };
  if (typeof value === 'object' && !Array.isArray(value)) return { downloaded: true, copy: value };
  return { downloaded: true, copy: null };
};

// 播放时自动下载的完整决策,供调用点使用(单一真相,避免 shouldAutoDownloadOnPlay 与
// 「这是不是升级」两处各算一遍而漂移)。返回:
//   download: 是否应调用 saveToServer
//   upgrade:  true = 服务器已有副本、本次是音质升级(失败后必须放弃本次会话,见下)
export const autoDownloadOnPlayPlan = (song, downloadedCopy, storage = globalThis.localStorage) => {
  const source = String(song?.source ?? song?.Source ?? '').trim();
  if (!song || LOCAL_SOURCES.has(source) || !loadAutoDownloadOnPlay(storage)) {
    return { download: false, upgrade: false };
  }
  const { downloaded, copy } = resolveDownloadedCopy(song, downloadedCopy);
  if (!downloaded) return { download: true, upgrade: false };
  const upgrade = serverCopyNeedsUpgrade(song, copy);
  return { download: upgrade, upgrade };
};

// 播放时是否应自动下载到服务器:
//   - 未下载 → true(保持原语义:播放即入库)
//   - 已下载 → 仅当 serverCopyNeedsUpgrade 证明磁盘更差时才 true(音质升级)
// 仍受 melodex_auto_download_on_play 开关与本地源限制。
export const shouldAutoDownloadOnPlay = (song, downloadedCopy, storage = globalThis.localStorage) => (
  autoDownloadOnPlayPlan(song, downloadedCopy, storage).download
);

// 自动下载失败后是否还允许下次播放重试。
// 音质升级失败必须放弃本次会话(否则每次播放都会重写同一份文件);
// 首次下载失败保留原有重试语义(可能只是临时网络错误)。
export const autoDownloadFailureIsRetryable = (isUpgrade) => !isUpgrade;

// 自动下载失败后更新去重集合(attemptedRef 风格的 Set)。
// 返回是否已放弃本次会话的重试。升级失败保留 key = 本会话不再重试。
export const retainAutoDownloadAttempt = (attempted, key, isUpgrade) => {
  if (!attempted) return true;
  if (autoDownloadFailureIsRetryable(isUpgrade)) {
    attempted.delete(key);
    return false;
  }
  attempted.add(key);
  return true;
};
