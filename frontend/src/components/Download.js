import React, { useState, useEffect } from 'react';
import { useQuery } from 'react-query';
import {
  searchMusic,
  getRecommend,
  getPlaylistDetail,
  getLyric,
} from '../services/musicdl';
import SongRow from './SongRow';
import { usePlayer } from '../contexts/PlayerContext';
import { useLiveCheck } from '../hooks/useLiveCheck';

const TABS = [
  { key: 'search', label: '歌曲搜索' },
  { key: 'discover', label: '推荐歌单' },
];

// 歌曲搜索面板
const SearchPane = ({ keyword, setKeyword, onSubmit, query, state, onPlay, onShowLyric, isPlaying }) => {
  const allSongs = state.data?.songs || [];
  // 自动验活:并发探测真实可用性,死链隐藏,存活的带上真实 size/bitrate
  const { status, progress } = useLiveCheck(allSongs);
  const [sortBy, setSortBy] = useState('relevance');
  const [order, setOrder] = useState('asc');

  const setSort = (field, defaultOrder) => {
    if (sortBy === field) {
      setOrder((o) => (o === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortBy(field);
      setOrder(defaultOrder);
    }
  };

  const songKey = (s) => `${s.source}-${s.id}`;
  // 只保留已验活为 ok 的(验活中/未验先不显示,死链永久隐藏)
  const liveSongs = allSongs.filter((s) => status[songKey(s)]?.state === 'ok');

  // 带原始索引排序,保证"相关"能还原搜索原序;大小用搜索返回的字节数(够排序用)
  const songs = liveSongs
    .map((s, i) => ({ s, i }))
    .sort((a, b) => {
      let cmp;
      if (sortBy === 'size') cmp = (a.s.size || 0) - (b.s.size || 0);
      else cmp = a.i - b.i;
      return order === 'asc' ? cmp : -cmp;
    })
    .map((x) => x.s);

  const arrow = (field) => (sortBy === field ? (order === 'asc' ? ' ↑' : ' ↓') : '');
  const sortBtnCls = (field) =>
    `px-3 py-1.5 border rounded-md text-sm font-medium transition-colors ${
      sortBy === field ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-card hover:bg-secondary'
    }`;

  const checking = progress.total > 0 && progress.done < progress.total;

  return (
    <div>
      <form onSubmit={onSubmit} className="flex gap-2 mb-6">
        <input
          type="text"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          placeholder="输入歌名 / 歌手,或粘贴链接…"
          className="flex-grow px-4 py-3 border border-border rounded-md bg-card font-medium shadow-brutal-sm focus:shadow-brutal outline-none transition-shadow"
        />
        <button type="submit" className="px-6 py-3 border border-border rounded-md bg-primary text-primary-foreground font-semibold shadow-brutal-sm transition-colors hover:bg-[#106EBE]">
          搜索
        </button>
      </form>
      {state.data?.error && <p className="text-destructive font-medium mb-4">{state.data.error}</p>}
      {state.isLoading && <p className="text-muted-foreground font-medium mb-4">搜索中…</p>}
      {state.isError && <p className="text-destructive font-medium">搜索失败:{String(state.error?.message || state.error)}</p>}
      {/* 验活进度 */}
      {!state.isLoading && checking && (
        <p className="text-primary font-medium mb-4">
          正在验活并过滤无法播放的结果… {progress.done}/{progress.total}
        </p>
      )}
      {query && !state.isLoading && !checking && progress.total > 0 && songs.length === 0 && (
        <p className="text-muted-foreground">没有可用的结果(均无法播放或版权受限)。</p>
      )}
      {query && !state.isLoading && progress.total === 0 && !state.data?.error && (
        <p className="text-muted-foreground">没有找到结果。</p>
      )}
      {songs.length > 0 && (
        <div className="flex items-center gap-2 mb-4">
          <span className="text-sm text-muted-foreground">排序:</span>
          <button onClick={() => setSort('relevance', 'asc')} className={sortBtnCls('relevance')}>相关{arrow('relevance')}</button>
          <button onClick={() => setSort('size', 'desc')} className={sortBtnCls('size')}>大小{arrow('size')}</button>
          <span className="text-sm text-muted-foreground ml-2">共 {songs.length} 首可用</span>
        </div>
      )}
      <div className="space-y-2 pb-32">
        {songs.map((song, idx) => (
          <SongRow
            key={`${song.source}-${song.id}-${idx}`}
            song={song}
            index={idx}
            isPlaying={isPlaying(song)}
            onPlay={(s) => onPlay(s, songs)}
            onShowLyric={onShowLyric}
          />
        ))}
      </div>
    </div>
  );
};

// 歌词弹窗
const LyricModal = ({ lyric, onClose }) => (
  <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={onClose}>
    <div className="bg-card border border-border rounded-lg shadow-brutal-lg max-w-lg w-full max-h-[70vh] overflow-y-auto p-6" onClick={(e) => e.stopPropagation()}>
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
  if (state.isLoading) return <p className="text-muted-foreground font-bold">加载推荐歌单…</p>;
  if (state.isError) return <p className="text-destructive font-bold">加载失败:{String(state.error?.message || state.error)}</p>;
  const tabs = state.data?.tabs || [];
  return (
    <div className="space-y-8 pb-32">
      {tabs.map((tab) => (
        <div key={tab.source}>
          <h3 className="text-lg font-semibold mb-3 pl-2 border-l-4 border-primary text-foreground">{tab.source_name || tab.source}</h3>
          {tab.error && <p className="text-destructive font-bold text-sm mb-2">{tab.error}</p>}
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-4 mt-3">
            {(tab.playlists || []).map((pl) => (
              <div
                key={`${pl.source}-${pl.id}`}
                className="cursor-pointer group border border-border bg-card shadow-brutal-sm transition-all p-2"
                onClick={() => onOpen({ id: pl.id, source: pl.source, name: pl.name })}
              >
                <div className="aspect-square overflow-hidden border border-border bg-muted">
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

// 歌单详情面板
const PlaylistDetailPane = ({ meta, state, onBack, onPlay, onShowLyric, isPlaying }) => {
  const songs = state.data?.songs || [];
  return (
    <div className="pb-32">
      <button onClick={onBack} className="mb-4 px-3 py-1.5 border border-border bg-card font-bold text-sm shadow-brutal-sm transition-all">← 返回推荐歌单</button>
      <h3 className="text-2xl font-bold mb-4">{meta.name}</h3>
      {state.isLoading && <p className="text-muted-foreground font-bold">加载歌单…</p>}
      {state.data?.error && <p className="text-destructive font-bold mb-4">{state.data.error}</p>}
      <div className="space-y-2">
        {songs.map((song, idx) => (
          <SongRow
            key={`${song.source}-${song.id}-${idx}`}
            song={song}
            index={idx}
            isPlaying={isPlaying(song)}
            onPlay={(s) => onPlay(s, songs)}
            onShowLyric={onShowLyric}
          />
        ))}
      </div>
    </div>
  );
};

const Download = ({ downloadRequest }) => {
  const { play, isPlaying } = usePlayer();
  const [tab, setTab] = useState('search');
  const [keyword, setKeyword] = useState('');
  const [query, setQuery] = useState('');
  const [openPlaylist, setOpenPlaylist] = useState(null); // {id, source, name}
  const [lyric, setLyric] = useState(null); // {song, text}

  // 来自发现页「在国内源下载」的预填搜索词:切到搜索 Tab 并自动搜索。
  // 依赖 nonce,保证重复点同一首歌也能再次触发。
  useEffect(() => {
    const kw = downloadRequest?.keyword;
    if (kw) {
      setTab('search');
      setOpenPlaylist(null);
      setKeyword(kw);
      setQuery(kw);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [downloadRequest?.nonce]);

  // 歌曲搜索
  const search = useQuery(
    ['musicdl-search', query],
    () => searchMusic(query, { type: 'song' }),
    { enabled: tab === 'search' && !!query, keepPreviousData: true }
  );

  // 推荐歌单(默认网易云 + QQ)
  const recommend = useQuery(
    ['musicdl-recommend'],
    () => getRecommend(['netease', 'qq']),
    { enabled: tab === 'discover' }
  );

  // 歌单详情
  const playlistDetail = useQuery(
    ['musicdl-playlist', openPlaylist?.id, openPlaylist?.source],
    () => getPlaylistDetail(openPlaylist.id, openPlaylist.source),
    { enabled: !!openPlaylist }
  );

  const handleSearch = (e) => {
    e.preventDefault();
    const k = keyword.trim();
    if (k) setQuery(k);
  };

  const handlePlay = (song) => play(song);

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
            className={`px-4 py-2 border border-border font-bold transition-all ${
              tab === t.key
                ? 'bg-primary text-primary-foreground shadow-brutal-sm'
                : 'bg-card shadow-brutal-sm'
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
          query={query}
          state={search}
          onPlay={handlePlay}
          onShowLyric={handleShowLyric}
          isPlaying={isPlaying}
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
          onShowLyric={handleShowLyric}
          isPlaying={isPlaying}
        />
      )}

      {lyric && <LyricModal lyric={lyric} onClose={() => setLyric(null)} />}
    </div>
  );
};

export default Download;
