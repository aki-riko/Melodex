import React, { useState } from 'react';
import { useQuery } from 'react-query';
import { Download, HardDriveDownload, ListPlus, Music, Play } from 'lucide-react';
import { getPlaylistDetail, getLyric } from '../services/musicdl';
import SongRow, { SongListHeader } from './SongRow';
import { usePlayer } from '../contexts/PlayerContext';
import { useAuth } from '../contexts/AuthContext';
import { useBulkActions } from '../hooks/useBulkActions';
import { songIdentityKey } from '../utils/songIdentity';
import LoadingState from './LoadingState';
import { useCachedRefresh } from '../hooks/useCachedRefresh';
import Button from '../ui/Button';
import StatusLine from '../ui/StatusLine';
import EmptyState from '../ui/EmptyState';
import Dialog from '../ui/Dialog';

// 歌单歌曲列表(点开某歌单后)。
// 批量三件套已抽到 hooks/useBulkActions,与 Download 页的远端歌单详情共用同一份实现
// (此前是两份逐行重复的 handleDownloadAll / handleCacheAll / handleCopyToMine)。
const PlaylistSongs = ({ meta, onBack }) => {
  const { play, isPlaying, isPaused, togglePlay } = usePlayer();
  const { user, offline } = useAuth();
  const [lyric, setLyric] = useState(null);
  const userId = user?.id || 0;
  const taskKey = `user:${userId}:${meta.source}:${meta.id}`;

  const state = useQuery(
    ['pl-detail', meta.id, meta.source],
    () => getPlaylistDetail(meta.id, meta.source),
    { enabled: !!meta }
  );
  useCachedRefresh(state, !!meta);

  const showLyric = async (song) => {
    setLyric({ song, text: '加载中…' });
    try {
      const t = await getLyric(song);
      setLyric({ song, text: t || '无歌词' });
    } catch {
      setLyric({ song, text: '歌词加载失败' });
    }
  };

  const songs = state.data?.songs || [];
  const {
    bulkDownload, bulkCache, bulkCopy,
    handleDownloadAll, handleCacheAll, handleCopyToMine, hasAnyState,
  } = useBulkActions({ taskKey, songs, scopePrefix: 'recommended-playlist' });

  const downloadLabel = bulkDownload.phase === 'done' ? '已下载'
    : bulkDownload.phase === 'fail' ? '重试下载'
      : bulkDownload.phase === 'running' ? `下载中 ${bulkDownload.done || 0}/${bulkDownload.total || songs.length}`
        : '下载到服务器';
  const cacheLabel = bulkCache.phase === 'done' ? '已缓存'
    : bulkCache.phase === 'fail' ? '重试缓存'
      : bulkCache.phase === 'running' ? `缓存中 ${bulkCache.done || 0}/${bulkCache.total || songs.length}`
        : '缓存到本机';
  const copyLabel = bulkCopy.phase === 'done' ? '已加入'
    : bulkCopy.phase === 'fail' ? '重试加入'
      : '加入我的歌单';

  return (
    <div>
      <Button variant="ghost" size="sm" onClick={onBack} className="mb-4 -ml-2">← 返回</Button>

      <header className="mb-5 flex flex-col gap-4 sm:flex-row sm:items-end">
        <div className="flex h-28 w-28 flex-shrink-0 items-center justify-center rounded-lg bg-secondary sm:h-32 sm:w-32">
          <Music size={36} className="text-muted-foreground" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="type-micro uppercase tracking-wider text-muted-foreground">推荐歌单</p>
          <h1 className="mt-0.5 line-clamp-2 type-hero text-foreground">{meta.name}</h1>
          <p className="mt-1 type-caption text-muted-foreground nums">{songs.length} 首</p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button
              variant="primary"
              onClick={() => songs.length && play(songs[0], songs)}
              disabled={!songs.length}
            >
              <Play size={16} fill="currentColor" aria-hidden="true" />
              播放全部
            </Button>
            <Button
              variant="secondary"
              onClick={handleDownloadAll}
              loading={bulkDownload.phase === 'running'}
              disabled={!songs.length || offline || bulkDownload.phase === 'running'}
              title={offline ? '离线状态无法下载到服务器' : '把这张歌单存到服务器曲库'}
            >
              <Download size={16} aria-hidden="true" />
              {downloadLabel}
            </Button>
            <Button
              variant="secondary"
              onClick={handleCacheAll}
              loading={bulkCache.phase === 'running'}
              disabled={!songs.length || offline || bulkCache.phase === 'running'}
              title={offline ? '离线状态无法缓存新歌曲' : '存到当前浏览器/PWA,可离线听'}
            >
              <HardDriveDownload size={16} aria-hidden="true" />
              {cacheLabel}
            </Button>
            <Button
              variant="ghost"
              onClick={() => handleCopyToMine(meta.name)}
              loading={bulkCopy.phase === 'running'}
              disabled={!songs.length || offline || bulkCopy.phase === 'done'}
              title="复制成我自己的歌单"
            >
              <ListPlus size={16} aria-hidden="true" />
              {copyLabel}
            </Button>
          </div>
        </div>
      </header>

      {hasAnyState && (
        <StatusLine
          tone={[bulkDownload.phase, bulkCache.phase, bulkCopy.phase].includes('fail') ? 'error' : 'neutral'}
          loading={[bulkDownload.phase, bulkCache.phase, bulkCopy.phase].includes('running')}
          className="mb-3"
        >
          服务器 {bulkDownload.phase === 'idle' ? '—' : `${bulkDownload.done || 0}/${bulkDownload.total || 0}`}
          <span className="mx-2 text-border">|</span>
          本机 {bulkCache.phase === 'idle' ? '—' : `${bulkCache.done || 0}/${bulkCache.total || 0}`}
          <span className="mx-2 text-border">|</span>
          加入歌单 {bulkCopy.phase === 'idle' ? '—' : `${bulkCopy.done || 0}/${bulkCopy.total || 0}`}
        </StatusLine>
      )}

      {state.isLoading && <LoadingState title="加载歌单" detail="正在读取曲目与封面" rows={5} />}
      {state.data?.error && (
        <StatusLine tone="error" layout="banner" className="mb-3">{state.data.error}</StatusLine>
      )}
      {!state.isLoading && songs.length === 0 && !state.data?.error && (
        <EmptyState compact icon={Music} title="这张歌单没有可显示的曲目" />
      )}

      {songs.length > 0 && (
        <>
          <SongListHeader />
          <div className="space-y-0.5">
            {songs.map((song, idx) => (
              <SongRow
                key={songIdentityKey(song) || `${song.source}-${song.id}-${idx}`}
                song={song}
                index={idx}
                isPlaying={isPlaying(song)}
                isPaused={isPaused}
                onTogglePlayback={togglePlay}
                onPlay={(s) => play(s, songs)}
                onShowLyric={showLyric}
              />
            ))}
          </div>
        </>
      )}

      <Dialog
        open={!!lyric}
        onClose={() => setLyric(null)}
        title={lyric ? lyric.song.name : ''}
        size="lg"
      >
        {lyric && (
          <>
            <p className="mb-3 type-caption text-muted-foreground">{lyric.song.artist}</p>
            <pre className="whitespace-pre-wrap font-sans type-body text-foreground">{lyric.text}</pre>
          </>
        )}
      </Dialog>
    </div>
  );
};

export default PlaylistSongs;
