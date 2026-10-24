import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useQuery, useQueryClient } from 'react-query';
import {
  searchMusic,
  getRecommend,
  getPlaylistDetail,
  getAlbumDetail,
  getLyric,
  getSearchHistory,
  clearSearchHistory,
  clearSearchCache,
  coverProxyUrl,
  recognizeAudio,
  getRecognitionStatus,
} from '../services/musicdl';
import {
  Compass,
  Mic,
  Music,
  Play,
  RotateCw,
  Search,
  Square,
  X,
} from 'lucide-react';
import SongRow, { SongListHeader } from './SongRow';
import SearchAlbumRow from './SearchAlbumRow';
import { usePlayer } from '../contexts/PlayerContext';
import { useAuth } from '../contexts/AuthContext';
import { useFeedback } from '../contexts/FeedbackContext';
import { useCachedRefresh } from '../hooks/useCachedRefresh';
import { useBulkActions } from '../hooks/useBulkActions';
import { songIdentityKey } from '../utils/songIdentity';
import { sourceLabel } from '../utils/sourceLabels';
import Button from '../ui/Button';
import { Input } from '../ui/Input';
import { PageHeader, SectionHeader } from '../ui/Card';
import Segmented from '../ui/Segmented';
import StatusLine from '../ui/StatusLine';
import ScrollRow from '../ui/ScrollRow';
import EmptyState from '../ui/EmptyState';
import Dialog from '../ui/Dialog';
import LoadingState from './LoadingState';
import { cn } from '../ui/cn';

// ===== 搜索/推荐双视图 =====
const TABS = [
  { key: 'search', label: '搜索下载', icon: Search },
  { key: 'discover', label: '推荐歌单', icon: Compass },
];

const COMBINED_SEARCH_RESULT_LIMIT = 80;
const SEARCH_LINK_RE = /^(https?:\/\/|www\.)/i;
const RECOGNITION_RECORD_MS = 10000;
const RECOGNITION_MIME_TYPES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/ogg',
  'audio/mp4',
];

const searchQueryKey = (keyword) => ['musicdl-search', 'combined', keyword];

