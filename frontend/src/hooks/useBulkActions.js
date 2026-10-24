import { useCallback } from 'react';
import {
  runServerDownloadBatch,
  SERVER_DOWNLOAD_BULK_IDLE,
} from '../services/serverDownloadBatch';
import { cacheSong, canCacheSong, isSongCached } from '../services/offlineAudio';
import { useScopedBulkState } from './useScopedBulkState';
import { useCollections } from '../contexts/CollectionsContext';
import { useFeedback } from '../contexts/FeedbackContext';
import { useAuth } from '../contexts/AuthContext';

// 批量「下载到服务器 / 缓存到本机 / 复制为我的歌单」三件套。
// 此前这套逻辑在 Download.js 与 PlaylistSongs.js 里各有一份,几乎逐行重复
// (handleDownloadAll / handleCacheAll / handleCopyToMine ×2),改一处必须记得改另一处。
// 现在只有这一份,两处页面共用。
//
// 状态用 useScopedBulkState 按「用户+内容 id」分区,关掉页面/弹窗后进度不丢。

export const IDLE_BULK_CACHE = { phase: 'idle', done: 0, fail: 0, skipped: 0, total: 0 };
export const IDLE_BULK_COPY = { phase: 'idle', done: 0, fail: 0, total: 0, collectionId: null };

export function useBulkActions({ taskKey, songs = [], scopePrefix = 'bulk' }) {
  const { user, offline } = useAuth();
  const { create, addSong } = useCollections();
  const feedback = useFeedback();
  const userId = user?.id || 0;

  const downloadTasks = useScopedBulkState(SERVER_DOWNLOAD_BULK_IDLE, `${scopePrefix}-download`);
  const cacheTasks = useScopedBulkState(IDLE_BULK_CACHE, `${scopePrefix}-cache`);
  const copyTasks = useScopedBulkState(IDLE_BULK_COPY, `${scopePrefix}-copy`);

  const bulkDownload = downloadTasks.getState(taskKey);
  const bulkCache = cacheTasks.getState(taskKey);
  const bulkCopy = copyTasks.getState(taskKey);

  const handleDownloadAll = useCallback(async () => {
    if (!songs.length || offline || bulkDownload.phase === 'running') return;
    const list = songs.slice();
    const total = list.length;
    await downloadTasks.runForKey(taskKey, {
      ...SERVER_DOWNLOAD_BULK_IDLE,
      phase: 'running',
      total,
    }, async (update) => {
      const result = await runServerDownloadBatch(list, {
        expectedUserId: userId,
        onProgress: update,
      });
      if (result.statusError) {
        // 读不到服务器已下载状态时不能盲目开下(会重复下载整张专辑)
        feedback.error('读取服务器已下载状态失败,未开始下载,请重试');
        return;
      }
      const { done = 0, fail = 0, skipped = 0 } = result;
      if (fail > 0) {
        feedback.error(`下载完成:成功 ${done} 首,失败 ${fail} 首${skipped ? `,跳过 ${skipped} 首` : ''}`);
      } else if (skipped > 0) {
        feedback.info(`已全部在服务器上,跳过 ${skipped} 首`);
      } else {
        feedback.success(`已下载 ${done} 首到服务器`);
      }
    });
  }, [songs, offline, bulkDownload.phase, downloadTasks, taskKey, userId, feedback]);

  const handleCacheAll = useCallback(async () => {
    if (!songs.length || offline || bulkCache.phase === 'running') return;
    const list = songs.slice();
    const total = list.length;
    let done = 0;
    let fail = 0;
    let skipped = 0;
    await cacheTasks.runForKey(taskKey, { phase: 'running', done, fail, skipped, total }, async (update) => {
      for (const song of list) {
        try {
          if (!canCacheSong(song) || (await isSongCached(song, userId))) {
            skipped += 1;
          } else {
            await cacheSong(song, { userId });
            done += 1;
          }
        } catch {
          fail += 1;
        }
        update({ phase: 'running', done, fail, skipped, total });
      }
      update({ phase: fail ? 'fail' : 'done', done, fail, skipped, total });
      if (fail > 0) {
        feedback.error(`缓存完成:新增 ${done} 首,失败 ${fail} 首`);
      } else if (done === 0) {
        feedback.info(`都已在本次缓存中${skipped ? `(共 ${skipped} 首)` : ''}`);
      } else {
        feedback.success(`已缓存 ${done} 首到本机`);
      }
    });
  }, [songs, offline, bulkCache.phase, cacheTasks, taskKey, userId, feedback]);

  const handleCopyToMine = useCallback(async (name) => {
    if (!songs.length || offline || bulkCopy.phase === 'running') return;
    const list = songs.slice();
    const total = list.length;
    let done = 0;
    let fail = 0;
    await copyTasks.runForKey(taskKey, { phase: 'running', done, fail, total, collectionId: null }, async (update) => {
      try {
        const collection = await create(name || '新建歌单');
        const collectionId = collection?.id;
        if (collectionId == null) throw new Error('collection id missing');
        for (const song of list) {
          try {
            await addSong(collectionId, song);
            done += 1;
          } catch {
            fail += 1;
          }
          update({ phase: 'running', done, fail, total, collectionId });
        }
        update({ phase: fail ? 'fail' : 'done', done, fail, total, collectionId });
        if (fail) feedback.warning(`已创建歌单,但 ${fail} 首加入失败`);
        else feedback.success(`已加入我的歌单(${done} 首)`);
      } catch {
        update({ phase: 'fail', done, fail: total || 1, total, collectionId: null });
        feedback.error('加入我的歌单失败,请稍后重试');
      }
    });
  }, [songs, offline, bulkCopy.phase, copyTasks, taskKey, feedback, create, addSong]);

  return {
    bulkDownload,
    bulkCache,
    bulkCopy,
    handleDownloadAll,
    handleCacheAll,
    handleCopyToMine,
    busy: bulkDownload.phase === 'running' || bulkCache.phase === 'running' || bulkCopy.phase === 'running',
    hasAnyState:
      bulkDownload.phase !== 'idle' || bulkCache.phase !== 'idle' || bulkCopy.phase !== 'idle',
  };
}

export default useBulkActions;
