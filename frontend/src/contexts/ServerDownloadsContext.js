import { createContext, useCallback, useContext, useEffect, useMemo, useRef } from 'react';
import { useQuery, useQueryClient } from 'react-query';
import { getServerDownloads, SERVER_DOWNLOADS_CHANGED } from '../services/musicdl';
import { useAuth } from './AuthContext';
import { normalizeSong } from '../utils/songFields';
import {
  buildServerDownloadIndex,
  serverDownloadEventBelongsToUser,
  serverDownloadMatchesKnownKeys,
  serverDownloadRecordForSong,
  serverDownloadStatusKey,
  serverDownloadTitleArtistKey,
} from '../utils/serverDownloads';
import { createWakeReconciler, serverDownloadsQueryOptions } from './appWakePolicy.js';

const ServerDownloadsContext = createContext(null);

export function ServerDownloadsProvider({ children }) {
  const { user, offline } = useAuth();
  const userId = user?.id || 0;
  const queryClient = useQueryClient();
  const queryKey = useMemo(() => ['server-downloads', String(userId)], [userId]);
  const downloadsQuery = useQuery(
    queryKey,
    getServerDownloads,
    serverDownloadsQueryOptions({ userId, offline }),
  );
  // 唤醒重算用 ref 读 refetch,避免整个 query 对象进 effect 依赖(见第一个 effect 的说明)。
  const refetchRef = useRef(downloadsQuery.refetch);
  refetchRef.current = downloadsQuery.refetch;

  useEffect(() => {
    if (userId <= 0 || offline) return undefined;

    const reconciler = createWakeReconciler({
      isVisible: () => document.visibilityState === 'visible',
      isOnline: () => navigator.onLine !== false,
      // 走 refetchRef 而不是直接闭包 downloadsQuery:依赖数组里已经精确列了
      // downloadsQuery.refetch,而 lint 要求列出"体内读到的整个对象"。
      // 用 ref 读取既满足"只在触发时取最新值",也不必让整个 query 对象进依赖
      // (它是每次渲染的新引用,进去就会反复重建 reconciler/监听器)。
      reconcile: () => { refetchRef.current?.(); },
    });
    const onVisibilityChange = () => reconciler.onVisibilityChange();
    const onOnline = () => reconciler.onOnline();
    const onOffline = () => reconciler.onOffline();

    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      reconciler.cancel();
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, [downloadsQuery.refetch, offline, userId]);

  useEffect(() => {
    const onChanged = async (event) => {
      const detail = event?.detail || {};
      const song = normalizeSong(detail.song || {});
      const key = serverDownloadStatusKey(song.source, song.id);

      if (detail.action === 'saved' && key) {
        // 慢下载可能在账号切换后才返回。只接受后端确认属于当前用户的事件,
        // 防止 A 的迟到响应把下载状态乐观写进 B 的缓存。
        if (!serverDownloadEventBelongsToUser(detail, userId)) return;
        // 首次 GET 可能仍在飞行。先取消它,避免稍后返回的旧列表覆盖刚保存的状态。
        await queryClient.cancelQueries(queryKey);
        queryClient.setQueryData(queryKey, (current) => {
          const downloads = Array.isArray(current?.downloads) ? current.downloads : [];
          if (downloads.some((item) => serverDownloadStatusKey(item?.source, item?.song_id) === key)) {
            return current || { downloads, total: downloads.length };
          }
          const next = [{
            source: song.source,
            song_id: song.id,
            name: song.name,
            artist: song.artist,
          }, ...downloads];
          return { ...(current || {}), downloads: next, total: next.length };
        });
        queryClient.invalidateQueries(['local-music-page']);
        queryClient.invalidateQueries(['local-music']);
        return;
      }

      queryClient.invalidateQueries(queryKey);
      queryClient.invalidateQueries(['local-music-page']);
      queryClient.invalidateQueries(['local-music']);
    };

    window.addEventListener(SERVER_DOWNLOADS_CHANGED, onChanged);
    return () => window.removeEventListener(SERVER_DOWNLOADS_CHANGED, onChanged);
    // ★ userId 必须在依赖里(2026-11 全库扫描修正的真 bug):onChanged 内部用
    //   serverDownloadEventBelongsToUser(detail, userId) 判断事件是否属于当前用户,
    //   而闭包捕获的是**注册时的那个 userId**。漏掉它 → 切换账号后监听器仍是旧的,
    //   于是「A 的迟到下载响应」会被当成 B 的事件写进 B 的缓存(与上面那段注释
    //   想防的正是同一件事,只是防不住)。queryKey 已含 userId,一并列出。
  }, [queryClient, queryKey, userId]);

  const downloadedKeys = useMemo(() => {
    const keys = new Set();
    for (const item of downloadsQuery.data?.downloads || []) {
      const key = serverDownloadStatusKey(item?.source, item?.song_id);
      if (key) keys.add(key);
    }
    return keys;
  }, [downloadsQuery.data]);

  const downloadedTitleArtistKeys = useMemo(() => {
    const keys = new Set();
    for (const item of downloadsQuery.data?.downloads || []) {
      const key = serverDownloadTitleArtistKey(item?.name, item?.artist);
      if (key) keys.add(key);
    }
    return keys;
  }, [downloadsQuery.data]);

  // 「歌曲 → 下载记录」索引(含后端新增的 ext/size_bytes),供播放时判断是否需要音质升级。
  const downloadIndex = useMemo(
    () => buildServerDownloadIndex(downloadsQuery.data?.downloads),
    [downloadsQuery.data],
  );

  const isDownloaded = useCallback((song) => {
    const normalized = normalizeSong(song);
    return serverDownloadMatchesKnownKeys(normalized, downloadedKeys, downloadedTitleArtistKeys);
  }, [downloadedKeys, downloadedTitleArtistKeys]);

  // 返回匹配到的下载记录(不只是布尔),未命中返回 null。
  // 匹配语义与 isDownloaded 完全一致:先 source+song_id 精确,身份缺失才退回完整歌名+歌手。
  const downloadedCopy = useCallback((song) => {
    if (!song) return null;
    const normalized = normalizeSong(song);
    const record = serverDownloadRecordForSong(normalized, downloadIndex);
    return record || null;
  }, [downloadIndex]);

  const value = useMemo(() => ({
    isDownloaded,
    downloadedCopy,
    loading: downloadsQuery.isLoading,
    refetch: downloadsQuery.refetch,
  }), [downloadedCopy, downloadsQuery.isLoading, downloadsQuery.refetch, isDownloaded]);

  return (
    <ServerDownloadsContext.Provider value={value}>
      {children}
    </ServerDownloadsContext.Provider>
  );
}

export const useServerDownloads = () => {
  const value = useContext(ServerDownloadsContext);
  if (!value) throw new Error('useServerDownloads must be used inside ServerDownloadsProvider');
  return value;
};
