// 「播放时自动下载到服务器」偏好。默认开启(缺省即 true),用户可在设置关闭。
// PlayerContext 在每次歌曲开始播放时实时读取此开关,Settings 页读写它。
const AUTO_DOWNLOAD_ON_PLAY_KEY = 'melodex_auto_download_on_play';
const LOCAL_SOURCES = new Set(['local', 'local-file', 'local_music']);

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

// 服务器已有副本时禁止播放触发重复下载:否则后端可能重写正在 ServeContent 的同名文件。
// 手动下载不走这里,仍可由用户主动执行音质升级。
export const shouldAutoDownloadOnPlay = (song, isDownloaded, storage = globalThis.localStorage) => {
  const source = String(song?.source || '').trim();
  if (!song || LOCAL_SOURCES.has(source) || !loadAutoDownloadOnPlay(storage)) return false;
  return typeof isDownloaded !== 'function' || !isDownloaded(song);
};
