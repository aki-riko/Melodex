import React, { useEffect, useState } from 'react';
import { useQuery } from 'react-query';
import { Check, Download, HardDriveDownload, ListPlus, Music, Play, RotateCw } from 'lucide-react';
import { getPlaylistDetail, getLyric, saveToServer } from '../services/musicdl';
import SongRow, { SongListHeader } from './SongRow';
import { usePlayer } from '../contexts/PlayerContext';
import { useAuth } from '../contexts/AuthContext';
import { useCollections } from '../contexts/CollectionsContext';
import { useFeedback } from '../contexts/FeedbackContext';
import { cacheSong, canCacheSong, isSongCached } from '../services/offlineAudio';

// 歌单歌曲列表(点开某歌单后)
const PlaylistSongs = ({ meta, onBack }) => {
  const { play, isPlaying, isPaused, togglePlay } = usePlayer();
  const { user, offline } = useAuth();
  const { create, addSong } = useCollections();
  const feedback = useFeedback();
  const [lyric, setLyric] = useState(null);
  const [bulkDownload, setBulkDownload] = useState({ phase: 'idle', done: 0, fail: 0, total: 0 });
  const [bulkCache, setBulkCache] = useState({ phase: 'idle', done: 0, fail: 0, skipped: 0, total: 0 });
  const [bulkCopy, setBulkCopy] = useState({ phase: 'idle', done: 0, fail: 0, total: 0, collectionId: null });
  const userId = user?.id || 0;
  const state = useQuery(
    ['pl-detail', meta.id, meta.source],
    () => getPlaylistDetail(meta.id, meta.source),
    { enabled: !!meta }
  );

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
  useEffect(() => {
    setBulkDownload({ phase: 'idle', done: 0, fail: 0, total: 0 });
    setBulkCache({ phase: 'idle', done: 0, fail: 0, skipped: 0, total: 0 });
    setBulkCopy({ phase: 'idle', done: 0, fail: 0, total: 0, collectionId: null });
  }, [meta.id, meta.source]);

  const handleDownloadAll = async () => {
    if (!songs.length || offline || bulkDownload.phase === 'running') return;
    const total = songs.length;
    let done = 0;
    let fail = 0;
    setBulkDownload({ phase: 'running', done, fail, total });
    for (const song of songs) {
      try {
        const result = await saveToServer(song);
        if (result?.saved) done += 1;
        else fail += 1;
      } catch {
        fail += 1;
      }
      setBulkDownload({ phase: 'running', done, fail, total });
    }
    setBulkDownload({ phase: fail ? 'fail' : 'done', done, fail, total });
  };

  const handleCacheAll = async () => {
    if (!songs.length || offline || bulkCache.phase === 'running') return;
    const total = songs.length;
    let done = 0;
    let fail = 0;
    let skipped = 0;
    setBulkCache({ phase: 'running', done, fail, skipped, total });
    for (const song of songs) {
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
      setBulkCache({ phase: 'running', done, fail, skipped, total });
    }
    setBulkCache({ phase: fail ? 'fail' : 'done', done, fail, skipped, total });
  };

  const handleCopyToMine = async () => {
    if (!songs.length || offline || bulkCopy.phase === 'running') return;
    const total = songs.length;
    let done = 0;
    let fail = 0;
    setBulkCopy({ phase: 'running', done, fail, total, collectionId: null });
    try {
      const collection = await create(meta.name || '推荐歌单');
      const collectionId = collection?.id;
      if (collectionId == null) throw new Error('collection id missing');
      for (const song of songs) {
        try {
          await addSong(collectionId, song);
          done += 1;
        } catch {
          fail += 1;
        }
        setBulkCopy({ phase: 'running', done, fail, total, collectionId });
      }
      setBulkCopy({ phase: fail ? 'fail' : 'done', done, fail, total, collectionId });
      if (fail) feedback.error(`已创建歌单,但 ${fail} 首加入失败`);
      else feedback.success('已加入我的歌单');
    } catch {
      setBulkCopy({ phase: 'fail', done, fail: total || 1, total, collectionId: null });
      feedback.error('加入我的歌单失败,请稍后重试');
    }
  };

  const downloadLabel = bulkDownload.phase === 'done'
    ? '已下载到 NAS'
    : bulkDownload.phase === 'fail'
      ? '重试下载到 NAS'
      : '下载到 NAS';
  const cacheLabel = bulkCache.phase === 'done'
    ? '已缓存到本机'
    : bulkCache.phase === 'fail'
      ? '重试缓存到本机'
      : '缓存到本机';
  const copyLabel = bulkCopy.phase === 'done'
    ? '已加入我的歌单'
    : bulkCopy.phase === 'fail'
      ? '重试加入歌单'
      : '加入我的歌单';
  const DownloadIcon = bulkDownload.phase === 'done' ? Check : bulkDownload.phase === 'fail' ? RotateCw : Download;
  const CacheIcon = bulkCache.phase === 'done' ? Check : bulkCache.phase === 'fail' ? RotateCw : HardDriveDownload;
  const CopyIcon = bulkCopy.phase === 'done' ? Check : bulkCopy.phase === 'fail' ? RotateCw : ListPlus;
  const hasBulkStatus = bulkDownload.phase !== 'idle' || bulkCache.phase !== 'idle' || bulkCopy.phase !== 'idle';

  return (
    <div className="pb-32">
      <button
        onClick={onBack}
        className="mb-4 rounded-full bg-secondary px-3 py-1.5 text-sm font-semibold text-foreground transition-colors hover:bg-secondary/80"
      >
        ← 返回
      </button>
      <div className="mb-4 flex flex-col gap-4 sm:flex-row sm:items-end">
        <div className="flex h-32 w-32 flex-shrink-0 items-center justify-center rounded-lg bg-secondary">
          <Music size={42} className="text-muted-foreground" />
        </div>
        <div className="min-w-0">
          <p className="text-xs uppercase tracking-wider text-muted-foreground">推荐歌单</p>
          <h3 className="truncate text-3xl font-black">{meta.name}</h3>
          <p className="mt-1 text-sm text-muted-foreground">{songs.length} 首</p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button onClick={() => songs.length && play(songs[0], songs)}
              disabled={!songs.length}
              className="flex min-h-10 items-center gap-2 rounded-full bg-primary px-5 py-2 font-semibold text-primary-foreground disabled:opacity-50">
              <Play size={18} fill="currentColor" />播放全部
            </button>
            <button onClick={handleDownloadAll}
              disabled={!songs.length || offline || bulkDownload.phase === 'running'}
              className={`flex min-h-10 items-center gap-2 rounded-full px-4 py-2 font-semibold transition-colors disabled:opacity-50 ${
                bulkDownload.phase === 'done' ? 'bg-primary/10 text-primary'
                : bulkDownload.phase === 'fail' ? 'bg-destructive/10 text-destructive hover:bg-destructive/20'
                : 'bg-secondary text-foreground hover:bg-secondary/80'
              }`}
              title={offline ? '离线状态无法下载到 NAS' : '把这张推荐歌单下载到服务器曲库'}>
              <DownloadIcon size={18} className={bulkDownload.phase === 'running' ? 'animate-pulse' : ''} />
              {downloadLabel}
            </button>
            <button onClick={handleCacheAll}
              disabled={!songs.length || offline || bulkCache.phase === 'running'}
              className={`flex min-h-10 items-center gap-2 rounded-full px-4 py-2 font-semibold transition-colors disabled:opacity-50 ${
                bulkCache.phase === 'done' ? 'bg-primary/10 text-primary'
                : bulkCache.phase === 'fail' ? 'bg-destructive/10 text-destructive hover:bg-destructive/20'
                : 'bg-secondary text-foreground hover:bg-secondary/80'
              }`}
              title={offline ? '离线状态无法缓存新歌曲' : '把这张推荐歌单缓存到当前浏览器/PWA'}>
              <CacheIcon size={18} className={bulkCache.phase === 'running' ? 'animate-pulse' : ''} />
              {cacheLabel}
            </button>
            <button onClick={handleCopyToMine}
              disabled={!songs.length || offline || bulkCopy.phase === 'running' || bulkCopy.phase === 'done'}
              className={`flex min-h-10 items-center gap-2 rounded-full px-4 py-2 font-semibold transition-colors disabled:opacity-50 ${
                bulkCopy.phase === 'done' ? 'bg-primary/10 text-primary'
                : bulkCopy.phase === 'fail' ? 'bg-destructive/10 text-destructive hover:bg-destructive/20'
                : 'bg-secondary text-foreground hover:bg-secondary/80'
              }`}
              title={offline ? '离线状态无法修改歌单' : '复制为我的自建歌单'}>
              <CopyIcon size={18} className={bulkCopy.phase === 'running' ? 'animate-pulse' : ''} />
              {copyLabel}
            </button>
          </div>
        </div>
      </div>
      {state.isLoading && <p className="text-muted-foreground font-bold">加载歌单…</p>}
      {state.data?.error && <p className="text-destructive font-bold mb-4">{state.data.error}</p>}
      {hasBulkStatus && (
        <div className="mb-4 grid gap-2 sm:grid-cols-2">
          {bulkDownload.phase !== 'idle' && (
            <div className={`rounded-md border px-3 py-2 text-sm ${
              bulkDownload.phase === 'fail' ? 'border-destructive/40 bg-destructive/10 text-destructive' : 'border-border bg-card/70 text-muted-foreground'
            }`}>
              <p className="font-medium text-foreground">NAS 下载</p>
              <p>
                已完成 {bulkDownload.done}/{bulkDownload.total}
                {bulkDownload.fail ? ` · 失败 ${bulkDownload.fail}` : ''}
              </p>
            </div>
          )}
          {bulkCache.phase !== 'idle' && (
            <div className={`rounded-md border px-3 py-2 text-sm ${
              bulkCache.phase === 'fail' ? 'border-destructive/40 bg-destructive/10 text-destructive' : 'border-border bg-card/70 text-muted-foreground'
            }`}>
              <p className="font-medium text-foreground">本机缓存</p>
              <p>
                新增 {bulkCache.done}
                {bulkCache.skipped ? ` · 已有 ${bulkCache.skipped}` : ''}
                {bulkCache.total ? ` · 共 ${bulkCache.total}` : ''}
                {bulkCache.fail ? ` · 失败 ${bulkCache.fail}` : ''}
              </p>
            </div>
          )}
          {bulkCopy.phase !== 'idle' && (
            <div className={`rounded-md border px-3 py-2 text-sm ${
              bulkCopy.phase === 'fail' ? 'border-destructive/40 bg-destructive/10 text-destructive' : 'border-border bg-card/70 text-muted-foreground'
            }`}>
              <p className="font-medium text-foreground">加入我的歌单</p>
              <p>
                已加入 {bulkCopy.done}/{bulkCopy.total}
                {bulkCopy.fail ? ` · 失败 ${bulkCopy.fail}` : ''}
              </p>
            </div>
          )}
        </div>
      )}
      <SongListHeader />
      <div className="space-y-0.5">
        {songs.map((song, idx) => (
          <SongRow
            key={`${song.source}-${song.id}-${idx}`}
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
      {lyric && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={() => setLyric(null)}>
          <div className="bg-card border border-border rounded-lg shadow-xl max-w-lg w-full max-h-[70vh] overflow-y-auto p-6" onClick={(e) => e.stopPropagation()}>
            <div className="flex justify-between items-start mb-4">
              <div>
                <h3 className="text-xl font-bold">{lyric.song.name}</h3>
                <p className="text-muted-foreground text-sm">{lyric.song.artist}</p>
              </div>
              <button onClick={() => setLyric(null)} className="font-bold text-2xl leading-none hover:text-primary">×</button>
            </div>
            <pre className="whitespace-pre-wrap text-foreground text-sm font-sans">{lyric.text}</pre>
          </div>
        </div>
      )}
    </div>
  );
};

export default PlaylistSongs;
