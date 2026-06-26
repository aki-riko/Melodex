import React, { useState } from 'react';
import { useQuery } from 'react-query';
import { getPlaylistDetail, getLyric } from '../services/musicdl';
import SongRow from './SongRow';
import { usePlayer } from '../contexts/PlayerContext';

// 歌单歌曲列表(点开某歌单后)
const PlaylistSongs = ({ meta, onBack }) => {
  const { play, isPlaying } = usePlayer();
  const [lyric, setLyric] = useState(null);
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
  return (
    <div className="pb-32">
      <button
        onClick={onBack}
        className="mb-4 px-3 py-1.5 border-2 border-border bg-card font-bold text-sm shadow-brutal-sm transition-all hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-none"
      >
        ← 返回
      </button>
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
            onPlay={(s) => play(s, songs)}
            onShowLyric={showLyric}
          />
        ))}
      </div>
      {lyric && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={() => setLyric(null)}>
          <div className="bg-card border-2 border-border shadow-brutal-lg max-w-lg w-full max-h-[70vh] overflow-y-auto p-6" onClick={(e) => e.stopPropagation()}>
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
