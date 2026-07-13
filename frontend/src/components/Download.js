import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
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
  runServerDownloadBatch,
  SERVER_DOWNLOAD_BULK_IDLE,
  serverDownloadBatchSummary,
} from '../services/serverDownloadBatch';
import {
  AlertCircle,
  Check,
  Download as DownloadIcon,
  HardDriveDownload,
  Loader2,
  ListPlus,
  Mic,
  Music,
  Play,
  RotateCw,
  Search,
  Square,
  X,
} from 'lucide-react';
import SongRow, { SongListHeader } from './SongRow';
import { usePlayer } from '../contexts/PlayerContext';
import { useAuth } from '../contexts/AuthContext';
import { useCollections } from '../contexts/CollectionsContext';
import { useFeedback } from '../contexts/FeedbackContext';
import { useCachedRefresh } from '../hooks/useCachedRefresh';
import { useScopedBulkState } from '../hooks/useScopedBulkState';
import { cacheSong, canCacheSong, isSongCached } from '../services/offlineAudio';
import { songIdentityKey } from '../utils/songIdentity';
import LoadingState from './LoadingState';
import SearchAlbumRow from './SearchAlbumRow';

const TABS = [
  { key: 'search', label: '搜索下载' },
  { key: 'discover', label: '推荐歌单' },
];

const IDLE_BULK_CACHE = { phase: 'idle', done: 0, fail: 0, skipped: 0, total: 0 };
const IDLE_BULK_COPY = { phase: 'idle', done: 0, fail: 0, total: 0, collectionId: null };
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

// 搜索结果相关性排序已下沉到后端(/api/v1/search 综合排序:上游名次+翻唱降权+
// 原唱信号),前端默认信任后端返回序,不再本地重算相关性。

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

const mergeSongData = (base, incoming) => {
  const merged = {
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
  };
  return merged;
};

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
    error: hasResults ? '' : (songData?.error || lyricData?.error || albumData?.error || failures[0] || ''),
  };
};

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
    <div className={`mb-3 ${className}`} role="status" aria-live="polite" title="正在后台更新缓存，当前先显示上次结果">
      <span className="sr-only">正在后台更新缓存，当前先显示上次结果</span>
      <div className="h-1 overflow-hidden rounded-full bg-secondary loading-bar-indeterminate" />
    </div>
  );
};

const QueryRefreshProgress = ({ active, className = '' }) => {
  if (!active) return null;
  return (
    <div className={`mb-3 ${className}`} role="status" aria-live="polite" title="正在刷新内容">
      <span className="sr-only">正在刷新内容</span>
      <div className="h-1 overflow-hidden rounded-full bg-secondary loading-bar-indeterminate" />
    </div>
  );
};

