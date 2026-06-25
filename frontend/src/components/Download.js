import React, { useState, useRef } from 'react';
import { useQuery } from 'react-query';
import {
  searchMusic,
  getRecommend,
  getPlaylistDetail,
  getLyric,
  getStreamUrl,
} from '../services/musicdl';
import SongRow from './SongRow';

const TABS = [
  { key: 'search', label: '歌曲搜索' },
  { key: 'discover', label: '推荐歌单' },
];

// 歌曲搜索面板
const SearchPane = ({ keyword, setKeyword, onSubmit, query, state, onPlay, onShowLyric, isPlaying }) => {
  const songs = state.data?.songs || [];
  return (
    <div>
      <form onSubmit={onSubmit} className="flex gap-2 mb-6">
        <input
          type="text"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          placeholder="输入歌名 / 歌手,或粘贴链接…"
          className="flex-grow px-4 py-3 rounded-lg bg-zinc-900 text-white border border-zinc-700 focus:border-primary outline-none"
        />
        <button type="submit" className="px-6 py-3 rounded-lg bg-primary text-white font-semibold hover:bg-red-600 transition">
          搜索
        </button>
      </form>
      {state.data?.error && <p className="text-yellow-500 mb-4">{state.data.error}</p>}
      {state.isLoading && <p className="text-gray-400">搜索中…</p>}
      {state.isError && <p className="text-red-500">搜索失败:{String(state.error?.message || state.error)}</p>}
      {query && !state.isLoading && songs.length === 0 && !state.data?.error && (
        <p className="text-gray-400">没有找到结果。</p>
      )}
      <div className="space-y-2 pb-32">
        {songs.map((song, idx) => (
          <SongRow
            key={`${song.source}-${song.id}-${idx}`}
            song={song}
            index={idx}
            isPlaying={isPlaying(song)}
            onPlay={onPlay}
            onShowLyric={onShowLyric}
          />
        ))}
      </div>
    </div>
  );
};

// 歌词弹窗
const LyricModal = ({ lyric, onClose }) => (
  <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={onClose}>
    <div className="bg-zinc-900 rounded-lg max-w-lg w-full max-h-[70vh] overflow-y-auto p-6" onClick={(e) => e.stopPropagation()}>
      <div className="flex justify-between items-start mb-4">
        <div>
          <h3 className="text-xl font-bold text-white">{lyric.song.name}</h3>
          <p className="text-gray-400 text-sm">{lyric.song.artist}</p>
        </div>
        <button onClick={onClose} className="text-gray-400 hover:text-white text-2xl leading-none">×</button>
      </div>
      <pre className="whitespace-pre-wrap text-gray-300 text-sm font-sans">{lyric.text}</pre>
    </div>
  </div>
);

// 推荐歌单面板(按源分栏的网格)
const DiscoverPane = ({ state, onOpen }) => {
  if (state.isLoading) return <p className="text-gray-400">加载推荐歌单…</p>;
  if (state.isError) return <p className="text-red-500">加载失败:{String(state.error?.message || state.error)}</p>;
  const tabs = state.data?.tabs || [];
  return (
    <div className="space-y-8 pb-32">
      {tabs.map((tab) => (
        <div key={tab.source}>
          <h3 className="text-xl font-semibold text-white mb-3">{tab.source_name || tab.source}</h3>
          {tab.error && <p className="text-yellow-500 text-sm mb-2">{tab.error}</p>}
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-4">
            {(tab.playlists || []).map((pl) => (
              <div
                key={`${pl.source}-${pl.id}`}
                className="cursor-pointer group"
                onClick={() => onOpen({ id: pl.id, source: pl.source, name: pl.name })}
              >
                <div className="aspect-square rounded-lg overflow-hidden bg-zinc-800">
                  {pl.cover && (
                    <img src={pl.cover} alt={pl.name} loading="lazy" className="w-full h-full object-cover group-hover:scale-105 transition" />
                  )}
                </div>
                <p className="text-sm text-white mt-2 line-clamp-2">{pl.name}</p>
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
      <button onClick={onBack} className="mb-4 text-primary hover:text-white transition">← 返回推荐歌单</button>
      <h3 className="text-2xl font-bold text-white mb-4">{meta.name}</h3>
      {state.isLoading && <p className="text-gray-400">加载歌单…</p>}
      {state.data?.error && <p className="text-yellow-500 mb-4">{state.data.error}</p>}
      <div className="space-y-2">
        {songs.map((song, idx) => (
          <SongRow
            key={`${song.source}-${song.id}-${idx}`}
            song={song}
            index={idx}
            isPlaying={isPlaying(song)}
            onPlay={onPlay}
            onShowLyric={onShowLyric}
          />
        ))}
      </div>
    </div>
  );
};

const Download = () => {
  const [tab, setTab] = useState('search');
  const [keyword, setKeyword] = useState('');
  const [query, setQuery] = useState('');
  const [nowPlaying, setNowPlaying] = useState(null);
  const [openPlaylist, setOpenPlaylist] = useState(null); // {id, source, name}
  const [lyric, setLyric] = useState(null); // {song, text}
  const audioRef = useRef(null);

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

  const handlePlay = (song) => {
    setNowPlaying(song);
    setTimeout(() => {
      if (audioRef.current) {
        audioRef.current.src = getStreamUrl(song);
        audioRef.current.play().catch(() => {});
      }
    }, 0);
  };

  const handleShowLyric = async (song) => {
    setLyric({ song, text: '加载中…' });
    try {
      const text = await getLyric(song);
      setLyric({ song, text: text || '无歌词' });
    } catch (e) {
      setLyric({ song, text: '歌词加载失败' });
    }
  };

  const isPlaying = (song) =>
    nowPlaying && nowPlaying.id === song.id && nowPlaying.source === song.source;

  return (
    <div className="max-w-5xl mx-auto">
      <h2 className="text-3xl font-bold text-primary mb-2">下载 · Download</h2>
      <p className="text-gray-400 mb-4">
        从国内多源(网易云 / QQ / 酷狗 / 酷我 / 咪咕 / 汽水 等)搜索并下载,支持粘贴歌曲/歌单链接。
      </p>


      <div className="flex gap-2 mb-6 border-b border-zinc-800">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => {
              setTab(t.key);
              setOpenPlaylist(null);
            }}
            className={`px-4 py-2 -mb-px border-b-2 transition ${
              tab === t.key
                ? 'border-primary text-white'
                : 'border-transparent text-gray-400 hover:text-white'
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

      {nowPlaying && (
        <div className="fixed bottom-0 left-0 right-0 bg-zinc-950 border-t border-zinc-800 p-3 z-40">
          <div className="max-w-5xl mx-auto flex items-center gap-4">
            <div className="min-w-0">
              <p className="text-white truncate font-semibold">{nowPlaying.name}</p>
              <p className="text-gray-400 text-sm truncate">
                {nowPlaying.artist} · {nowPlaying.source}
              </p>
            </div>
            <audio ref={audioRef} controls className="flex-grow" />
          </div>
        </div>
      )}
    </div>
  );
};

export default Download;
