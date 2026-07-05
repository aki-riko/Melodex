import React, { useState, useEffect } from 'react';
import { useQuery } from 'react-query';
import {
  searchMusic,
  getRecommend,
  getPlaylistDetail,
  getLyric,
  getSearchHistory,
  clearSearchHistory,
  saveToServer,
} from '../services/musicdl';
import {
  AlertCircle,
  Check,
  Download as DownloadIcon,
  HardDriveDownload,
  Loader2,
  ListPlus,
  Music,
  Play,
  RotateCw,
  Search,
  X,
} from 'lucide-react';
import SongRow, { SongListHeader } from './SongRow';
import { usePlayer } from '../contexts/PlayerContext';
import { useAuth } from '../contexts/AuthContext';
import { useCollections } from '../contexts/CollectionsContext';
import { useFeedback } from '../contexts/FeedbackContext';
import { useLiveCheck } from '../hooks/useLiveCheck';
import { useCachedRefresh } from '../hooks/useCachedRefresh';
import { useScopedBulkState } from '../hooks/useScopedBulkState';
import { cacheSong, canCacheSong, isSongCached } from '../services/offlineAudio';
import { songIdentityKey } from '../utils/songIdentity';
import LoadingState from './LoadingState';

const TABS = [
  { key: 'search', label: '歌曲搜索' },
  { key: 'discover', label: '推荐歌单' },
];

const IDLE_BULK_DOWNLOAD = { phase: 'idle', done: 0, fail: 0, total: 0 };
const IDLE_BULK_CACHE = { phase: 'idle', done: 0, fail: 0, skipped: 0, total: 0 };
const IDLE_BULK_COPY = { phase: 'idle', done: 0, fail: 0, total: 0, collectionId: null };

// 搜索结果相关性排序已下沉到后端(/api/v1/search 综合排序:上游名次+翻唱降权+
// 原唱信号),前端默认信任后端返回序,不再本地重算相关性。

