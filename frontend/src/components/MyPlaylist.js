import React, { useState, useEffect, useCallback, useRef } from 'react';
import { AlertCircle, Check, Download, Ellipsis, HardDriveDownload, Play, RotateCw, Trash2 } from 'lucide-react';
import SongRow from './SongRow';
import { usePlayer } from '../contexts/PlayerContext';
import { useCollections } from '../contexts/CollectionsContext';
import { useAuth } from '../contexts/AuthContext';
import { useFeedback } from '../contexts/FeedbackContext';
import { onOpenPlaylist } from '../services/playlistBus';
import { getCollectionSongs, removeSongFromCollection } from '../services/collections';
import { coverProxyUrl, saveToServer } from '../services/musicdl';
import { cacheSong, canCacheSong, isSongCached } from '../services/offlineAudio';
import { songIdentityKey } from '../utils/songIdentity';

// 歌单详情头图:用歌单内歌曲封面拼图(Spotify 风格)。
//   - 取前 4 首"有封面"的歌:1 张铺满 / 2-3 张仍用首张铺满(半拼不好看) / ≥4 张 2x2 马赛克
//   - 走 cover_proxy(网易 http 封面在 https 生产会被拦混合内容)
//   - 无封面 → 灰占位 + Play 图标(保留原样)
function PlaylistCover({ songs }) {
  const covered = (songs || []).filter((s) => s && (s.cover || s.Cover));
  const placeholder = (
    <div className="w-32 h-32 rounded-lg bg-secondary flex items-center justify-center flex-shrink-0 overflow-hidden shadow">
      <Play size={40} className="text-muted-foreground" />
    </div>
  );
  if (covered.length === 0) return placeholder;

  if (covered.length >= 4) {
    const four = covered.slice(0, 4);
    return (
      <div className="w-32 h-32 rounded-lg overflow-hidden flex-shrink-0 shadow grid grid-cols-2 grid-rows-2 bg-secondary">
        {four.map((s, i) => (
          <img key={i} src={coverProxyUrl(s)} alt="" loading="lazy" className="w-full h-full object-cover" />
        ))}
      </div>
    );
  }
  return (
    <div className="w-32 h-32 rounded-lg overflow-hidden flex-shrink-0 shadow bg-secondary">
      <img src={coverProxyUrl(covered[0])} alt="" loading="lazy" className="w-full h-full object-cover" />
    </div>
  );
}

