import { getServerDownloads, saveToServer, serverSaveSucceeded } from './musicdl';
import {
  runServerDownloadBatchCore,
  SERVER_DOWNLOAD_BULK_IDLE,
  serverDownloadBatchProcessed,
  serverDownloadBatchSummary,
  shouldAbortServerDownloadBatch,
} from '../utils/serverDownloadBatch';

export { SERVER_DOWNLOAD_BULK_IDLE, serverDownloadBatchProcessed, serverDownloadBatchSummary };

// 批量开始前强制读取当前账号的服务器下载真相，再仅下载精确未命中的歌曲。
export const runServerDownloadBatch = (songs, options = {}) => {
  const expectedUserId = Number(options.expectedUserId || 0);
  return runServerDownloadBatchCore(songs, {
    ...options,
    loadDownloads: options.loadDownloads || getServerDownloads,
    saveSong: options.saveSong || ((song) => saveToServer(song, { expectedUserId })),
    saveSucceeded: options.saveSucceeded || serverSaveSucceeded,
    abortOnError: options.abortOnError || shouldAbortServerDownloadBatch,
  });
};
