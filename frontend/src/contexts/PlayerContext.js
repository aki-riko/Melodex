import React, { createContext, useContext, useRef, useState, useCallback, useEffect } from 'react';
import { SkipBack, SkipForward, Play, Pause, Repeat1, Shuffle, ListOrdered, Volume2, Volume1, VolumeX } from 'lucide-react';
import { getStreamUrl, coverProxyUrl } from '../services/musicdl';

const PlayerContext = createContext(null);

const songKey = (s) => `${s.source}-${s.id}`;

// 播放模式:order 顺序 / repeat 单曲循环 / shuffle 随机
const MODES = ['order', 'repeat', 'shuffle'];

// 音量持久化(纯前端展示偏好,localStorage 即可,无需后端)。
const VOLUME_KEY = 'melodex_volume';
const loadVolume = () => {
  const v = parseFloat(localStorage.getItem(VOLUME_KEY));
  return isFinite(v) && v >= 0 && v <= 1 ? v : 1;
};

// 全局播放器:audio 元素与播放状态常驻 App 顶层,切换页面不中断。
// 支持播放队列(上/下一首)、进度、播放模式、MediaSession(锁屏/通知栏控制)。
export const PlayerProvider = ({ children }) => {
  const [nowPlaying, setNowPlaying] = useState(null);
  const [notice, setNotice] = useState('');
  const [isPaused, setIsPaused] = useState(true);
  const [progress, setProgress] = useState({ cur: 0, dur: 0 });
  const [mode, setMode] = useState('order');
  const [volume, setVolumeState] = useState(loadVolume);
  const [muted, setMuted] = useState(false);
  const audioRef = useRef(null);
  const queueRef = useRef([]); // 当前播放队列
  const triedRef = useRef(new Set()); // 本次已试过的死链,避免循环
  const modeRef = useRef('order');
  useEffect(() => { modeRef.current = mode; }, [mode]);

  // 音量/静音应用到 audio 元素,并持久化音量。
  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.volume = volume;
      audioRef.current.muted = muted;
    }
    localStorage.setItem(VOLUME_KEY, String(volume));
  }, [volume, muted]);

  const setVolume = useCallback((v) => {
    const nv = Math.min(1, Math.max(0, v));
    setVolumeState(nv);
    if (nv > 0) setMuted(false); // 拖动音量自动取消静音
  }, []);

  const toggleMute = useCallback(() => setMuted((m) => !m), []);

  const startPlay = useCallback((song) => {
    setNowPlaying(song);
    setTimeout(() => {
      if (audioRef.current) {
        audioRef.current.src = getStreamUrl(song);
        audioRef.current.play().catch(() => {});
      }
    }, 0);
  }, []);

  // play(song, list):list 为当前列表(队列),用于上/下一首与失败自动跳
  const play = useCallback((song, list = []) => {
    queueRef.current = Array.isArray(list) && list.length ? list : [song];
    triedRef.current = new Set();
    setNotice('');
    startPlay(song);
  }, [startPlay]);

  // 计算下一首:shuffle 随机,repeat 同一首,order 顺序
  const pickNext = useCallback((cur, forward = true) => {
    const list = queueRef.current;
    if (!list.length) return null;
    const idx = list.findIndex((s) => songKey(s) === songKey(cur));
    if (modeRef.current === 'shuffle' && list.length > 1) {
      let r = idx;
      while (r === idx) r = Math.floor(Math.random() * list.length);
      return list[r];
    }
    const step = forward ? 1 : -1;
    const nextIdx = (idx + step + list.length) % list.length;
    return list[nextIdx];
  }, []);

  // 手动下一首/上一首
  const next = useCallback(() => {
    if (!nowPlaying) return;
    triedRef.current = new Set();
    const n = pickNext(nowPlaying, true);
    if (n) startPlay(n);
  }, [nowPlaying, pickNext, startPlay]);

  const prev = useCallback(() => {
    if (!nowPlaying) return;
    triedRef.current = new Set();
    const p = pickNext(nowPlaying, false);
    if (p) startPlay(p);
  }, [nowPlaying, pickNext, startPlay]);

  const togglePlay = useCallback(() => {
    const a = audioRef.current;
    if (!a || !nowPlaying) return;
    if (a.paused) a.play().catch(() => {}); else a.pause();
  }, [nowPlaying]);

  const seek = useCallback((sec) => {
    if (audioRef.current) audioRef.current.currentTime = sec;
  }, []);

  // 播放结束:repeat 重播当前,否则跳下一首
  const handleEnded = useCallback(() => {
    if (modeRef.current === 'repeat' && nowPlaying) { startPlay(nowPlaying); return; }
    next();
  }, [nowPlaying, next, startPlay]);

  // audio 报错(死链/无法播放)→ 自动跳下一首没试过的
  const handleError = useCallback(() => {
    const cur = nowPlaying;
    if (!cur) return;
    triedRef.current.add(songKey(cur));
    const list = queueRef.current;
    const idx = list.findIndex((s) => songKey(s) === songKey(cur));
    const nxt = list.slice(idx + 1).find((s) => !triedRef.current.has(songKey(s)));
    if (nxt) {
      setNotice(`「${cur.name}」该源无法播放,已自动切换…`);
      startPlay(nxt);
    } else {
      setNotice(`「${cur.name}」暂时无法播放(可换源或稍后再试)。`);
    }
  }, [nowPlaying, startPlay]);

  // MediaSession:锁屏/通知栏/蓝牙耳机控制 + 元数据
  useEffect(() => {
    if (!('mediaSession' in navigator)) return;
    if (nowPlaying) {
      navigator.mediaSession.metadata = new window.MediaMetadata({
        title: nowPlaying.name || '',
        artist: nowPlaying.artist || '',
        album: nowPlaying.album || '',
        artwork: nowPlaying.cover ? [{ src: nowPlaying.cover, sizes: '300x300' }] : [],
      });
    }
    navigator.mediaSession.setActionHandler('play', togglePlay);
    navigator.mediaSession.setActionHandler('pause', togglePlay);
    navigator.mediaSession.setActionHandler('previoustrack', prev);
    navigator.mediaSession.setActionHandler('nexttrack', next);
    navigator.mediaSession.setActionHandler('seekto', (d) => { if (d.seekTime != null) seek(d.seekTime); });
  }, [nowPlaying, togglePlay, prev, next, seek]);


  return (
    <PlayerContext.Provider value={{
      nowPlaying, play, audioRef, notice, isPaused, progress, mode, setMode,
      volume, setVolume, muted, toggleMute,
      isPlaying: (s) => nowPlaying && nowPlaying.id === s.id && nowPlaying.source === s.source,
      next, prev, togglePlay, seek, handleError, handleEnded, setIsPaused, setProgress,
      cycleMode: () => setMode((m) => MODES[(MODES.indexOf(m) + 1) % MODES.length]),
    }}>
      {children}
    </PlayerContext.Provider>
  );
};

