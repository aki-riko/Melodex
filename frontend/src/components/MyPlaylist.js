import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Download, Ellipsis, HardDriveDownload, Play, Trash2 } from 'lucide-react';
import SongRow, { SongListHeader } from './SongRow';
import { usePlayer } from '../contexts/PlayerContext';
import { useCollections } from '../contexts/CollectionsContext';
import { useAuth } from '../contexts/AuthContext';
import { useFeedback } from '../contexts/FeedbackContext';
import { onOpenPlaylist } from '../services/playlistBus';
import { getCollectionSongs, removeSongFromCollection } from '../services/collections';
import { songIdentityKey } from '../utils/songIdentity';
import { useBulkActions } from '../hooks/useBulkActions';
import LoadingState from './LoadingState';
import CoverMosaic from './CoverMosaic';
import { getLyric } from '../services/musicdl';
import Button from '../ui/Button';
import StatusLine from '../ui/StatusLine';
import EmptyState from '../ui/EmptyState';
import Dialog from '../ui/Dialog';
import { MenuPopover, MenuItem } from '../ui/Menu';

// 自建歌单详情页:侧栏点歌单 → 派发 {collectionId,name} → 这里加载歌曲并播放/移除。
// 批量下载/缓存改用共享 hooks/useBulkActions(原先这里有一份与 Download 页重复的实现)。
export default function MyPlaylist() {
  const [meta, setMeta] = useState(null); // {collectionId, name}
  const [songs, setSongs] = useState([]);
  const [loading, setLoading] = useState(false);
  const [lyric, setLyric] = useState(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef(null);
  const loadSeqRef = useRef(0);
  const { play, isPlaying, isPaused, togglePlay } = usePlayer();
  const { user, offline } = useAuth();
  const feedback = useFeedback();
  const { remove, collections } = useCollections();
  const userId = user?.id || 0;
  const currentCollection = collections.find((c) => c.id === meta?.collectionId);
  const currentName = meta?.name || currentCollection?.name || '歌单';
  const collectionKind = meta?.kind || currentCollection?.kind;
  const canDeleteCollection = !offline && Boolean(collectionKind) && collectionKind !== 'favorite';
  const taskKey = userId > 0 && meta?.collectionId != null
    ? `user:${userId}:collection:${meta.collectionId}`
    : '';

  const {
    bulkDownload, bulkCache, handleDownloadAll, handleCacheAll, hasAnyState,
  } = useBulkActions({ taskKey, songs, scopePrefix: 'collection' });

  const load = useCallback(async (collectionId) => {
    const seq = loadSeqRef.current + 1;
    loadSeqRef.current = seq;
    setLoading(true);
    if (offline) {
      if (loadSeqRef.current === seq) { setSongs([]); setLoading(false); }
      return;
    }
    try {
      const data = await getCollectionSongs(collectionId);
      const list = Array.isArray(data) ? data : (data?.songs || []);
      if (loadSeqRef.current === seq) setSongs(list);
    } catch (err) {
      if (loadSeqRef.current === seq) setSongs([]);
      feedback.error(`加载歌单失败:${err?.response?.data?.error || err?.message || '请稍后重试'}`);
    } finally {
      if (loadSeqRef.current === seq) setLoading(false);
    }
  }, [offline, feedback]);

  useEffect(() => onOpenPlaylist((m) => {
    if (m && m.collectionId != null) { setMeta(m); load(m.collectionId); }
  }), [load]);

  // 哈希路由:刷新/直达/分享 #myplaylist/<id> 时,从 hash 恢复要打开的歌单。
  useEffect(() => {
    const fromHash = () => {
      const parts = (window.location.hash || '').replace(/^#/, '').split('/');
      if (parts[0].toLowerCase() === 'myplaylist' && parts[1]) {
        const id = parseInt(parts[1], 10);
        if (!isNaN(id)) {
          setMeta((m) => (m && m.collectionId === id ? m : { collectionId: id, name: '' }));
          load(id);
        }
      }
    };
    fromHash();
    window.addEventListener('hashchange', fromHash);
    return () => window.removeEventListener('hashchange', fromHash);
  }, [load]);

  if (!meta) {
    return (
      <EmptyState
        icon={Play}
        title="从左侧选择一个歌单"
        description="自建歌单、「我喜欢」和导入的平台歌单都在侧栏「我的歌单」里。"
      />
    );
  }

  const handleRemove = async (song) => {
    if (offline) return;
    const targetKey = songIdentityKey(song);
    const prev = songs;
    setSongs((s) => s.filter((x) => songIdentityKey(x) !== targetKey));
    try {
      await removeSongFromCollection(meta.collectionId, song);
      feedback.success(collectionKind === 'favorite' ? '已取消喜欢' : '已从歌单移除');
    } catch (err) {
      setSongs(prev);
      feedback.error(`移除失败:${err?.response?.data?.error || err?.message || '请稍后重试'}`);
    }
  };

  const handleShowLyric = async (song) => {
    setLyric({ song, text: '加载中…' });
    try {
      const text = await getLyric(song);
      setLyric({ song, text: text || '无歌词' });
    } catch {
      setLyric({ song, text: '歌词加载失败' });
    }
  };

  const handleDeleteCollection = async () => {
    if (!canDeleteCollection) return;
    setMoreOpen(false);
    const ok = await feedback.confirm({
      title: `删除歌单「${currentName}」?`,
      body: '只删除歌单记录，不会删除服务器「已下载」里的歌曲文件。',
      confirmLabel: '删除歌单',
      danger: true,
    });
    if (!ok) return;
    try {
      await remove(meta.collectionId);
      setMeta(null);
      setSongs([]);
      feedback.success('歌单已删除');
    } catch (err) {
      feedback.error(`删除歌单失败:${err?.response?.data?.error || err?.message || '请稍后重试'}`);
    }
  };

  const downloadLabel = bulkDownload.phase === 'done' ? '已下载'
    : bulkDownload.phase === 'fail' ? '重试下载'
      : bulkDownload.phase === 'running' ? `下载中 ${bulkDownload.done || 0}/${bulkDownload.total || songs.length}`
        : '下载到服务器';
  const cacheLabel = bulkCache.phase === 'done' ? '已缓存'
    : bulkCache.phase === 'fail' ? '重试缓存'
      : bulkCache.phase === 'running' ? `缓存中 ${bulkCache.done || 0}/${bulkCache.total || songs.length}`
        : '缓存到本机';
  const collectionLabel = collectionKind === 'favorite' ? '我喜欢' : '歌单';
  const rowRemoveTitle = collectionKind === 'favorite' ? '取消喜欢' : '从歌单移除';
  const rowRemoveHint = collectionKind === 'favorite' ? '只从我喜欢里移除' : '只从当前歌单移除';

  return (
    <div>
      <header className="mb-5 flex flex-col gap-4 sm:flex-row sm:items-end">
        <CoverMosaic items={songs} icon={Play} iconSize={36} />
        <div className="min-w-0 flex-1">
          <p className="type-micro uppercase tracking-wider text-muted-foreground">{collectionLabel}</p>
          <h1 className="mt-0.5 line-clamp-2 type-hero text-foreground">{currentName}</h1>
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
              title={offline ? '离线状态无法下载到服务器' : '把这张歌单全部存到服务器曲库'}
            >
              <Download size={16} aria-hidden="true" />
              {downloadLabel}
            </Button>
            <Button
              variant="secondary"
              onClick={handleCacheAll}
              loading={bulkCache.phase === 'running'}
              disabled={!songs.length || offline || bulkCache.phase === 'running'}
              title={offline ? '离线状态无法缓存新歌曲' : '存到当前浏览器/PWA，可离线听'}
            >
              <HardDriveDownload size={16} aria-hidden="true" />
              {cacheLabel}
            </Button>
            {canDeleteCollection && (
              <>
                <Button
                  ref={moreRef}
                  variant="ghost"
                  onClick={() => setMoreOpen((open) => !open)}
                  aria-haspopup="menu"
                  aria-expanded={moreOpen}
                  title="更多操作"
                >
                  <Ellipsis size={16} aria-hidden="true" />
                  更多
                </Button>
                <MenuPopover anchorRef={moreRef} open={moreOpen} onClose={() => setMoreOpen(false)} width="w-52">
                  <MenuItem
                    icon={Trash2}
                    label="删除歌单"
                    hint="不会删除服务器文件"
                    onClick={handleDeleteCollection}
                    danger
                  />
                </MenuPopover>
              </>
            )}
          </div>
        </div>
      </header>

      {hasAnyState && (
        <StatusLine
          tone={[bulkDownload.phase, bulkCache.phase].includes('fail') ? 'error' : 'neutral'}
          loading={[bulkDownload.phase, bulkCache.phase].includes('running')}
          className="mb-3"
        >
          服务器 {bulkDownload.phase === 'idle' ? '—' : `${bulkDownload.done || 0}/${bulkDownload.total || 0}${bulkDownload.fail ? ` · 失败 ${bulkDownload.fail}` : ''}`}
          <span className="mx-2 text-border">|</span>
          本机 {bulkCache.phase === 'idle' ? '—' : `${bulkCache.done || 0}/${bulkCache.total || 0}${bulkCache.fail ? ` · 失败 ${bulkCache.fail}` : ''}`}
        </StatusLine>
      )}

      {loading && (
        <LoadingState title="加载歌单" detail="正在读取歌曲、专辑和封面信息" rows={5} />
      )}

      {!loading && songs.length === 0 && (
        <EmptyState
          icon={Download}
          title="这个歌单还没有歌"
          description="去「找歌」搜索后，用行内「加入歌单」把歌存进来。"
          action={(
            <Button variant="primary" onClick={() => { window.location.hash = 'download'; }}>
              去找歌
            </Button>
          )}
        />
      )}

      {!loading && songs.length > 0 && (
        <>
          <SongListHeader />
          <div className="space-y-0.5">
            {songs.map((song, i) => (
              <SongRow
                key={songIdentityKey(song)}
                song={song}
                index={i}
                isPlaying={isPlaying(song)}
                onPlay={(s) => play(s, songs)}
                isPaused={isPaused}
                onTogglePlayback={togglePlay}
                onShowLyric={handleShowLyric}
                onRemove={handleRemove}
                removeTitle={rowRemoveTitle}
                removeHint={rowRemoveHint}
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
}