const compactSearchText = (value) => String(value || '').replace(/[\s/\\|,，.。;；:：!！?？、'"“”‘’《》<>()[\]【】{}-]+/g, '').toLocaleLowerCase();

const hasExactLyricHit = (song, query) => {
  const q = compactSearchText(query);
  if (q.length < 5) return false;
  const match = song?.extra && typeof song.extra === 'object' ? song.extra.lyric_match : '';
  return compactSearchText(match).includes(q);
};

const textOr = (primary, fallback) => {
  const text = String(primary ?? '').trim();
  return text || String(fallback ?? '').trim();
};

const numberOr = (primary, fallback) => {
  const value = Number(primary || 0);
  return value > 0 ? value : (Number(fallback || 0) || 0);
};

const mergeSongData = (base, incoming) => ({
  ...incoming,
  ...base,
  name: textOr(base?.name, incoming?.name),
  artist: textOr(base?.artist, incoming?.artist),
  album: textOr(base?.album, incoming?.album),
  album_id: textOr(base?.album_id, incoming?.album_id),
  cover: textOr(base?.cover, incoming?.cover),
  link: textOr(base?.link, incoming?.link),
  ext: textOr(base?.ext, incoming?.ext),
  duration: numberOr(base?.duration, incoming?.duration),
  size: numberOr(base?.size, incoming?.size),
  bitrate: numberOr(base?.bitrate, incoming?.bitrate),
  is_vip: Boolean(base?.is_vip || incoming?.is_vip),
  extra: {
    ...(incoming?.extra || {}),
    ...(base?.extra || {}),
    lyric_match: (base?.extra?.lyric_match || incoming?.extra?.lyric_match || ''),
  },
});

const artistParts = (artist) => String(artist || '')
  .split(/[、,，/&\s-]+/)
  .map(compactSearchText)
  .filter((part) => part.length >= 2);

const combinedSearchKey = (song) => {
  const source = String(song?.source || '').trim();
  const id = String(song?.id || '').trim();
  if (source && id) return `${source}:${id}`;
  const title = compactSearchText(song?.name);
  const artist = compactSearchText(song?.artist);
  const duration = song?.duration || '';
  return title ? `${source}:${title}:${artist}:${duration}` : songIdentityKey(song);
};

const pickRecognitionMimeType = () => {
  if (typeof window === 'undefined' || typeof window.MediaRecorder === 'undefined') return '';
  return RECOGNITION_MIME_TYPES.find((type) => window.MediaRecorder.isTypeSupported(type)) || '';
};

const recognitionErrorMessage = (err) => (
  err?.response?.data?.error || err?.message || '听歌识曲失败,请稍后再试'
);

const formatRecognitionBytes = (bytes) => {
  const value = Number(bytes || 0);
  if (!Number.isFinite(value) || value <= 0) return '';
  if (value >= 1024 * 1024) return `${Math.round(value / 1024 / 1024)} MB`;
  if (value >= 1024) return `${Math.round(value / 1024)} KB`;
  return `${value} B`;
};

const hasTitleArtistHit = (song, query) => {
  const q = compactSearchText(query);
  const title = compactSearchText(song?.name);
  if (!q || title.length < 2 || !q.includes(title)) return false;
  const artists = artistParts(song?.artist);
  return artists.length === 0 || artists.some((artist) => q.includes(artist));
};

const mergeSearchSongs = (query, songSongs = [], lyricSongs = []) => {
  const lyricFirst = lyricSongs.some((song) => hasExactLyricHit(song, query));
  const orderedGroups = lyricFirst ? [lyricSongs, songSongs] : [songSongs, lyricSongs];
  const byKey = new Map();
  const merged = [];

  const appendSong = (song) => {
    const key = combinedSearchKey(song);
    if (!key) return;
    const existing = byKey.get(key);
    if (existing) {
      byKey.set(key, mergeSongData(existing, song));
      return;
    }
    byKey.set(key, song);
    merged.push(key);
  };

  const appendGroup = (group, predicate = null) => {
    group.forEach((song) => {
      if (!predicate || predicate(song)) appendSong(song);
    });
  };

  if (!lyricFirst) {
    orderedGroups.forEach((group) => appendGroup(group, (song) => hasTitleArtistHit(song, query)));
  }
  orderedGroups.forEach((group) => appendGroup(group));

  return merged.map((key) => byKey.get(key));
};

const PENDING_REFETCH_DELAY_MS = 25000;
const PENDING_REFETCH_MAX = 6;

const searchSongsLyricsAndAlbums = async (keyword) => {
  const query = keyword.trim();
  const isLink = SEARCH_LINK_RE.test(query);
  const requests = [
    ['song', searchMusic(query, { type: 'song', skipWarm: true })],
    ...(isLink ? [] : [
      ['lyric', searchMusic(query, { type: 'lyric', skipWarm: true })],
      ['album', searchMusic(query, { type: 'album', skipWarm: true })],
    ]),
  ];
  const results = await Promise.allSettled(requests.map(([, request]) => request));
  const resultByType = Object.fromEntries(requests.map(([type], index) => [type, results[index]]));
  const dataFor = (type) => (
    resultByType[type]?.status === 'fulfilled' ? resultByType[type].value : null
  );
  const songData = dataFor('song');
  const lyricData = dataFor('lyric');
  const albumData = dataFor('album');
  const failures = results
    .filter((result) => result.status === 'rejected')
    .map((result) => result.reason?.message || String(result.reason));

  if (!songData && !lyricData && !albumData) {
    throw new Error(failures[0] || '搜索失败');
  }

  const songs = mergeSearchSongs(query, songData?.songs || [], lyricData?.songs || []).slice(0, COMBINED_SEARCH_RESULT_LIMIT);
  const albums = albumData?.playlists || [];
  const hasResults = songs.length > 0 || albums.length > 0;

  // 歌曲链路的失败必须单独记账,不能被专辑的成功掩盖。
  // 专辑只查 5 个较快的源、歌曲要查 7 个;两条链路快慢差一个量级,
  // 歌曲超时而专辑成功是常见组合 —— 此前错误被 hasResults 清空,界面照旧报成功。
  const songRequestsFailed = !songData && !lyricData;
  const songsError = songData?.error
    || lyricData?.error
    || (songRequestsFailed ? (failures[0] || '歌曲搜索失败') : '');

  return {
    ...(songData || lyricData || albumData || {}),
    type: 'combined',
    keyword: query,
    songs,
    albums,
    playlists: songData?.playlists || [],
    cached: !!(songData?.cached || lyricData?.cached || albumData?.cached),
    refreshing: !!(songData?.refreshing || lyricData?.refreshing || albumData?.refreshing),
    cached_at: songData?.cached_at || lyricData?.cached_at || albumData?.cached_at,
    pending_sources: [...new Set([...(songData?.pending_sources || []), ...(lyricData?.pending_sources || [])])],
    error: hasResults ? '' : (songData?.error || lyricData?.error || albumData?.error || failures[0] || ''),
    songsError: songs.length === 0 ? songsError : '',
  };
};

const SORT_OPTIONS = [
  { value: 'recommended', label: '推荐', hint: '优先匹配原唱与来源顺序' },
  { value: 'quality', label: '高音质', hint: '按搜索返回音质预估' },
  { value: 'compact', label: '小文件', hint: '适合省空间和流量' },
];

const SORT_PRESETS = {
  recommended: { field: 'relevance', order: 'desc' },
  quality: { field: 'quality', order: 'desc' },
  compact: { field: 'size', order: 'asc' },
};

// ===== 最近搜索 =====
const RecentSearches = ({ items, onPick, onDelete, onClearAll }) => {
  if (!items.length) return null;
  return (
    <section className="mb-5">
      <SectionHeader
        title="最近搜索"
        actions={(
          <Button variant="link" size="sm" onClick={onClearAll}>清空</Button>
        )}
      />
      <div className="flex flex-wrap gap-1.5">
        {items.map((h) => (
          <span key={h.keyword} className="group inline-flex items-center overflow-hidden rounded-full border border-border bg-card">
            <button
              type="button"
              onClick={() => onPick(h.keyword)}
              title={`搜索「${h.keyword}」`}
              className="min-h-touch pl-3 pr-1 type-caption text-foreground transition-colors duration-base hover:text-primary"
            >
              {h.keyword}
            </button>
            <button
              type="button"
              onClick={(e) => onDelete(h.keyword, e)}
              aria-label={`删除搜索记录「${h.keyword}」`}
              className="flex min-h-touch w-8 items-center justify-center text-muted-foreground transition-colors duration-base hover:text-destructive"
            >
              <X size={13} />
            </button>
          </span>
        ))}
      </div>
    </section>
  );
};

// ===== 推荐歌单 =====
const PlaylistCard = ({ playlist, onOpen }) => {
  const [failed, setFailed] = useState(false);
  const cover = failed ? '' : coverProxyUrl(playlist);
  return (
    <button
      type="button"
      onClick={() => onOpen({ id: playlist.id, source: playlist.source, name: playlist.name })}
      className="group w-[8.5rem] rounded-lg border border-transparent p-1.5 text-left transition-colors duration-base hover:border-border hover:bg-secondary/60 focus-visible:border-border focus-visible:bg-secondary/60"
      title={`打开歌单「${playlist.name}」`}
    >
      <div className="aspect-square overflow-hidden rounded-md bg-secondary">
        {cover ? (
          <img
            src={cover}
            alt=""
            loading="lazy"
            className="h-full w-full object-cover transition-transform duration-slow ease-standard group-hover:scale-[1.03]"
            onError={() => setFailed(true)}
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-muted-foreground">
            <Music size={28} />
          </div>
        )}
      </div>
      <p className="mt-1.5 line-clamp-2 type-caption font-semibold leading-snug text-foreground">
        {playlist.name}
      </p>
    </button>
  );
};

const DiscoverPane = ({ state, onOpen, onRetry }) => {
  if (state.isLoading && !state.data) {
    return <LoadingState title="加载推荐歌单" detail="正在从网易云和 QQ 拉取推荐内容" rows={3} />;
  }
  if (state.isError) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-4">
        <StatusLine tone="error" layout="banner">
          加载推荐歌单失败:{String(state.error?.message || state.error)}
        </StatusLine>
        <Button variant="secondary" size="sm" className="mt-3" onClick={onRetry} loading={state.isFetching}>
          重试
        </Button>
      </div>
    );
  }

  const tabs = state.data?.tabs || [];
  const visibleTabs = tabs.filter((tab) => (tab.playlists || []).length > 0 || tab.error);

  if (!visibleTabs.length) {
    return (
      <EmptyState
        icon={Compass}
        title="暂时没有推荐歌单"
        description="上游源可能繁忙或需要登录。稍后重试,或先去「搜索下载」找歌。"
        action={<Button variant="secondary" onClick={onRetry} loading={state.isFetching}>重新加载</Button>}
      />
    );
  }

  return (
    <div className="space-y-6">
      {state.data?.cached && state.data?.refreshing && (
        <StatusLine tone="neutral" loading>
          正在后台更新缓存,先显示上次结果
        </StatusLine>
      )}
      {visibleTabs.map((tab) => (
        <section key={tab.source} aria-labelledby={`discover-${tab.source}`}>
          <SectionHeader
            id={`discover-${tab.source}`}
            title={tab.source_name || tab.source}
            count={(tab.playlists || []).length ? `${(tab.playlists || []).length} 张` : undefined}
          />
          {tab.error ? (
            <StatusLine tone="warning">{tab.error}</StatusLine>
          ) : (
            <ScrollRow label={`${tab.source_name || tab.source} 推荐歌单`}>
              {(tab.playlists || []).map((pl) => (
                <PlaylistCard key={`${pl.source}-${pl.id}`} playlist={pl} onOpen={onOpen} />
              ))}
            </ScrollRow>
          )}
        </section>
      ))}
    </div>
  );
};

