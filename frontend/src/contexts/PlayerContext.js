import React, { createContext, useContext, useRef, useState, useCallback } from 'react';
import { getStreamUrl } from '../services/musicdl';

const PlayerContext = createContext(null);

// 全局播放器:audio 元素与播放状态常驻 App 顶层,切换页面(section)不中断播放。
export const PlayerProvider = ({ children }) => {
  const [nowPlaying, setNowPlaying] = useState(null);
  const audioRef = useRef(null);

  const play = useCallback((song) => {
    setNowPlaying(song);
    // 等 audio 元素就绪后设源播放
    setTimeout(() => {
      if (audioRef.current) {
        audioRef.current.src = getStreamUrl(song);
        audioRef.current.play().catch(() => {});
      }
    }, 0);
  }, []);

  const isPlaying = useCallback(
    (song) => nowPlaying && nowPlaying.id === song.id && nowPlaying.source === song.source,
    [nowPlaying]
  );

  return (
    <PlayerContext.Provider value={{ nowPlaying, play, isPlaying, audioRef }}>
      {children}
    </PlayerContext.Provider>
  );
};

export const usePlayer = () => {
  const ctx = useContext(PlayerContext);
  if (!ctx) throw new Error('usePlayer 必须在 PlayerProvider 内使用');
  return ctx;
};

// 常驻底部播放器条
export const PlayerBar = () => {
  const { nowPlaying, audioRef } = usePlayer();
  return (
    <div
      className="fixed bottom-0 left-0 right-0 bg-card border-t-2 border-border p-3 z-40 shadow-brutal-lg"
      style={{ display: nowPlaying ? 'block' : 'none' }}
    >
      <div className="max-w-5xl mx-auto flex items-center gap-4">
        <div className="min-w-0">
          <p className="truncate font-bold">{nowPlaying?.name}</p>
          <p className="text-muted-foreground text-sm truncate">
            {nowPlaying ? `${nowPlaying.artist} · ${nowPlaying.source}` : ''}
          </p>
        </div>
        {/* audio 元素常驻,不随页面切换卸载 */}
        <audio ref={audioRef} controls className="flex-grow" />
      </div>
    </div>
  );
};