export const usePlayer = () => {
  const ctx = useContext(PlayerContext);
  if (!ctx) throw new Error('usePlayer 必须在 PlayerProvider 内使用');
  return ctx;
};

const fmtTime = (s) => {
  if (!s || !isFinite(s)) return '0:00';
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
};

const MODE_LABEL = { order: '顺序', repeat: '单曲', shuffle: '随机' };

// 常驻底部播放器条:封面/标题 + 上/播/下 + 进度条 + 播放模式
export const PlayerBar = () => {
  const {
    nowPlaying, audioRef, notice, isPaused, progress, mode,
    next, prev, togglePlay, seek, handleError, handleEnded,
    setIsPaused, setProgress, cycleMode,
    volume, setVolume, muted, toggleMute,
  } = usePlayer();

  const modeIcon = mode === 'repeat'
    ? <Repeat1 size={18} />
    : mode === 'shuffle'
      ? <Shuffle size={18} />
      : <ListOrdered size={18} />;

  // 音量图标:静音/0 → X,低 → Volume1,高 → Volume2
  const effectiveVol = muted ? 0 : volume;
  const volIcon = effectiveVol === 0
    ? <VolumeX size={18} />
    : effectiveVol < 0.5
      ? <Volume1 size={18} />
      : <Volume2 size={18} />;

  return (
    <div className="fixed bottom-0 left-0 right-0 bg-card border-t border-border px-3 py-2 z-40"
      style={{ display: nowPlaying ? 'block' : 'none' }}>
      <div className="max-w-6xl mx-auto">
        {notice && <p className="text-xs text-primary font-medium mb-1">{notice}</p>}
        <div className="flex items-center gap-3">
          {/* 左:封面 + 标题/歌手 */}
          <div className="flex items-center gap-3 min-w-0" style={{ width: '26%' }}>
            {nowPlaying?.cover && (
              <img src={coverProxyUrl(nowPlaying)} alt="" className="w-12 h-12 rounded object-cover flex-shrink-0 shadow" />
            )}
            <div className="min-w-0">
              <p className="truncate font-semibold text-sm">{nowPlaying?.name}</p>
              <p className="text-muted-foreground text-xs truncate">
                {nowPlaying ? `${nowPlaying.artist} · ${nowPlaying.source}` : ''}
              </p>
            </div>
          </div>
          {/* 中:控制按钮 */}
          <button onClick={prev} className="text-muted-foreground hover:text-foreground transition-colors" title="上一首" aria-label="上一首">
            <SkipBack size={20} fill="currentColor" />
          </button>
          <button onClick={togglePlay}
            className="flex items-center justify-center w-10 h-10 rounded-full bg-primary text-primary-foreground hover:scale-105 transition-transform flex-shrink-0"
            title="播放/暂停" aria-label="播放/暂停">
            {isPaused ? <Play size={20} fill="currentColor" /> : <Pause size={20} fill="currentColor" />}
          </button>
          <button onClick={next} className="text-muted-foreground hover:text-foreground transition-colors" title="下一首" aria-label="下一首">
            <SkipForward size={20} fill="currentColor" />
          </button>
          <button onClick={cycleMode}
            className={`transition-colors ${mode === 'order' ? 'text-muted-foreground hover:text-foreground' : 'text-primary'}`}
            title={`播放模式:${MODE_LABEL[mode]}`} aria-label="播放模式">
            {modeIcon}
          </button>
          {/* 右:进度条 */}
          <div className="flex items-center gap-2 flex-grow min-w-0">
            <span className="text-xs text-muted-foreground tabular-nums w-9 text-right">{fmtTime(progress.cur)}</span>
            <input
              type="range" min={0} max={progress.dur || 0} value={progress.cur || 0} step="0.5"
              onChange={(e) => seek(Number(e.target.value))}
              className="flex-grow accent-primary cursor-pointer" aria-label="播放进度"
            />
            <span className="text-xs text-muted-foreground tabular-nums w-9">{fmtTime(progress.dur)}</span>
          </div>
          {/* 音量:仅桌面显示(移动端用系统音量)。点击图标静音/恢复,拖动调音量 */}
          <div className="hidden sm:flex items-center gap-1.5 flex-shrink-0" style={{ width: 120 }}>
            <button onClick={toggleMute}
              className="text-muted-foreground hover:text-foreground transition-colors flex-shrink-0"
              title={muted ? '取消静音' : '静音'} aria-label="静音">
              {volIcon}
            </button>
            <input
              type="range" min={0} max={1} step="0.01" value={effectiveVol}
              onChange={(e) => setVolume(Number(e.target.value))}
              className="flex-grow accent-primary cursor-pointer" aria-label="音量"
            />
          </div>
          <audio
            ref={audioRef}
            onError={handleError}
            onEnded={handleEnded}
            onPlay={() => setIsPaused(false)}
            onPause={() => setIsPaused(true)}
            onTimeUpdate={(e) => setProgress({ cur: e.target.currentTime, dur: e.target.duration || 0 })}
            onLoadedMetadata={(e) => setProgress({ cur: e.target.currentTime, dur: e.target.duration || 0 })}
            style={{ display: 'none' }}
          />
        </div>
      </div>
    </div>
  );
};