// 自建歌单详情页:侧栏点歌单 → 派发 {collectionId,name} → 这里加载歌曲并播放/移除。
export default function MyPlaylist() {
  const [meta, setMeta] = useState(null); // {collectionId, name}
  const [songs, setSongs] = useState([]);
  const [loading, setLoading] = useState(false);
  const [bulkDownload, setBulkDownload] = useState({ phase: 'idle', done: 0, fail: 0, total: 0 });
  const [bulkCache, setBulkCache] = useState({ phase: 'idle', done: 0, fail: 0, skipped: 0, total: 0 });
  const [notice, setNotice] = useState('');
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef(null);
  const { play, isPlaying } = usePlayer();
  const { user, offline } = useAuth();
  const feedback = useFeedback();
  const { remove, collections } = useCollections();
  const userId = user?.id || 0;
  const currentCollection = collections.find((c) => c.id === meta?.collectionId);
  const currentName = meta?.name || currentCollection?.name || '歌单';
  const collectionKind = meta?.kind || currentCollection?.kind;
  const canDeleteCollection = !offline && Boolean(collectionKind) && collectionKind !== 'favorite';

  const load = useCallback(async (collectionId) => {
    setLoading(true);
    setNotice('');
    setBulkDownload({ phase: 'idle', done: 0, fail: 0, total: 0 });
    setBulkCache({ phase: 'idle', done: 0, fail: 0, skipped: 0, total: 0 });
    if (offline) {
      setSongs([]);
      setLoading(false);
      return;
    }
    try {
      const data = await getCollectionSongs(collectionId);
      const list = Array.isArray(data) ? data : (data?.songs || []);
      setSongs(list);
    } catch { setSongs([]); } finally { setLoading(false); }
  }, [offline]);

  useEffect(() => onOpenPlaylist((m) => {
    if (m && m.collectionId != null) { setMeta(m); load(m.collectionId); }
  }), [load]);

  // 哈希路由:刷新/直达/分享 #myplaylist/<id> 时,从 hash 恢复要打开的歌单。
  // 名称未知(hash 只带 id),载入后用占位名,详情接口/歌单数据足以渲染。
  useEffect(() => {
    const fromHash = () => {
      const parts = (window.location.hash || '').replace(/^#/, '').split('/');
      if (parts[0].toLowerCase() === 'myplaylist' && parts[1]) {
        const id = parseInt(parts[1], 10);
        if (!isNaN(id)) { setMeta((m) => (m && m.collectionId === id ? m : { collectionId: id, name: '' })); load(id); }
      }
    };
    fromHash();
    window.addEventListener('hashchange', fromHash);
    return () => window.removeEventListener('hashchange', fromHash);
  }, [load]);

  useEffect(() => {
    if (!moreOpen) return undefined;
    const onPointerDown = (event) => {
      if (moreRef.current && !moreRef.current.contains(event.target)) setMoreOpen(false);
    };
    const onKeyDown = (event) => {
      if (event.key === 'Escape') setMoreOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [moreOpen]);

  if (!meta) {
    return <p className="text-muted-foreground py-10 text-center">从左侧选择一个歌单</p>;
  }

  const handleRemove = async (song) => {
    if (offline) return;
    setNotice('');
    try {
      await removeSongFromCollection(meta.collectionId, song);
      const targetKey = songIdentityKey(song);
      setSongs((s) => s.filter((x) => songIdentityKey(x) !== targetKey));
    } catch {
      setNotice('移除失败,请稍后重试');
    }
  };

  const handleDeleteCollection = async () => {
    if (!canDeleteCollection) return;
    setMoreOpen(false);
    const ok = await feedback.confirm({
      title: `删除歌单「${currentName}」?`,
      body: '只删除歌单记录,不会删除 NAS 曲库里的歌曲文件。',
      confirmLabel: '删除歌单',
      danger: true,
    });
    if (!ok) return;
    setNotice('');
    try {
      await remove(meta.collectionId);
      setMeta(null); setSongs([]);
      feedback.success('歌单已删除');
    } catch {
      setNotice('删除歌单失败,请稍后重试');
      feedback.error('删除歌单失败,请稍后重试');
    }
  };

  const handleDownloadAll = async () => {
    if (!songs.length || offline || bulkDownload.phase === 'running') return;

    setNotice('');
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

    setNotice('');
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

  const bulkDownloadLabel = (() => {
    if (bulkDownload.phase === 'running') return '下载到 NAS';
    if (bulkDownload.phase === 'done') return '已下载到 NAS';
    if (bulkDownload.phase === 'fail') return '重试下载到 NAS';
    return '全部下载到 NAS';
  })();
  const BulkIcon = bulkDownload.phase === 'done' ? Check : bulkDownload.phase === 'fail' ? RotateCw : Download;
  const bulkCacheLabel = (() => {
    if (bulkCache.phase === 'running') return '缓存到本机';
    if (bulkCache.phase === 'done') return '已缓存到本机';
    if (bulkCache.phase === 'fail') return '重试缓存到本机';
    return '全部缓存到本机';
  })();
  const BulkCacheIcon = bulkCache.phase === 'done' ? Check : bulkCache.phase === 'fail' ? RotateCw : HardDriveDownload;
  const hasBulkStatus = bulkDownload.phase !== 'idle' || bulkCache.phase !== 'idle';
  const collectionLabel = collectionKind === 'favorite' ? '我喜欢' : '歌单';
  const rowRemoveTitle = collectionKind === 'favorite' ? '取消喜欢' : '从歌单移除';
  const rowRemoveHint = collectionKind === 'favorite' ? '只从我喜欢里移除' : '只从当前歌单移除';

  return (
    <div>
      <div className="flex flex-col sm:flex-row sm:items-end gap-4 mb-4">
        <PlaylistCover songs={songs} />
        <div className="min-w-0">
          <p className="text-xs uppercase tracking-wider text-muted-foreground">{collectionLabel}</p>
          <h1 className="text-3xl font-black truncate">{currentName}</h1>
          <p className="text-sm text-muted-foreground mt-1">{songs.length} 首</p>
          <div className="flex flex-wrap items-center gap-2 mt-3">
            <button onClick={() => songs.length && play(songs[0], songs)}
              disabled={!songs.length}
              className="flex items-center gap-2 px-5 py-2 rounded-full bg-primary text-primary-foreground font-semibold disabled:opacity-50">
              <Play size={18} fill="currentColor" />播放全部
            </button>
            <button onClick={handleDownloadAll}
              disabled={!songs.length || offline || bulkDownload.phase === 'running'}
              className={`flex items-center gap-2 min-h-10 px-4 py-2 rounded-full font-semibold transition-colors disabled:opacity-50 ${
                bulkDownload.phase === 'done' ? 'bg-primary/10 text-primary'
                : bulkDownload.phase === 'fail' ? 'bg-destructive/10 text-destructive hover:bg-destructive/20'
                : 'bg-secondary text-foreground hover:bg-secondary/80'
              }`}
              title={offline ? '离线状态无法下载到 NAS' : '把当前歌单全部下载到服务器(NAS)'}>
              <BulkIcon size={18} className={bulkDownload.phase === 'running' ? 'animate-pulse' : ''} />
              {bulkDownloadLabel}
            </button>
            <button onClick={handleCacheAll}
              disabled={!songs.length || offline || bulkCache.phase === 'running'}
              className={`flex items-center gap-2 min-h-10 px-4 py-2 rounded-full font-semibold transition-colors disabled:opacity-50 ${
                bulkCache.phase === 'done' ? 'bg-primary/10 text-primary'
                : bulkCache.phase === 'fail' ? 'bg-destructive/10 text-destructive hover:bg-destructive/20'
                : 'bg-secondary text-foreground hover:bg-secondary/80'
              }`}
              title={offline ? '离线状态无法缓存新歌曲' : '把当前歌单全部缓存到当前浏览器/PWA'}>
              <BulkCacheIcon size={18} className={bulkCache.phase === 'running' ? 'animate-pulse' : ''} />
              {bulkCacheLabel}
            </button>
            {canDeleteCollection && (
              <div ref={moreRef} className="relative">
                <button onClick={() => setMoreOpen((open) => !open)}
                  className="flex min-h-10 items-center gap-2 rounded-full px-4 py-2 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                  title="更多操作"
                  aria-label="更多操作"
                  aria-expanded={moreOpen}>
                  <Ellipsis size={18} />更多
                </button>
                {moreOpen && (
                  <div className="absolute right-0 top-full z-40 mt-2 w-48 overflow-hidden rounded-md border border-border bg-card shadow-xl">
                    <button
                      onClick={handleDeleteCollection}
                      className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm text-destructive transition-colors hover:bg-destructive/10"
                    >
                      <Trash2 size={16} className="flex-shrink-0" />
                      <span className="min-w-0">
                        <span className="block font-medium">删除歌单</span>
                        <span className="block truncate text-xs text-muted-foreground">不会删除 NAS 文件</span>
                      </span>
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
      {notice && (
        <div className="mb-4 flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <AlertCircle size={16} />
          <span>{notice}</span>
        </div>
      )}
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
        </div>
      )}
      {loading && <p className="text-muted-foreground">加载中…</p>}
      {!loading && songs.length === 0 && (
        <div className="rounded-md border border-border bg-card/70 px-4 py-5 text-muted-foreground">
          <p>这个歌单还没有歌。</p>
          <button
            onClick={() => { window.location.hash = 'download'; }}
            className="mt-3 rounded-full bg-secondary px-4 py-2 text-sm font-semibold text-foreground hover:bg-secondary/80 transition-colors"
          >
            去找歌
          </button>
        </div>
      )}
      <div className="space-y-0.5">
        {songs.map((song, i) => (
          <SongRow key={songIdentityKey(song)} song={song} index={i}
            isPlaying={isPlaying(song)} onPlay={(s) => play(s, songs)}
            onRemove={handleRemove} removeTitle={rowRemoveTitle} removeHint={rowRemoveHint} />
        ))}
      </div>
    </div>
  );
}
