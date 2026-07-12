import React, { createContext, useCallback, useContext, useEffect, useMemo } from 'react';
import { useQuery, useQueryClient } from 'react-query';
import { getServerDownloads, SERVER_DOWNLOADS_CHANGED } from '../services/musicdl';
import { useAuth } from './AuthContext';
import { normalizeSong } from '../utils/songFields';
import {
  serverDownloadEventBelongsToUser,
  serverDownloadStatusKey,
  serverDownloadTitleArtistKey,
} from '../utils/serverDownloads';

const ServerDownloadsContext = createContext(null);

const isLocalSource = (source) => source === 'local' || source === 'local_music';

export function ServerDownloadsProvider({ children }) {
  const { user, offline } = useAuth();
  const userId = user?.id || 0;
  const queryClient = useQueryClient();
  const queryKey = useMemo(() => ['server-downloads', String(userId)], [userId]);
  const downloadsQuery = useQuery(queryKey, getServerDownloads, {
    enabled: userId > 0 && !offline,
    staleTime: 60 * 1000,
    refetchOnReconnect: true,
    refetchOnWindowFocus: true,
  });

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
  }, [queryClient, queryKey]);

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

  const isDownloaded = useCallback((song) => {
    const normalized = normalizeSong(song);
    if (isLocalSource(normalized.source)) return true;
    const key = serverDownloadStatusKey(normalized.source, normalized.id);
    if (key && downloadedKeys.has(key)) return true;
    // 同一物理歌曲可能从另一音源复用/升级。精确身份优先；仅在精确身份未命中时,
    // 用完整歌名+完整歌手的规范化等值匹配恢复状态,不做包含/相似度等模糊猜测。
    const fallbackKey = serverDownloadTitleArtistKey(normalized.name, normalized.artist);
    return !!fallbackKey && downloadedTitleArtistKeys.has(fallbackKey);
  }, [downloadedKeys, downloadedTitleArtistKeys]);

  const value = useMemo(() => ({
    isDownloaded,
    loading: downloadsQuery.isLoading,
    refetch: downloadsQuery.refetch,
  }), [downloadsQuery.isLoading, downloadsQuery.refetch, isDownloaded]);

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