const SearchStatusPanel = ({ stage, progress, available, total }) => {
  if (!stage) return null;
  const pct = progress?.total ? Math.round((progress.done / progress.total) * 100) : 0;
  const Icon = stage.icon;
  const loading = !!stage.loading;
  return (
    <div className={`mb-4 rounded-md border px-4 py-3 ${
      stage.tone === 'error'
        ? 'border-destructive/40 bg-destructive/10 text-destructive'
        : stage.tone === 'success'
          ? 'border-primary/30 bg-primary/10 text-primary'
          : 'border-border bg-card/70 text-muted-foreground'
    }`}>
      <div className="flex items-start gap-3">
        <div className={`mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full ${
          loading ? 'bg-primary/10 text-primary' : ''
        }`}>
          <Icon size={18} className={loading ? 'animate-spin' : ''} />
        </div>
        <div className="min-w-0 flex-grow">
          <p className="font-medium text-foreground">
            {stage.title}
            {loading ? <span className="loading-dots" aria-hidden="true" /> : null}
          </p>
          <p className="mt-0.5 text-sm">{stage.detail}</p>
          {(loading || progress?.total > 0) && (
            <div className="mt-3">
              <div className={`h-1.5 overflow-hidden rounded-full bg-secondary ${
                progress?.total > 0 ? '' : 'loading-bar-indeterminate'
              }`}>
                {progress?.total > 0 && (
                  <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${pct}%` }} />
                )}
              </div>
              {progress?.total > 0 ? (
                <p className="mt-1 text-xs">
                  已检查 {progress.done}/{progress.total}
                  {available != null ? ` · 当前可播放 ${available}` : ''}
                  {total != null ? ` · 原始结果 ${total}` : ''}
                </p>
              ) : (
                <p className="mt-1 text-xs">连接音乐源中,页面仍在工作</p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

const CacheRefreshNotice = ({ data, className = '' }) => {
  if (!data?.cached || !data?.refreshing) return null;
  return (
    <div className={`mb-4 inline-flex items-center gap-2 rounded-md border border-border bg-card/70 px-3 py-2 text-sm text-muted-foreground ${className}`}>
      <Loader2 size={15} className="animate-spin text-primary" />
      <span>正在后台更新缓存，当前先显示上次结果</span>
    </div>
  );
};

// 歌曲搜索面板
const SearchPane = ({ keyword, setKeyword, onSubmit, runSearch, query, state, onPlay, onTogglePlayback, onShowLyric, isPlaying, isPaused }) => {
  const allSongs = state.data?.songs || [];
  const feedback = useFeedback();
  // 自动验活:并发探测真实可用性,死链隐藏,存活的带上真实 size/bitrate
  const { status, progress } = useLiveCheck(allSongs);

  // 搜索历史(仅登录用户有;未登录返回空)。搜索成功后刷新。
  const history = useQuery(['search-history'], getSearchHistory, {
    refetchOnWindowFocus: false,
    staleTime: 60 * 1000,
  });
  useEffect(() => {
    if (query) history.refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);
  const [historyNotice, setHistoryNotice] = useState('');

  const onChipSearch = (kw) => {
    if (runSearch) runSearch(kw);
  };
  const onChipDelete = async (kw, e) => {
    e.stopPropagation();
    setHistoryNotice('');
    try {
      await clearSearchHistory(kw);
      history.refetch();
    } catch {
      setHistoryNotice('搜索历史删除失败,稍后再试');
      feedback.error('搜索历史删除失败,稍后再试');
    }
  };
  const onClearAll = async () => {
    setHistoryNotice('');
    const ok = await feedback.confirm({
      title: '清空最近搜索?',
      body: '只清空当前账号的搜索记录,不会影响歌单或曲库。',
      confirmLabel: '清空',
      danger: true,
    });
    if (!ok) return;
    try {
      await clearSearchHistory();
      history.refetch();
      feedback.success('最近搜索已清空');
    } catch {
      setHistoryNotice('搜索历史清空失败,稍后再试');
      feedback.error('搜索历史清空失败,稍后再试');
    }
  };
  const historyItems = history.data || [];
  const [sortMode, setSortMode] = useState('recommended');
  const SORT_PRESETS = {
    recommended: { field: 'relevance', order: 'desc', label: '推荐排序', hint: '优先匹配原唱和来源顺序' },
    quality: { field: 'quality', order: 'desc', label: '高音质优先', hint: '按真实码率靠前' },
    compact: { field: 'size', order: 'asc', label: '文件更小', hint: '适合省空间和流量' },
  };

  // 只保留已验活为 ok 的(验活中/未验先不显示,死链永久隐藏)
  const liveSongs = allSongs.filter((s) => status[songIdentityKey(s)]?.state === 'ok');
  const originalIndex = new Map(allSongs.map((s, i) => [songIdentityKey(s), i]));

  // 各排序维度的取值
  const fieldValue = (s, field) => {
    const live = status[songIdentityKey(s)];
    if (field === 'size') return live?.sizeBytes || s.size || 0;
    if (field === 'quality') return live?.bitrateNum || 0;
    // 相关性:信任后端综合排序(上游名次+翻唱降权+原唱信号,前端看不到这些),
    // 用返回序的相反数(origIdx 越小越靠前)。不再前端重算 relevanceScore。
    if (field === 'relevance') return -(originalIndex.get(songIdentityKey(s)) ?? 0);
    return originalIndex.get(songIdentityKey(s)) ?? 0;
  };

  // 默认给用户三种稳定排序:推荐 / 高音质 / 文件更小。
  const songs = liveSongs
    .map((s, i) => ({ s, i }))
    .sort((a, b) => {
      const preset = SORT_PRESETS[sortMode] || SORT_PRESETS.recommended;
      const cmp = fieldValue(a.s, preset.field) - fieldValue(b.s, preset.field);
      if (cmp !== 0) return preset.order === 'asc' ? cmp : -cmp;
      // 排序键全相等(如同名"炽心"相关性同分)时,隐式按真实音质降序——
      // 正版通常有无损会靠前;音质相同再回退原序。
      if (preset.field !== 'quality') {
        const qa = status[songIdentityKey(a.s)]?.bitrateNum || 0;
        const qb = status[songIdentityKey(b.s)]?.bitrateNum || 0;
        if (qa !== qb) return qb - qa;
      }
      return a.i - b.i;
    })
    .map((x) => x.s);

  const sortBtnCls = (mode) =>
    `rounded-md border px-3 py-2 text-left transition-colors ${
      sortMode === mode ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-card hover:bg-secondary'
    }`;

  const checking = progress.total > 0 && progress.done < progress.total;
  const searchStage = (() => {
    if (!query && !state.isLoading) return null;
    if (state.isLoading) {
      return {
        title: `正在搜索「${query}」`,
        detail: '正在从多个音乐源拉取候选结果。',
        icon: Loader2,
        loading: true,
      };
    }
    if (state.isError) {
      return {
        title: '搜索失败',
        detail: String(state.error?.message || state.error || '请稍后再试'),
        icon: AlertCircle,
        tone: 'error',
      };
    }
    if (state.data?.error) {
      return {
        title: '搜索返回错误',
        detail: state.data.error,
        icon: AlertCircle,
        tone: 'error',
      };
    }
    if (checking) {
      return {
        title: '正在筛选可播放结果',
        detail: '候选歌曲会逐首检查,不可播放或受限结果会被自动隐藏。',
        icon: Loader2,
        loading: true,
      };
    }
    if (progress.total > 0 && songs.length > 0) {
      return {
        title: '已筛出可播放歌曲',
        detail: `当前有 ${songs.length} 首可以直接播放或保存。`,
        icon: Check,
        tone: 'success',
      };
    }
    if (progress.total > 0 && songs.length === 0) {
      return {
        title: '没有可播放的结果',
        detail: '这些结果可能暂时不可用,也可能受版权或会员权限限制。',
        icon: AlertCircle,
      };
    }
    if (query && progress.total === 0) {
      return {
        title: '没有找到结果',
        detail: '可以换成“歌手 歌名”,或粘贴歌曲/歌单链接再试。',
        icon: Search,
      };
    }
    return null;
  })();

  return (
    <div>
      <form onSubmit={onSubmit} className="flex gap-2 mb-6">
        <input
          type="text"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          placeholder="输入歌名 / 歌手,或粘贴链接…"
          className="flex-grow rounded-md border border-border bg-card px-4 py-3 font-medium outline-none transition-colors focus:border-primary"
        />
        <button type="submit" className="rounded-md bg-primary px-6 py-3 font-semibold text-primary-foreground transition-colors hover:brightness-110">
          搜索
        </button>
      </form>
      {/* 最近搜索:仅在未发起搜索时显示(登录用户专属,匿名为空不显示) */}
      {!query && historyItems.length > 0 && (
        <div className="mb-6">
          <div className="flex items-center gap-2 mb-2">
            <span className="text-sm text-muted-foreground">最近搜索</span>
            <button onClick={onClearAll} className="text-xs text-muted-foreground hover:text-destructive transition-colors">
              清空
            </button>
          </div>
          <div className="flex flex-wrap gap-2">
            {historyItems.map((h) => (
              <span
                key={h.keyword}
                onClick={() => onChipSearch(h.keyword)}
                className="group inline-flex items-center gap-1 pl-3 pr-1.5 py-1.5 border border-border rounded-full bg-card text-sm cursor-pointer hover:bg-secondary transition-colors"
                title={`搜索「${h.keyword}」`}
              >
                {h.keyword}
                <button
                  onClick={(e) => onChipDelete(h.keyword, e)}
                  className="p-0.5 rounded-full text-muted-foreground hover:text-destructive hover:bg-background transition-colors"
                  title="删除"
                  aria-label="删除"
                >
                  <X size={13} />
                </button>
              </span>
            ))}
          </div>
        </div>
      )}
      {historyNotice && (
        <p className="mb-4 text-sm text-destructive">{historyNotice}</p>
      )}
      <CacheRefreshNotice data={state.data} />
      <SearchStatusPanel stage={searchStage} progress={progress} available={songs.length} total={allSongs.length} />
      {songs.length > 0 && (
        <div className="mb-4 flex flex-wrap items-stretch gap-2">
          {Object.entries(SORT_PRESETS).map(([mode, preset]) => (
            <button key={mode} onClick={() => setSortMode(mode)} className={sortBtnCls(mode)}>
              <span className="block text-sm font-semibold">{preset.label}</span>
              <span className={`block text-xs ${sortMode === mode ? 'text-primary-foreground/75' : 'text-muted-foreground'}`}>{preset.hint}</span>
            </button>
          ))}
        </div>
      )}
      <SongListHeader />
      <div className="space-y-0.5 pb-32">
        {songs.map((song, idx) => (
          <SongRow
            key={songIdentityKey(song)}
            song={song}
            index={idx}
            isPlaying={isPlaying(song)}
            isPaused={isPaused}
            onTogglePlayback={onTogglePlayback}
            onPlay={(s) => onPlay(s, songs)}
            onShowLyric={onShowLyric}
            liveInfo={status[songIdentityKey(song)]}
          />
        ))}
      </div>
    </div>
  );
};

// 歌词弹窗
const LyricModal = ({ lyric, onClose }) => (
  <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={onClose}>
    <div className="bg-card border border-border rounded-lg shadow-xl max-w-lg w-full max-h-[70vh] overflow-y-auto p-6" onClick={(e) => e.stopPropagation()}>
      <div className="flex justify-between items-start mb-4">
        <div>
          <h3 className="text-xl font-semibold">{lyric.song.name}</h3>
          <p className="text-muted-foreground text-sm">{lyric.song.artist}</p>
        </div>
        <button onClick={onClose} className="font-bold text-2xl leading-none hover:text-primary transition-colors">×</button>
      </div>
      <pre className="whitespace-pre-wrap text-foreground text-sm font-sans">{lyric.text}</pre>
    </div>
  </div>
);

// 推荐歌单面板(按源分栏的网格)
const DiscoverPane = ({ state, onOpen }) => {
  if (state.isLoading) {
    return (
      <LoadingState
        title="加载推荐歌单"
        detail="正在从网易云和 QQ 拉取推荐内容"
        rows={6}
        className="mb-6"
      />
    );
  }
  if (state.isError) return <p className="text-destructive font-bold">加载失败:{String(state.error?.message || state.error)}</p>;
  const tabs = state.data?.tabs || [];
  return (
    <div className="space-y-8 pb-32">
      <CacheRefreshNotice data={state.data} />
      {tabs.map((tab) => (
        <div key={tab.source}>
          <h3 className="text-lg font-semibold mb-3 pl-2 border-l-4 border-primary text-foreground">{tab.source_name || tab.source}</h3>
          {tab.error && <p className="text-destructive font-bold text-sm mb-2">{tab.error}</p>}
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-4 mt-3">
            {(tab.playlists || []).map((pl) => (
              <div
                key={`${pl.source}-${pl.id}`}
                className="cursor-pointer group rounded-md border border-border bg-card p-2 transition-colors hover:bg-secondary"
                onClick={() => onOpen({ id: pl.id, source: pl.source, name: pl.name })}
              >
                <div className="aspect-square overflow-hidden rounded bg-muted">
                  {pl.cover && (
                    <img src={pl.cover} alt={pl.name} loading="lazy" className="w-full h-full object-cover" />
                  )}
                </div>
                <p className="text-sm font-bold mt-2 line-clamp-2">{pl.name}</p>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
};

const playlistBulkLabel = (state, idleLabel, runningLabel, doneLabel, retryLabel) => {
  if (state.phase === 'running') return runningLabel;
  if (state.phase === 'done') return doneLabel;
  if (state.phase === 'fail') return retryLabel;
  return idleLabel;
};

const BulkStatusCard = ({ title, state, cache }) => {
  if (state.phase === 'idle') return null;
  return (
    <div className={`rounded-md border px-3 py-2 text-sm ${
      state.phase === 'fail' ? 'border-destructive/40 bg-destructive/10 text-destructive' : 'border-border bg-card/70 text-muted-foreground'
    }`}>
      <p className="font-medium text-foreground">{title}</p>
      <p>
        {cache ? `新增 ${state.done}` : `已完成 ${state.done}/${state.total}`}
        {cache && state.skipped ? ` · 已有 ${state.skipped}` : ''}
        {cache && state.total ? ` · 共 ${state.total}` : ''}
        {state.fail ? ` · 失败 ${state.fail}` : ''}
      </p>
    </div>
  );
};

// 歌单详情面板
const PlaylistDetailPane = ({ meta, state, onBack, onPlay, onTogglePlayback, onShowLyric, isPlaying, isPaused }) => {
  const songs = state.data?.songs || [];
  const { user, offline } = useAuth();
  const { create, addSong } = useCollections();
  const feedback = useFeedback();
  const userId = user?.id || 0;
  const taskKey = `${meta.source}:${meta.id}`;
  const downloadTasks = useScopedBulkState(IDLE_BULK_DOWNLOAD, 'recommended-playlist-download');
  const cacheTasks = useScopedBulkState(IDLE_BULK_CACHE, 'recommended-playlist-cache');
  const copyTasks = useScopedBulkState(IDLE_BULK_COPY, 'recommended-playlist-copy');
  const bulkDownload = downloadTasks.getState(taskKey);
  const bulkCache = cacheTasks.getState(taskKey);
  const bulkCopy = copyTasks.getState(taskKey);

  const handleDownloadAll = async () => {
    if (!songs.length || offline || bulkDownload.phase === 'running') return;
    const playlistSongs = songs.slice();
    const total = playlistSongs.length;
    let done = 0;
    let fail = 0;
    await downloadTasks.runForKey(taskKey, { phase: 'running', done, fail, total }, async (update) => {
      for (const song of playlistSongs) {
        try {
          const result = await saveToServer(song);
          if (result?.saved) done += 1;
          else fail += 1;
        } catch {
          fail += 1;
        }
        update({ phase: 'running', done, fail, total });
      }
      update({ phase: fail ? 'fail' : 'done', done, fail, total });
    });
  };

  const handleCacheAll = async () => {
    if (!songs.length || offline || bulkCache.phase === 'running') return;
    const playlistSongs = songs.slice();
    const total = playlistSongs.length;
    let done = 0;
    let fail = 0;
    let skipped = 0;
    await cacheTasks.runForKey(taskKey, { phase: 'running', done, fail, skipped, total }, async (update) => {
      for (const song of playlistSongs) {
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
    });
  };

  const handleCopyToMine = async () => {
    if (!songs.length || offline || bulkCopy.phase === 'running') return;
    const playlistSongs = songs.slice();
    const total = playlistSongs.length;
    let done = 0;
    let fail = 0;
    await copyTasks.runForKey(taskKey, { phase: 'running', done, fail, total, collectionId: null }, async (update) => {
      try {
        const collection = await create(meta.name || '推荐歌单');
        const collectionId = collection?.id;
        if (collectionId == null) throw new Error('collection id missing');
        for (const song of playlistSongs) {
          try {
            await addSong(collectionId, song);
            done += 1;
          } catch {
            fail += 1;
          }
          update({ phase: 'running', done, fail, total, collectionId });
        }
        update({ phase: fail ? 'fail' : 'done', done, fail, total, collectionId });
        if (fail) feedback.error(`已创建歌单,但 ${fail} 首加入失败`);
        else feedback.success('已加入我的歌单');
      } catch {
        update({ phase: 'fail', done, fail: total || 1, total, collectionId: null });
        feedback.error('加入我的歌单失败,请稍后重试');
      }
    });
  };

  const downloadLabel = playlistBulkLabel(bulkDownload, '下载到 NAS', '下载到 NAS', '已下载到 NAS', '重试下载到 NAS');
  const cacheLabel = playlistBulkLabel(bulkCache, '缓存到本机', '缓存到本机', '已缓存到本机', '重试缓存到本机');
  const copyLabel = playlistBulkLabel(bulkCopy, '加入我的歌单', '加入我的歌单', '已加入我的歌单', '重试加入歌单');
  const DownloadBulkIcon = bulkDownload.phase === 'done' ? Check : bulkDownload.phase === 'fail' ? RotateCw : DownloadIcon;
  const CacheBulkIcon = bulkCache.phase === 'done' ? Check : bulkCache.phase === 'fail' ? RotateCw : HardDriveDownload;
  const CopyBulkIcon = bulkCopy.phase === 'done' ? Check : bulkCopy.phase === 'fail' ? RotateCw : ListPlus;
  const hasBulkStatus = bulkDownload.phase !== 'idle' || bulkCache.phase !== 'idle' || bulkCopy.phase !== 'idle';

  return (
    <div className="pb-32">
      <button onClick={onBack} className="mb-4 rounded-full bg-secondary px-3 py-1.5 text-sm font-semibold text-foreground transition-colors hover:bg-secondary/80">← 返回推荐歌单</button>
      <div className="mb-4 flex flex-col gap-4 sm:flex-row sm:items-end">
        <div className="flex h-32 w-32 flex-shrink-0 items-center justify-center rounded-lg bg-secondary">
          <Music size={42} className="text-muted-foreground" />
        </div>
        <div className="min-w-0">
          <p className="text-xs uppercase tracking-wider text-muted-foreground">推荐歌单</p>
          <h3 className="truncate text-3xl font-black">{meta.name}</h3>
          <p className="mt-1 text-sm text-muted-foreground">{songs.length} 首</p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button onClick={() => songs.length && onPlay(songs[0], songs)}
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
              <DownloadBulkIcon size={18} className={bulkDownload.phase === 'running' ? 'animate-pulse' : ''} />
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
              <CacheBulkIcon size={18} className={bulkCache.phase === 'running' ? 'animate-pulse' : ''} />
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
              <CopyBulkIcon size={18} className={bulkCopy.phase === 'running' ? 'animate-pulse' : ''} />
              {copyLabel}
            </button>
          </div>
        </div>
      </div>
      {state.isLoading && (
        <LoadingState
          title="加载歌单"
          detail="正在读取歌单歌曲和封面信息"
          rows={6}
          className="mb-4"
        />
      )}
      {state.data?.error && <p className="text-destructive font-bold mb-4">{state.data.error}</p>}
      <CacheRefreshNotice data={state.data} />
      {hasBulkStatus && (
        <div className="mb-4 grid gap-2 sm:grid-cols-2">
          <BulkStatusCard title="NAS 下载" state={bulkDownload} />
          <BulkStatusCard title="本机缓存" state={bulkCache} cache />
          <BulkStatusCard title="加入我的歌单" state={bulkCopy} />
        </div>
      )}
      {!state.isLoading && (
        <>
          <SongListHeader />
          <div className="space-y-0.5">
            {songs.map((song, idx) => (
              <SongRow
                key={`${song.source}-${song.id}-${idx}`}
                song={song}
                index={idx}
                isPlaying={isPlaying(song)}
                isPaused={isPaused}
                onTogglePlayback={onTogglePlayback}
                onPlay={(s) => onPlay(s, songs)}
                onShowLyric={onShowLyric}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
};

const Download = ({ downloadRequest }) => {
  const { play, isPlaying, isPaused, togglePlay } = usePlayer();
  const [tab, setTab] = useState('search');
  const [keyword, setKeyword] = useState('');
  const [query, setQuery] = useState('');
  const [openPlaylist, setOpenPlaylist] = useState(null); // {id, source, name}
  const [lyric, setLyric] = useState(null); // {song, text}

  // 来自发现页「在国内源下载」的预填搜索词:切到搜索 Tab 并自动搜索。
  // 依赖 ts,保证重复点同一首歌也能再次触发。
  useEffect(() => {
    const kw = downloadRequest?.keyword;
    if (kw) {
      setTab('search');
      setOpenPlaylist(null);
      setKeyword(kw);
      setQuery(kw);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [downloadRequest?.ts]);

  // 歌曲搜索
  const search = useQuery(
    ['musicdl-search', query],
    () => searchMusic(query, { type: 'song' }),
    {
      enabled: tab === 'search' && !!query,
      keepPreviousData: true,
      // 失焦/重新聚焦不自动重搜(否则切窗口回来会重新搜索+重新验活)
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      staleTime: 5 * 60 * 1000,
    }
  );
  useCachedRefresh(search, tab === 'search' && !!query);

  // 推荐歌单(默认网易云 + QQ)
  const recommend = useQuery(
    ['musicdl-recommend'],
    () => getRecommend(['netease', 'qq']),
    { enabled: tab === 'discover', refetchOnWindowFocus: false, staleTime: 5 * 60 * 1000 }
  );
  useCachedRefresh(recommend, tab === 'discover');

  // 歌单详情
  const playlistDetail = useQuery(
    ['musicdl-playlist', openPlaylist?.id, openPlaylist?.source],
    () => getPlaylistDetail(openPlaylist.id, openPlaylist.source),
    { enabled: !!openPlaylist, refetchOnWindowFocus: false, staleTime: 5 * 60 * 1000 }
  );
  useCachedRefresh(playlistDetail, !!openPlaylist);

  const handleSearch = (e) => {
    e.preventDefault();
    const k = keyword.trim();
    if (k) setQuery(k);
  };

  // 供搜索历史 chips 点击:同时回填输入框并触发搜索。
  const runSearch = (kw) => {
    const k = (kw || '').trim();
    if (!k) return;
    setKeyword(k);
    setQuery(k);
  };

  const handlePlay = (song, list) => play(song, list);

  const handleShowLyric = async (song) => {
    setLyric({ song, text: '加载中…' });
    try {
      const text = await getLyric(song);
      setLyric({ song, text: text || '无歌词' });
    } catch (e) {
      setLyric({ song, text: '歌词加载失败' });
    }
  };

  return (
    <div className="max-w-5xl mx-auto">
      <h2 className="text-3xl font-semibold mb-2 text-foreground">下载 <span className="text-primary">· Download</span></h2>
      <p className="text-muted-foreground mb-4 mt-3">
        从国内多源(网易云 / QQ / 酷狗 / 酷我 / 咪咕 / 汽水 等)搜索并下载,支持粘贴歌曲/歌单链接。
      </p>

      <div className="flex gap-2 mb-6">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => {
              setTab(t.key);
              setOpenPlaylist(null);
            }}
            className={`rounded-full px-4 py-2 text-sm font-semibold transition-colors ${
              tab === t.key
                ? 'bg-primary text-primary-foreground'
                : 'bg-card text-muted-foreground hover:bg-secondary hover:text-foreground'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'search' && (
        <SearchPane
          keyword={keyword}
          setKeyword={setKeyword}
          onSubmit={handleSearch}
          runSearch={runSearch}
          query={query}
          state={search}
          onPlay={handlePlay}
          onTogglePlayback={togglePlay}
          onShowLyric={handleShowLyric}
          isPlaying={isPlaying}
          isPaused={isPaused}
        />
      )}

      {tab === 'discover' && !openPlaylist && (
        <DiscoverPane state={recommend} onOpen={setOpenPlaylist} />
      )}

      {tab === 'discover' && openPlaylist && (
        <PlaylistDetailPane
          meta={openPlaylist}
          state={playlistDetail}
          onBack={() => setOpenPlaylist(null)}
          onPlay={handlePlay}
          onTogglePlayback={togglePlay}
          onShowLyric={handleShowLyric}
          isPlaying={isPlaying}
          isPaused={isPaused}
        />
      )}

      {lyric && <LyricModal lyric={lyric} onClose={() => setLyric(null)} />}
    </div>
  );
};

export default Download;
