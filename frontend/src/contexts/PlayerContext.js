import React, { createContext, useContext, useRef, useState, useCallback } from 'react';
import { getStreamUrl } from '../services/musicdl';

const PlayerContext = createContext(null);

// 全局播放器:audio 元素与播放状态常驻 App 顶层,切换页面(section)不中断播放。
export const PlayerProvider = ({ children }) => {
  const [nowPlaying, setNowPlaying] = useState(null);
  const [notice, setNotice] = useState(''); // 自动跳源等提示
  const audioRef = useRef(null);
  const listRef = useRef([]); // 当前播放上下文的歌曲列表(用于失败自动跳下一首)
  const triedRef = useRef(new Set()); // 本次已试过的死链,避免循环

  const songKey = (s) => `${s.source}-${s.id}`;

  const startPlay = useCallback((song) => {
    setNowPlaying(song);
    setTimeout(() => {
      if (audioRef.current) {
        audioRef.current.src = getStreamUrl(song);
        audioRef.current.play().catch(() => {});
      }
    }, 0);
  }, []);

  // play(song, list):list 为当前列表,播放失败(死链)时自动跳到 list 里下一首可播的
  const play = useCallback((song, list = []) => {
    listRef.current = Array.isArray(list) ? list : [];
    triedRef.current = new Set();
    setNotice('');
    startPlay(song);
  }, [startPlay]);

  // audio 报错(死链/无法播放)→ 自动跳下一首
  const handleError = useCallback(() => {
    const cur = nowPlaying;
    if (!cur) return;
    triedRef.current.add(songKey(cur));
    const list = listRef.current;
    const idx = list.findIndex((s) => songKey(s) === songKey(cur));
    // 从当前位置往后找没试过的
    const next = list.slice(idx + 1).find((s) => !triedRef.current.has(songKey(s)));
    if (next) {
      setNotice(`「${cur.name}」该源无法播放,已自动切换…`);
      startPlay(next);
    } else {
      setNotice(`「${cur.name}」暂时无法播放(可换源或稍后再试)。`);
    }
  }, [nowPlaying, startPlay]);

  const isPlaying = useCallback(
    (song) => nowPlaying && nowPlaying.id === song.id && nowPlaying.source === song.source,
    [nowPlaying]
  );

  return (
    <PlayerContext.Provider value={{ nowPlaying, play, isPlaying, audioRef, handleError, notice }}>
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
  const { nowPlaying, audioRef, handleError, notice } = usePlayer();
  return (
    <div
      className="fixed bottom-0 left-0 right-0 bg-card border-t-2 border-border p-3 z-40 shadow-brutal-lg"
      style={{ display: nowPlaying ? 'block' : 'none' }}
    >
      <div className="max-w-5xl mx-auto">
        {notice && <p className="text-sm text-primary font-bold mb-1">{notice}</p>}
        <div className="flex items-center gap-4">
          <div className="min-w-0">
            <p className="truncate font-bold">{nowPlaying?.name}</p>
            <p className="text-muted-foreground text-sm truncate">
              {nowPlaying ? `${nowPlaying.artist} · ${nowPlaying.source}` : ''}
            </p>
          </div>
          {/* audio 元素常驻,不随页面切换卸载;onError 触发自动跳下一首 */}
          <audio ref={audioRef} controls className="flex-grow" onError={handleError} />
        </div>
      </div>
    </div>
  );
};
