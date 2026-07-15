import React, { createContext, useCallback, useContext, useEffect, useMemo } from 'react';
import { useQuery, useQueryClient } from 'react-query';
import { getServerDownloads, SERVER_DOWNLOADS_CHANGED } from '../services/musicdl';
import { useAuth } from './AuthContext';
import { normalizeSong } from '../utils/songFields';
import {
  serverDownloadEventBelongsToUser,
  serverDownloadMatchesKnownKeys,
  serverDownloadStatusKey,
  serverDownloadTitleArtistKey,
} from '../utils/serverDownloads';
import { serverDownloadsQueryOptions } from './appWakePolicy.js';

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
    return serverDownloadMatchesKnownKeys(normalized, downloadedKeys, downloadedTitleArtistKeys);
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