// 搜索面板
const SearchPane = ({ keyword, setKeyword, onSubmit, runSearch, onClearSearchCache, query, state, onOpenAlbum, onPlay, onTogglePlayback, onShowLyric, isPlaying, isPaused }) => {
  const allSongs = state.data?.songs || [];
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
    if (current.timer) {
      window.clearTimeout(current.timer);
    }
    if (current.stream) {
      current.stream.getTracks().forEach((track) => track.stop());
    }
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
    if (recognition.phase === 'recording') {
      stopRecognition();
      return;
    }
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
      setRecognition({ phase: 'error', message: '当前浏览器不支持录音识曲' });
      feedback.error('当前浏览器不支持录音识曲');
      return;
    }

    try {
      const stream = await mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
      const mimeType = pickRecognitionMimeType();
      const recorder = new window.MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      recognitionRef.current = { recorder, stream, chunks: [], timer: null, failed: false };

      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          recognitionRef.current.chunks.push(event.data);
        }
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
          setRecognition({ phase: 'error', message: '没有录到声音,请再试一次' });
          feedback.error('没有录到声音,请再试一次');
          return;
        }
        const maxBytes = Number(recognitionStatus.data?.max_bytes || 0);
        if (maxBytes > 0 && blob.size > maxBytes) {
          const limitText = formatRecognitionBytes(maxBytes);
          const msg = limitText ? `录音过大,单次上限 ${limitText}` : '录音过大,请缩短后再试';
          setRecognition({ phase: 'error', message: msg });
          feedback.error(msg);
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
            setRecognition({ phase: 'error', message: '识别到了结果,但没有可搜索的歌名' });
            feedback.error('识别到了结果,但没有可搜索的歌名');
            return;
          }
          setKeyword(nextQuery);
          setAutoPlayQuery(nextQuery);
          if (runSearch) runSearch(nextQuery);
          const foundText = result.artist ? `${result.title || nextQuery} · ${result.artist}` : (result.title || nextQuery);
          setRecognition({ phase: 'success', message: `识别到 ${foundText}` });
          feedback.success('识别成功,正在搜索可播放版本');
        } catch (err) {
          if (!mountedRef.current) return;
          const msg = recognitionErrorMessage(err);
          setRecognition({ phase: 'error', message: msg });
          feedback.error(msg);
        }
      };

      recorder.start(1000);
      recognitionRef.current.timer = window.setTimeout(stopRecognition, RECOGNITION_RECORD_MS);
      setRecognition({ phase: 'recording', message: '正在录音识曲' });
    } catch (err) {
      cleanupRecognitionResources();
      const msg = err?.name === 'NotAllowedError' ? '麦克风权限被拒绝' : recognitionErrorMessage(err);
      setRecognition({ phase: 'error', message: msg });
      feedback.error(msg);
    }
  };

  const handleFormSubmit = (event) => {
    setAutoPlayQuery('');
    onSubmit(event);
  };

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
  const [clearingSearchCache, setClearingSearchCache] = useState(false);

  const onChipSearch = (kw) => {
    setAutoPlayQuery('');
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
  const handleClearSearchCache = async () => {
    const k = clearCacheKeyword;
    if (!k || clearingSearchCache) return;
    setClearingSearchCache(true);
    try {
      await onClearSearchCache?.(k);
      feedback.success('搜索缓存已清理,正在重新搜索');
    } catch (err) {
      const msg = err?.response?.data?.error || err?.message || '搜索缓存清理失败';
      feedback.error(msg);
    } finally {
      setClearingSearchCache(false);
    }
  };

  const historyItems = history.data || [];
  const [sortMode, setSortMode] = useState('recommended');
  const SORT_PRESETS = {
    recommended: { field: 'relevance', order: 'desc', label: '推荐排序', hint: '优先匹配原唱和来源顺序' },
    quality: { field: 'quality', order: 'desc', label: '高音质优先', hint: '按搜索返回音质预估' },
    compact: { field: 'size', order: 'asc', label: '文件更小', hint: '适合省空间和流量' },
  };

  const originalIndex = new Map(allSongs.map((s, i) => [songIdentityKey(s), i]));

  // 各排序维度的取值
  const fieldValue = (s, field) => {
    if (field === 'size') return s.size || 0;
    if (field === 'quality') return Number(s.bitrate || 0) || 0;
    // 相关性:信任后端综合排序(上游名次+翻唱降权+原唱信号,前端看不到这些),
    // 用返回序的相反数(origIdx 越小越靠前)。不再前端重算 relevanceScore。
    if (field === 'relevance') return -(originalIndex.get(songIdentityKey(s)) ?? 0);
    return originalIndex.get(songIdentityKey(s)) ?? 0;
  };

  // 搜索页不再自动验活:先展示候选,用户点“验”/播放/下载时再解析单首。
  const songs = allSongs
    .map((s, i) => ({ s, i }))
    .sort((a, b) => {
      const preset = SORT_PRESETS[sortMode] || SORT_PRESETS.recommended;
      const cmp = fieldValue(a.s, preset.field) - fieldValue(b.s, preset.field);
      if (cmp !== 0) return preset.order === 'asc' ? cmp : -cmp;
      // 排序键全相等(如同名"炽心"相关性同分)时,隐式按真实音质降序——
      // 未手动验活前只能使用搜索返回的预估码率;音质相同再回退原序。
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
    if (state.isError || state.data?.error || searchFinishedWithoutSongs) {
      setAutoPlayQuery('');
    }
  }, [
    allSongs.length,
    autoPlayQuery,
    hasCurrentSearchResult,
    onPlay,
    query,
    songs,
    state.data?.error,
    state.isError,
    state.isLoading,
  ]);

  const sortBtnCls = (mode) =>
    `rounded-md border px-3 py-2 text-left transition-colors ${
      sortMode === mode ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-card hover:bg-secondary'
    }`;

  const searchStage = (() => {
    if (!query && !state.isLoading) return null;
    if (state.isLoading) {
      return {
        title: `正在搜索「${query}」`,
        detail: '正在同时匹配歌名、歌手和歌词片段。',
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
    if (hasCurrentSearchResult && (songs.length > 0 || albums.length > 0)) {
      return {
        title: '已找到搜索结果',
        detail: `${albums.length ? `${albums.length} 张专辑 · ` : ''}${songs.length} 首候选歌曲。歌曲不会自动验活,需要时点单首“验”。`,
        icon: Check,
        tone: 'success',
      };
    }
    if (query && hasCurrentSearchResult && songs.length === 0) {
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
      <form onSubmit={handleFormSubmit} className="mb-3 flex gap-2">
        <div className="relative min-w-0 flex-grow">
          <input
            type="text"
            value={keyword}
            onChange={(e) => {
              setAutoPlayQuery('');
              setKeyword(e.target.value);
            }}
            placeholder="输入歌名 / 歌手 / 歌词，或粘贴链接…"
            className="w-full rounded-md border border-border bg-card px-4 py-3 font-medium outline-none transition-colors focus:border-primary"
          />
        </div>
        <button
          type="button"
          onClick={handleRecognitionClick}
          disabled={recognition.phase === 'uploading'}
          className={`flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-md border transition-colors disabled:opacity-50 ${
            recognition.phase === 'recording'
              ? 'border-destructive bg-destructive/15 text-destructive hover:bg-destructive/20'
              : recognitionDisabled
                ? 'border-border bg-card text-muted-foreground hover:border-primary hover:text-primary'
                : 'border-border bg-card text-foreground hover:border-primary hover:text-primary'
          }`}
          title={recognitionDisabled ? '听歌识曲未启用' : recognition.phase === 'recording' ? '停止录音并识别' : '听歌识曲'}
          aria-label={recognitionDisabled ? '听歌识曲未启用' : recognition.phase === 'recording' ? '停止录音并识别' : '听歌识曲'}
        >
          {recognition.phase === 'recording' ? <Square size={18} fill="currentColor" /> : <Mic size={19} />}
        </button>
        <button type="submit" className="rounded-md bg-primary px-6 py-3 font-semibold text-primary-foreground transition-colors hover:brightness-110">
          搜索
        </button>
        <button
          type="button"
          onClick={handleClearSearchCache}
          disabled={!clearCacheKeyword || clearingSearchCache || state.isLoading}
          className="flex h-12 flex-shrink-0 items-center gap-2 rounded-md border border-border bg-card px-3 text-sm font-semibold text-muted-foreground transition-colors hover:border-primary hover:text-primary disabled:cursor-not-allowed disabled:opacity-50"
          title={clearCacheKeyword ? `清理「${clearCacheKeyword}」的搜索缓存并重新搜索` : '输入关键词后清理搜索缓存'}
        >
          <RotateCw size={15} className={clearingSearchCache ? 'animate-spin' : ''} />
          <span className="hidden sm:inline">清缓存重搜</span>
        </button>
      </form>
      {recognition.phase !== 'idle' && (
        <div className={`mb-5 rounded-md border px-3 py-2 text-sm ${
          recognition.phase === 'error'
            ? 'border-destructive/40 bg-destructive/10 text-destructive'
            : recognition.phase === 'success'
              ? 'border-primary/30 bg-primary/10 text-primary'
              : 'border-border bg-card/70 text-muted-foreground'
          }`}>
          <div className="flex items-center gap-2">
            {(recognition.phase === 'checking' || recognition.phase === 'recording' || recognition.phase === 'uploading') && <Loader2 size={15} className="animate-spin text-primary" />}
            <span>{recognition.message}</span>
            {recognition.phase === 'recording' && <span className="loading-dots" aria-hidden="true" />}
          </div>
          {(recognition.phase === 'checking' || recognition.phase === 'recording' || recognition.phase === 'uploading') && (
            <div className="mt-2 h-1 overflow-hidden rounded-full bg-secondary loading-bar-indeterminate" />
          )}
        </div>
      )}
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
      <QueryRefreshProgress active={state.isFetching && !!state.data && !state.isLoading && !searchStage?.loading && !(state.data?.cached && state.data?.refreshing)} />
      <SearchStatusPanel stage={searchStage} available={songs.length} total={allSongs.length} />
      <SearchAlbumRow albums={albums} onOpen={onOpenAlbum} />
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
      {songs.length > 0 && (
        <>
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
                lyricQuery={query}
              />
            ))}
          </div>
        </>
      )}
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
  if (state.isLoading && !state.data) {
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
      <QueryRefreshProgress active={state.isFetching && tabs.length > 0 && !(state.data?.cached && state.data?.refreshing)} />
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

const BulkStatusCard = ({ title, state, cache, serverDownload }) => {
  if (state.phase === 'idle') return null;
  return (
    <div className={`rounded-md border px-3 py-2 text-sm ${
      state.phase === 'fail' ? 'border-destructive/40 bg-destructive/10 text-destructive' : 'border-border bg-card/70 text-muted-foreground'
    }`}>
      <p className="font-medium text-foreground">{title}</p>
      {serverDownload ? <p>{serverDownloadBatchSummary(state)}</p> : (
        <p>
          {cache ? `新增 ${state.done}` : `已完成 ${state.done}/${state.total}`}
          {cache && state.skipped ? ` · 已有 ${state.skipped}` : ''}
          {cache && state.total ? ` · 共 ${state.total}` : ''}
          {state.fail ? ` · 失败 ${state.fail}` : ''}
        </p>
      )}
    </div>
  );
};

// 远端歌单/专辑详情面板
const RemoteCollectionDetailPane = ({ meta, kind = 'playlist', state, onBack, onPlay, onTogglePlayback, onShowLyric, isPlaying, isPaused }) => {
  const songs = state.data?.songs || [];
  const { user, offline } = useAuth();
  const { create, addSong } = useCollections();
  const feedback = useFeedback();
  const userId = user?.id || 0;
  const isAlbum = kind === 'album';
  const contentLabel = isAlbum ? '专辑' : '推荐歌单';
  const taskKey = `user:${userId}:${kind}:${meta.source}:${meta.id}`;
  const downloadTasks = useScopedBulkState(SERVER_DOWNLOAD_BULK_IDLE, 'recommended-playlist-download');
  const cacheTasks = useScopedBulkState(IDLE_BULK_CACHE, 'recommended-playlist-cache');
  const copyTasks = useScopedBulkState(IDLE_BULK_COPY, 'recommended-playlist-copy');
  const bulkDownload = downloadTasks.getState(taskKey);
  const bulkCache = cacheTasks.getState(taskKey);
  const bulkCopy = copyTasks.getState(taskKey);

  const handleDownloadAll = async () => {
    if (!songs.length || offline || bulkDownload.phase === 'running') return;
    const playlistSongs = songs.slice();
    const total = playlistSongs.length;
    await downloadTasks.runForKey(taskKey, {
      ...SERVER_DOWNLOAD_BULK_IDLE,
      phase: 'running',
      total,
    }, async (update) => {
      const result = await runServerDownloadBatch(playlistSongs, {
        expectedUserId: userId,
        onProgress: update,
      });
      if (result.statusError) feedback.error('读取服务器已下载状态失败，未开始下载，请重试');
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
        const collection = await create(meta.name || contentLabel);
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

  const downloadLabel = playlistBulkLabel(bulkDownload, '下载到服务器', '下载到服务器', '已下载到服务器', '重试下载到服务器');
  const cacheLabel = playlistBulkLabel(bulkCache, '缓存到本机', '缓存到本机', '已缓存到本机', '重试缓存到本机');
  const copyLabel = playlistBulkLabel(bulkCopy, '加入我的歌单', '加入我的歌单', '已加入我的歌单', '重试加入歌单');
  const DownloadBulkIcon = bulkDownload.phase === 'done' ? Check : bulkDownload.phase === 'fail' ? RotateCw : DownloadIcon;
  const CacheBulkIcon = bulkCache.phase === 'done' ? Check : bulkCache.phase === 'fail' ? RotateCw : HardDriveDownload;
  const CopyBulkIcon = bulkCopy.phase === 'done' ? Check : bulkCopy.phase === 'fail' ? RotateCw : ListPlus;
  const hasBulkStatus = bulkDownload.phase !== 'idle' || bulkCache.phase !== 'idle' || bulkCopy.phase !== 'idle';
  const [detailCoverFailed, setDetailCoverFailed] = useState(false);
  useEffect(() => setDetailCoverFailed(false), [meta.cover, meta.id, meta.source]);
  const detailCover = detailCoverFailed ? '' : coverProxyUrl(meta);

  return (
    <div className="pb-32">
      <button onClick={onBack} className="mb-4 rounded-full bg-secondary px-3 py-1.5 text-sm font-semibold text-foreground transition-colors hover:bg-secondary/80">← {isAlbum ? '返回搜索结果' : '返回推荐歌单'}</button>
      <div className="mb-4 flex flex-col gap-4 sm:flex-row sm:items-end">
        <div className="flex h-32 w-32 flex-shrink-0 items-center justify-center overflow-hidden rounded-lg bg-secondary">
          {detailCover ? (
            <img src={detailCover} alt="" className="h-full w-full object-cover" onError={() => setDetailCoverFailed(true)} />
          ) : (
            <Music size={42} className="text-muted-foreground" />
          )}
        </div>
        <div className="min-w-0">
          <p className="text-xs uppercase tracking-wider text-muted-foreground">{contentLabel}</p>
          <h3 className="truncate text-3xl font-black">{meta.name}</h3>
          {meta.creator && <p className="mt-1 truncate text-sm text-muted-foreground">{meta.creator}</p>}
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
              title={offline ? '离线状态无法下载到服务器' : `把这张${contentLabel}下载到服务器的「已下载」列表`}>
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
              title={offline ? '离线状态无法缓存新歌曲' : `把这张${contentLabel}缓存到当前浏览器/PWA`}>
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
      <QueryRefreshProgress active={state.isFetching && songs.length > 0 && !(state.data?.cached && state.data?.refreshing)} />
      {state.isLoading && songs.length === 0 && (
        <LoadingState
          title={`加载${contentLabel}`}
          detail={`正在读取${contentLabel}歌曲和封面信息`}
          rows={6}
          className="mb-4"
        />
      )}
      {state.isError && <p className="text-destructive font-bold mb-4">加载{contentLabel}失败:{String(state.error?.message || state.error)}</p>}
      {state.data?.error && <p className="text-destructive font-bold mb-4">{state.data.error}</p>}
      <CacheRefreshNotice data={state.data} />
      {hasBulkStatus && (
        <div className="mb-4 grid gap-2 sm:grid-cols-2">
          <BulkStatusCard title="服务器下载" state={bulkDownload} serverDownload />
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
  const queryClient = useQueryClient();
  const [tab, setTab] = useState('search');
  const [keyword, setKeyword] = useState('');
  const [query, setQuery] = useState('');
  const [openPlaylist, setOpenPlaylist] = useState(null); // {id, source, name}
  const [openAlbum, setOpenAlbum] = useState(null); // {id, source, name, cover, creator}
  const [lyric, setLyric] = useState(null); // {song, text}

  // 来自发现页「在国内源下载」的预填搜索词:切到搜索 Tab 并自动搜索。
  // 依赖 ts,保证重复点同一首歌也能再次触发。
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

  // 歌名 + 歌词 + 专辑合并搜索
  const search = useQuery(
    searchQueryKey(query),
    () => searchSongsLyricsAndAlbums(query),
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

  // 搜索结果中的专辑详情
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

  // 供搜索历史 chips 点击:同时回填输入框并触发搜索。
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
              setOpenAlbum(null);
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
        <RemoteCollectionDetailPane
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
        <DiscoverPane state={recommend} onOpen={setOpenPlaylist} />
      )}

      {tab === 'discover' && openPlaylist && (
        <RemoteCollectionDetailPane
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