// ===== 远端歌单/专辑详情 =====
const RemoteCollectionDetail = ({
  meta, kind = 'playlist', state, onBack, onPlay, onTogglePlayback, onShowLyric, isPlaying, isPaused,
}) => {
  const songs = state.data?.songs || [];
  const { user, offline } = useAuth();
  const userId = user?.id || 0;
  const isAlbum = kind === 'album';
  const contentLabel = isAlbum ? '专辑' : '推荐歌单';
  const taskKey = `user:${userId}:${kind}:${meta.source}:${meta.id}`;
  const {
    bulkDownload, bulkCache, handleDownloadAll, handleCacheAll, handleCopyToMine, hasAnyState,
  } = useBulkActions({ taskKey, songs, scopePrefix: `remote-${kind}` });
  const [coverFailed, setCoverFailed] = useState(false);
  useEffect(() => setCoverFailed(false), [meta.cover, meta.id, meta.source]);
  const cover = coverFailed ? '' : coverProxyUrl(meta);

  const downloadLabel = bulkDownload.phase === 'done' ? '已下载'
    : bulkDownload.phase === 'fail' ? '重试下载'
      : bulkDownload.phase === 'running' ? `下载中 ${bulkDownload.done || 0}/${bulkDownload.total || songs.length}`
        : '下载到服务器';
  const cacheLabel = bulkCache.phase === 'done' ? '已缓存'
    : bulkCache.phase === 'fail' ? '重试缓存'
      : bulkCache.phase === 'running' ? `缓存中 ${bulkCache.done || 0}/${bulkCache.total || songs.length}`
        : '缓存到本机';

  return (
    <div>
      <Button variant="ghost" size="sm" onClick={onBack} className="mb-4 -ml-2">
        ← {isAlbum ? '返回搜索结果' : '返回推荐歌单'}
      </Button>

      <header className="mb-5 flex flex-col gap-4 sm:flex-row sm:items-end">
        <div className="flex h-28 w-28 flex-shrink-0 items-center justify-center overflow-hidden rounded-lg bg-secondary shadow-subtle sm:h-32 sm:w-32">
          {cover ? (
            <img src={cover} alt="" className="h-full w-full object-cover" onError={() => setCoverFailed(true)} />
          ) : (
            <Music size={36} className="text-muted-foreground" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <p className="type-micro uppercase tracking-wider text-muted-foreground">{contentLabel}</p>
          <h1 className="mt-0.5 line-clamp-2 type-hero text-foreground">{meta.name}</h1>
          <p className="mt-1 type-caption text-muted-foreground">
            {meta.creator ? `${meta.creator} · ` : ''}
            <span className="nums">{songs.length}</span> 首
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button
              variant="primary"
              onClick={() => songs.length && onPlay(songs[0], songs)}
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
              title={offline ? '离线状态无法下载到服务器' : `把这张${contentLabel}存到服务器曲库`}
            >
              {downloadLabel}
            </Button>
            <Button
              variant="secondary"
              onClick={handleCacheAll}
              loading={bulkCache.phase === 'running'}
              disabled={!songs.length || offline || bulkCache.phase === 'running'}
              title={offline ? '离线状态无法缓存新歌曲' : '存到当前浏览器/PWA,可离线听'}
            >
              {cacheLabel}
            </Button>
            <Button
              variant="ghost"
              onClick={() => handleCopyToMine(meta.name || contentLabel)}
              disabled={!songs.length || offline}
              title="复制成我自己的歌单"
            >
              加入我的歌单
            </Button>
          </div>
        </div>
      </header>

      {hasAnyState && (
        <div className="mb-4 space-y-1.5 rounded-md border border-border bg-card/50 px-3 py-2">
          {(bulkDownload.phase !== 'idle' || bulkCache.phase !== 'idle') && (
            <StatusLine
              tone={bulkDownload.phase === 'fail' || bulkCache.phase === 'fail' ? 'error' : 'neutral'}
              loading={bulkDownload.phase === 'running' || bulkCache.phase === 'running'}
            >
              服务器下载 {bulkDownload.phase === 'idle' ? '—' : `${bulkDownload.done || 0}/${bulkDownload.total || 0}${bulkDownload.fail ? ` · 失败 ${bulkDownload.fail}` : ''}`}
              <span className="mx-2 text-border">|</span>
              本机缓存 {bulkCache.phase === 'idle' ? '—' : `${bulkCache.done || 0}/${bulkCache.total || 0}${bulkCache.fail ? ` · 失败 ${bulkCache.fail}` : ''}`}
            </StatusLine>
          )}
        </div>
      )}

      {state.isLoading && songs.length === 0 && (
        <LoadingState title={`加载${contentLabel}`} detail="正在读取曲目与封面" rows={5} />
      )}
      {state.isError && (
        <StatusLine tone="error" layout="banner" className="mb-3">
          加载{contentLabel}失败:{String(state.error?.message || state.error)}
        </StatusLine>
      )}
      {state.data?.error && (
        <StatusLine tone="error" layout="banner" className="mb-3">{state.data.error}</StatusLine>
      )}
      {!state.isLoading && state.data && songs.length === 0 && (
        <EmptyState compact icon={Music} title={`这张${contentLabel}没有可显示的曲目`} />
      )}

      {songs.length > 0 && (
        <>
          <SongListHeader />
          <div className="space-y-0.5">
            {songs.map((song, idx) => (
              <SongRow
                key={songIdentityKey(song) || `${song.source}-${song.id}`}
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

// ===== 搜索面板 =====
const SearchPane = ({
  keyword, setKeyword, onSubmit, runSearch, onClearSearchCache, query, state,
  onOpenAlbum, onPlay, onTogglePlayback, onShowLyric, isPlaying, isPaused,
}) => {
  const allSongs = state.data?.songs || [];
  const pendingSources = state.data?.pending_sources || [];
  const albums = state.data?.albums || [];
  const feedback = useFeedback();
  const [autoPlayQuery, setAutoPlayQuery] = useState('');
  const recognitionRef = useRef({ recorder: null, stream: null, chunks: [], timer: null, failed: false });
  const mountedRef = useRef(true);
  const [recognition, setRecognition] = useState({ phase: 'idle', message: '' });
  const rawSuggestionKeyword = keyword.trim();
  const clearCacheKeyword = (rawSuggestionKeyword || query || '').trim();
  const recognitionStatus = useQuery(['musicdl-recognition-status'], getRecognitionStatus, {
    refetchOnWindowFocus: false,
    staleTime: 5 * 60 * 1000,
  });
  const recognitionDisabled = recognitionStatus.data && recognitionStatus.data.enabled === false;

  const cleanupRecognitionResources = useCallback(() => {
    const current = recognitionRef.current;
    if (current.timer) window.clearTimeout(current.timer);
    if (current.stream) current.stream.getTracks().forEach((track) => track.stop());
    recognitionRef.current = { recorder: null, stream: null, chunks: [], timer: null, failed: false };
  }, []);

  const stopRecognition = useCallback(() => {
    const { recorder } = recognitionRef.current;
    if (recorder && recorder.state !== 'inactive') {
      recorder.stop();
      return;
    }
    cleanupRecognitionResources();
  }, [cleanupRecognitionResources]);

  useEffect(() => () => {
    mountedRef.current = false;
    cleanupRecognitionResources();
  }, [cleanupRecognitionResources]);

  const handleRecognitionClick = async () => {
    if (recognition.phase === 'recording') { stopRecognition(); return; }
    if (recognition.phase === 'uploading') return;
    if (recognitionStatus.isLoading && !recognitionStatus.data) {
      setRecognition({ phase: 'checking', message: '正在确认识曲服务状态' });
      window.setTimeout(() => setRecognition((current) => (
        current.message === '正在确认识曲服务状态' ? { phase: 'idle', message: '' } : current
      )), 1200);
      return;
    }
    if (recognitionDisabled) {
      const msg = recognitionStatus.data?.error || '听歌识曲未启用';
      setRecognition({ phase: 'error', message: msg });
      feedback.error(msg);
      return;
    }

    const mediaDevices = navigator.mediaDevices;
    if (!mediaDevices?.getUserMedia || typeof window.MediaRecorder === 'undefined') {
      feedback.error('当前浏览器不支持录音识曲');
      return;
    }

    try {
      const stream = await mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      const mimeType = pickRecognitionMimeType();
      const recorder = new window.MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      recognitionRef.current = { recorder, stream, chunks: [], timer: null, failed: false };

      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) recognitionRef.current.chunks.push(event.data);
      };
      recorder.onerror = () => {
        recognitionRef.current.failed = true;
        cleanupRecognitionResources();
        if (!mountedRef.current) return;
        setRecognition({ phase: 'error', message: '录音失败,请重新授权麦克风后再试' });
        feedback.error('录音失败,请重新授权麦克风后再试');
      };
      recorder.onstop = async () => {
        const current = recognitionRef.current;
        const chunks = current.chunks.slice();
        const failed = current.failed;
        const blobType = recorder.mimeType || mimeType || 'audio/webm';
        cleanupRecognitionResources();
        if (failed || !mountedRef.current) return;
        const blob = new Blob(chunks, { type: blobType });
        if (!blob.size) {
          feedback.error('没有录到声音,请再试一次');
          return;
        }
        const maxBytes = Number(recognitionStatus.data?.max_bytes || 0);
        if (maxBytes > 0 && blob.size > maxBytes) {
          const limitText = formatRecognitionBytes(maxBytes);
          feedback.error(limitText ? `录音过大,单次上限 ${limitText}` : '录音过大,请缩短后再试');
          return;
        }
        setRecognition({ phase: 'uploading', message: '正在识别这段声音' });
        try {
          const data = await recognizeAudio(blob);
          if (!mountedRef.current) return;
          if (!data?.matched) {
            const msg = data?.error || '没有识别到歌曲,可以再录一段更清晰的';
            setRecognition({ phase: 'error', message: msg });
            feedback.error(msg);
            return;
          }
          const result = data.result || {};
          const nextQuery = (data.query || [result.title, result.artist].filter(Boolean).join(' ')).trim();
          if (!nextQuery) {
            feedback.error('识别到了结果,但没有可搜索的歌名');
            return;
          }
          setKeyword(nextQuery);
          setAutoPlayQuery(nextQuery);
          if (runSearch) runSearch(nextQuery);
          const foundText = result.artist ? `${result.title || nextQuery} · ${result.artist}` : (result.title || nextQuery);
          setRecognition({ phase: 'success', message: `识别到 ${foundText}` });
          feedback.success('识别成功,正在搜索');
        } catch (err) {
          if (!mountedRef.current) return;
          feedback.error(recognitionErrorMessage(err));
        }
      };

      recorder.start(1000);
      recognitionRef.current.timer = window.setTimeout(stopRecognition, RECOGNITION_RECORD_MS);
      setRecognition({ phase: 'recording', message: '正在录音识曲' });
    } catch (err) {
      cleanupRecognitionResources();
      feedback.error(err?.name === 'NotAllowedError' ? '麦克风权限被拒绝' : recognitionErrorMessage(err));
    }
  };

  const history = useQuery(['search-history'], getSearchHistory, {
    refetchOnWindowFocus: false,
    staleTime: 60 * 1000,
  });
  useEffect(() => {
    if (query) history.refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  const [clearingSearchCache, setClearingSearchCache] = useState(false);

  const onChipSearch = (kw) => { setAutoPlayQuery(''); if (runSearch) runSearch(kw); };
  const onChipDelete = async (kw, e) => {
    e.stopPropagation();
    try {
      await clearSearchHistory(kw);
      history.refetch();
    } catch {
      feedback.error('删除搜索记录失败,请稍后重试');
    }
  };
  const onClearAll = async () => {
    const ok = await feedback.confirm({
      title: '清空最近搜索?',
      body: '只清空当前账号的搜索记录,不影响歌单或曲库。',
      confirmLabel: '清空',
      danger: true,
    });
    if (!ok) return;
    try {
      await clearSearchHistory();
      history.refetch();
      feedback.success('最近搜索已清空');
    } catch {
      feedback.error('清空搜索记录失败,请稍后重试');
    }
  };
  const handleClearSearchCache = async () => {
    const k = clearCacheKeyword;
    if (!k || clearingSearchCache) return;
    setClearingSearchCache(true);
    try {
      await onClearSearchCache?.(k);
      feedback.success('搜索缓存已清理,正在重新搜索');
    } catch (err) {
      feedback.error(err?.response?.data?.error || err?.message || '搜索缓存清理失败');
    } finally {
      setClearingSearchCache(false);
    }
  };

  const historyItems = history.data || [];
  const [sortMode, setSortMode] = useState('recommended');

  const originalIndex = new Map(allSongs.map((s, i) => [songIdentityKey(s), i]));

  const fieldValue = (s, field) => {
    if (field === 'size') return s.size || 0;
    if (field === 'quality') return Number(s.bitrate || 0) || 0;
    if (field === 'relevance') return -(originalIndex.get(songIdentityKey(s)) ?? 0);
    return originalIndex.get(songIdentityKey(s)) ?? 0;
  };

  // 搜索页不自动验活:先展示候选,用户点「验」/播放/下载时再解析单首。
  const songs = allSongs
    .map((s, i) => ({ s, i }))
    .sort((a, b) => {
      const preset = SORT_PRESETS[sortMode] || SORT_PRESETS.recommended;
      const cmp = fieldValue(a.s, preset.field) - fieldValue(b.s, preset.field);
      if (cmp !== 0) return preset.order === 'asc' ? cmp : -cmp;
      if (preset.field !== 'quality') {
        const qa = Number(a.s.bitrate || 0) || 0;
        const qb = Number(b.s.bitrate || 0) || 0;
        if (qa !== qb) return qb - qa;
      }
      return a.i - b.i;
    })
    .map((x) => x.s);

  const hasCurrentSearchResult = !!query && state.data?.keyword === query;

  useEffect(() => {
    if (!autoPlayQuery || query !== autoPlayQuery || !hasCurrentSearchResult) return;
    if (songs.length > 0) {
      onPlay(songs[0], songs);
      setAutoPlayQuery('');
      return;
    }
    const searchFinishedWithoutSongs = !state.isLoading && allSongs.length === 0;
    if (state.isError || state.data?.error || searchFinishedWithoutSongs) setAutoPlayQuery('');
  }, [
    allSongs.length, autoPlayQuery, hasCurrentSearchResult, onPlay, query, songs,
    state.data?.error, state.isError, state.isLoading,
  ]);

  // ===== 状态表达:只有阻断性错误用 banner,其余一律内联一行 =====
  const banner = (() => {
    if (state.isError) {
      return { tone: 'error', text: `搜索失败:${String(state.error?.message || state.error || '请稍后重试')}` };
    }
    if (state.data?.error) {
      return { tone: 'error', text: state.data.error };
    }
    if (hasCurrentSearchResult && songs.length === 0 && state.data?.songsError) {
      return {
        tone: 'error',
        text: `歌曲搜索失败:${state.data.songsError}${albums.length ? `(专辑仍有 ${albums.length} 张,见下方)` : ''}`,
      };
    }
    return null;
  })();

  const inlineStatus = (() => {
    if (state.isLoading) return { loading: true, text: `正在搜索「${query}」…` };
    if (hasCurrentSearchResult) {
      const parts = [];
      if (albums.length) parts.push(`${albums.length} 张专辑`);
      parts.push(`${songs.length} 首歌曲`);
      return { text: `找到 ${parts.join(' · ')}。点单首「验」可测真实音质。` };
    }
    return null;
  })();

  const isStale = state.isFetching && !hasCurrentSearchResult && allSongs.length > 0;

  return (
    <div>
      {/* 搜索表单:输入框 + 识曲 + 搜索,一行完成 */}
      <form onSubmit={(e) => { setAutoPlayQuery(''); onSubmit(e); }} className="mb-3" role="search">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[12rem] flex-1">
            <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <Input
              type="search"
              value={keyword}
              onChange={(e) => { setAutoPlayQuery(''); setKeyword(e.target.value); }}
              onKeyDown={(e) => {
                // 中文输入法上屏回车不应触发搜索
                if (e.key === 'Enter' && e.nativeEvent.isComposing) e.preventDefault();
              }}
              placeholder="输入歌名 / 歌手 / 歌词,或粘贴链接"
              aria-label="搜索歌名、歌手或歌词"
              enterKeyHint="search"
              className="pl-9"
            />
          </div>
          <Button
            variant="outline"
            size="lg"
            iconOnly
            onClick={handleRecognitionClick}
            disabled={recognition.phase === 'uploading'}
            aria-label={recognitionDisabled ? '听歌识曲未启用' : recognition.phase === 'recording' ? '停止录音并识别' : '听歌识曲'}
            title={recognitionDisabled ? '听歌识曲未启用' : recognition.phase === 'recording' ? '停止录音并识别' : '听歌识曲'}
            className={recognition.phase === 'recording' ? 'border-destructive text-destructive' : ''}
          >
            {recognition.phase === 'recording' ? <Square size={16} fill="currentColor" /> : <Mic size={17} />}
          </Button>
          <Button type="submit" variant="primary" size="lg">搜索</Button>
          <Button
            variant="ghost"
            size="lg"
            iconOnly
            onClick={handleClearSearchCache}
            disabled={!clearCacheKeyword || clearingSearchCache || state.isLoading}
            aria-label="清理搜索缓存并重新搜索"
            title={clearCacheKeyword ? `清理「${clearCacheKeyword}」的缓存并重搜` : '输入关键词后可清理缓存'}
          >
            <RotateCw size={16} className={clearingSearchCache ? 'animate-spin' : ''} />
          </Button>
        </div>
      </form>

      {/* 识曲进行中的状态:内联一行,不再占一条彩色横幅 */}
      {recognition.phase !== 'idle' && (
        <StatusLine
          tone={recognition.phase === 'error' ? 'error' : recognition.phase === 'success' ? 'success' : 'neutral'}
          loading={['checking', 'recording', 'uploading'].includes(recognition.phase)}
          className="mb-2"
        >
          {recognition.message}
        </StatusLine>
      )}

      {!query && (
        <RecentSearches
          items={historyItems}
          onPick={onChipSearch}
          onDelete={onChipDelete}
          onClearAll={onClearAll}
        />
      )}

      {/* 状态区:最多两行,错误才带边框 */}
      {banner && (
        <StatusLine tone={banner.tone} layout="banner" className="mb-3">{banner.text}</StatusLine>
      )}
      {!banner && inlineStatus && (
        <StatusLine loading={inlineStatus.loading} className="mb-1">{inlineStatus.text}</StatusLine>
      )}
      {pendingSources.length > 0 && (
        <StatusLine tone="neutral" className="mb-3">
          还有 {pendingSources.length} 个源在后台补齐({pendingSources.map(sourceLabel).join('、')}),结果会自动刷新
        </StatusLine>
      )}

      {albums.length > 0 && (
        <div className="mb-5">
          <SearchAlbumRow albums={albums} onOpen={onOpenAlbum} ScrollRow={ScrollRow} />
        </div>
      )}

      {/* 歌曲区:标题行内放排序分段控件,不再用三张大卡片 */}
      {(songs.length > 0 || (hasCurrentSearchResult && !state.isLoading)) && (
        <section
          aria-labelledby="search-songs-title"
          className={cn('transition-opacity duration-base', isStale && 'pointer-events-none opacity-50')}
          aria-busy={isStale || undefined}
        >
          <SectionHeader
            id="search-songs-title"
            title="歌曲"
            count={songs.length ? `${songs.length} 首` : undefined}
            actions={songs.length > 1 ? (
              <Segmented
                value={sortMode}
                onChange={setSortMode}
                options={SORT_OPTIONS}
                size="sm"
                label="排序方式"
              />
            ) : null}
          />
          {songs.length === 0 ? (
            <EmptyState
              icon={Search}
              title="没有找到结果"
              description="可以换成「歌手 歌名」再试,或粘贴歌曲/歌单链接。"
            />
          ) : (
            <>
              <SongListHeader />
              <div className="space-y-0.5">
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
                    lyricQuery={query}
                  />
                ))}
              </div>
            </>
          )}
        </section>
      )}

      {/* 还没搜过:给一个明确的起点,而不是空白页 */}
      {!query && historyItems.length === 0 && (
        <EmptyState
          icon={Search}
          title="搜全网,存到你的曲库"
          description="支持歌名、歌手、歌词片段,也能直接粘贴网易云/QQ 的歌曲或歌单链接。"
        />
      )}
    </div>
  );
};

// ===== 歌词弹窗 =====
const LyricDialog = ({ lyric, onClose }) => (
  <Dialog open={!!lyric} onClose={onClose} title={lyric ? lyric.song.name : ''} size="lg">
    {lyric && (
      <>
        <p className="mb-3 type-caption text-muted-foreground">{lyric.song.artist}</p>
        <pre className="whitespace-pre-wrap font-sans type-body text-foreground">{lyric.text}</pre>
      </>
    )}
  </Dialog>
);

// ===== 页面 =====
const Download = ({ downloadRequest }) => {
  const { play, isPlaying, isPaused, togglePlay } = usePlayer();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState('search');
  const [keyword, setKeyword] = useState('');
  const [query, setQuery] = useState('');
  const [openPlaylist, setOpenPlaylist] = useState(null);
  const [openAlbum, setOpenAlbum] = useState(null);
  const [lyric, setLyric] = useState(null);

  useEffect(() => {
    const kw = downloadRequest?.keyword;
    if (kw) {
      setTab('search');
      setOpenPlaylist(null);
      setOpenAlbum(null);
      setKeyword(kw);
      setQuery(kw);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [downloadRequest?.ts]);

  const search = useQuery(
    searchQueryKey(query),
    () => searchSongsLyricsAndAlbums(query),
    {
      enabled: tab === 'search' && !!query,
      keepPreviousData: true,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      staleTime: 5 * 60 * 1000,
    }
  );
  useCachedRefresh(search, tab === 'search' && !!query);

  // 慢源补齐:后端返回 pending_sources 时说明它们还在后台跑,跑完写进 24h 缓存。
  const pendingSources = search.data?.pending_sources || [];
  const pendingSourcesKey = pendingSources.join(',');
  const pendingRefetchCountRef = useRef(0);
  useEffect(() => {
    if (!pendingSourcesKey) { pendingRefetchCountRef.current = 0; return undefined; }
    if (pendingRefetchCountRef.current >= PENDING_REFETCH_MAX) return undefined;
    const timer = window.setTimeout(() => {
      pendingRefetchCountRef.current += 1;
      search.refetch();
    }, PENDING_REFETCH_DELAY_MS);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingSourcesKey]);

  const recommend = useQuery(
    ['musicdl-recommend'],
    () => getRecommend(['netease', 'qq']),
    { enabled: tab === 'discover', refetchOnWindowFocus: false, staleTime: 5 * 60 * 1000 }
  );
  useCachedRefresh(recommend, tab === 'discover');

  const playlistDetail = useQuery(
    ['musicdl-playlist', openPlaylist?.id, openPlaylist?.source],
    () => getPlaylistDetail(openPlaylist.id, openPlaylist.source),
    { enabled: !!openPlaylist, refetchOnWindowFocus: false, staleTime: 5 * 60 * 1000 }
  );
  useCachedRefresh(playlistDetail, !!openPlaylist);

  const albumDetail = useQuery(
    ['musicdl-album', openAlbum?.id, openAlbum?.source],
    () => getAlbumDetail(openAlbum.id, openAlbum.source),
    { enabled: tab === 'search' && !!openAlbum, refetchOnWindowFocus: false, staleTime: 5 * 60 * 1000 }
  );
  useCachedRefresh(albumDetail, tab === 'search' && !!openAlbum);

  const handleSearch = (e) => {
    e.preventDefault();
    const k = keyword.trim();
    if (k) setQuery(k);
  };

  const runSearch = (kw) => {
    const k = (kw || '').trim();
    if (!k) return;
    setKeyword(k);
    setQuery(k);
  };

  const handleClearSearchCache = useCallback(async (kw) => {
    const k = (kw || query || '').trim();
    if (!k) return;
    const types = SEARCH_LINK_RE.test(k) ? ['song'] : ['song', 'lyric', 'album'];
    const targetKey = searchQueryKey(k);
    await queryClient.cancelQueries(targetKey, { exact: true });
    await clearSearchCache(k, { types });
    if (k !== query) {
      queryClient.removeQueries(targetKey, { exact: true });
      setQuery(k);
      return;
    }
    await queryClient.invalidateQueries(targetKey, { exact: true });
    await search.refetch();
  }, [query, queryClient, search]);

  const handlePlay = (song, list) => play(song, list);

  const handleShowLyric = async (song) => {
    setLyric({ song, text: '加载中…' });
    try {
      const text = await getLyric(song);
      setLyric({ song, text: text || '无歌词' });
    } catch {
      setLyric({ song, text: '歌词加载失败' });
    }
  };

  const switchTab = (next) => {
    setTab(next);
    setOpenPlaylist(null);
    setOpenAlbum(null);
  };

  return (
    <div>
      <PageHeader
        title="找歌"
        subtitle="搜全网多源,存到你的服务器曲库或本机,随时离线听"
      />

      {/* 视图切换:紧凑分段,替代两个药丸大按钮 */}
      <div className="mb-5">
        <Segmented
          value={tab}
          onChange={switchTab}
          options={TABS}
          size="md"
          label="搜索或推荐"
        />
      </div>

      {tab === 'search' && !openAlbum && (
        <SearchPane
          keyword={keyword}
          setKeyword={setKeyword}
          onSubmit={handleSearch}
          runSearch={runSearch}
          onClearSearchCache={handleClearSearchCache}
          query={query}
          state={search}
          onOpenAlbum={setOpenAlbum}
          onPlay={handlePlay}
          onTogglePlayback={togglePlay}
          onShowLyric={handleShowLyric}
          isPlaying={isPlaying}
          isPaused={isPaused}
        />
      )}

      {tab === 'search' && openAlbum && (
        <RemoteCollectionDetail
          meta={openAlbum}
          kind="album"
          state={albumDetail}
          onBack={() => setOpenAlbum(null)}
          onPlay={handlePlay}
          onTogglePlayback={togglePlay}
          onShowLyric={handleShowLyric}
          isPlaying={isPlaying}
          isPaused={isPaused}
        />
      )}

      {tab === 'discover' && !openPlaylist && (
        <DiscoverPane state={recommend} onOpen={setOpenPlaylist} onRetry={() => recommend.refetch()} />
      )}

      {tab === 'discover' && openPlaylist && (
        <RemoteCollectionDetail
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

      <LyricDialog lyric={lyric} onClose={() => setLyric(null)} />
    </div>
  );
};

export default Download;
