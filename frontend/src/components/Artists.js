import React, { useState } from 'react';
import { useQuery } from 'react-query';
import { searchMusic, getLyric } from '../services/musicdl';
import SongRow from './SongRow';
import { usePlayer } from '../contexts/PlayerContext';

// 艺人:国内源没有"艺人榜"接口,改为按歌手名搜索其歌曲。
const Artists = () => {
  const { play, isPlaying } = usePlayer();
  const [keyword, setKeyword] = useState('');
  const [query, setQuery] = useState('');
  const [lyric, setLyric] = useState(null);

  const state = useQuery(
    ['artist-search', query],
    () => searchMusic(query, { type: 'song', exactArtist: query }),
    { enabled: !!query, keepPreviousData: true }
  );

  const submit = (e) => {
    e.preventDefault();
    const k = keyword.trim();
    if (k) setQuery(k);
  };

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
  return (
    <div className="max-w-5xl mx-auto pb-32">
      <h1 className="text-4xl font-semibold mb-2 text-foreground">
        艺人
      </h1>
      <p className="text-muted-foreground mb-6 mt-3">输入歌手名,查看 TA 的歌曲(国内多源)。</p>

      <form onSubmit={submit} className="flex gap-2 mb-6">
        <input
          type="text"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          placeholder="输入歌手名,如 周杰伦…"
          className="flex-grow px-4 py-3 border border-border rounded-md bg-card font-medium outline-none transition-shadow"
        />
        <button type="submit" className="px-6 py-3 border border-border rounded-md bg-primary text-primary-foreground font-semibold transition-colors hover:bg-[#106EBE]">
          搜索
        </button>
      </form>

      {state.isLoading && <p className="text-muted-foreground font-medium">搜索中…</p>}
      {query && !state.isLoading && songs.length === 0 && <p className="text-muted-foreground">没有找到该歌手的歌曲。</p>}

      <div className="space-y-2">
        {songs.map((song, idx) => (
          <SongRow
            key={`${song.source}-${song.id}-${idx}`}
            song={song}
            index={idx}
            isPlaying={isPlaying(song)}
            onPlay={(s) => play(s, songs)}
            onShowLyric={showLyric}
          />
        ))}
      </div>

      {lyric && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={() => setLyric(null)}>
          <div className="bg-card border border-border rounded-lg max-w-lg w-full max-h-[70vh] overflow-y-auto p-6" onClick={(e) => e.stopPropagation()}>
            <div className="flex justify-between items-start mb-4">
              <div>
                <h3 className="text-xl font-semibold">{lyric.song.name}</h3>
                <p className="text-muted-foreground text-sm">{lyric.song.artist}</p>
              </div>
              <button onClick={() => setLyric(null)} className="font-bold text-2xl leading-none hover:text-primary transition-colors">×</button>
            </div>
            <pre className="whitespace-pre-wrap text-foreground text-sm font-sans">{lyric.text}</pre>
          </div>
        </div>
      )}
    </div>
  );
};

export default Artists;
