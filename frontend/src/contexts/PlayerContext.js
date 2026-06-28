import React, { createContext, useContext, useRef, useState, useCallback, useEffect } from 'react';
import { SkipBack, SkipForward, Play, Pause, Repeat1, Repeat, Shuffle, ListOrdered, Volume2, Volume1, VolumeX, ListMusic, ChevronDown, Heart } from 'lucide-react';
import { getStreamUrl, coverProxyUrl, getLyric, getFavoriteStatus, toggleFavorite } from '../services/musicdl';
import { useAuth } from './AuthContext';

const PlayerContext = createContext(null);

const songKey = (s) => `${s.source}-${s.id}`;

// 播放模式:order 顺序 / repeat 单曲循环 / shuffle 随机
// 播放模式:shuffle 随机 / order 顺序(放完停) / repeat 单曲循环 / loop 列表循环(放完从头)
const MODES = ['order', 'loop', 'repeat', 'shuffle'];

// 音量持久化(纯前端展示偏好,localStorage 即可,无需后端)。
const VOLUME_KEY = 'melodex_volume';
const loadVolume = () => {
  const v = parseFloat(localStorage.getItem(VOLUME_KEY));
  return isFinite(v) && v >= 0 && v <= 1 ? v : 1;
};

// 播放进度记忆:按登录用户隔离存上次播放的歌/队列/进度(localStorage,本地恢复零延迟、
// 不打后端、按 user.id 区分)。浏览器禁 autoplay,故恢复时只加载+定位不自动播放。
const playbackKey = (userId) => `melodex_playback_${userId || 'anon'}`;

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
  const [queue, setQueue] = useState([]); // 当前播放队列(state 副本,供队列面板渲染)
  const audioRef = useRef(null);
  const queueRef = useRef([]); // 当前播放队列(ref,供 next/prev 等回调读取免闭包陈旧)
  const triedRef = useRef(new Set()); // 本次已试过的死链,避免循环
  const modeRef = useRef('order');
  useEffect(() => { modeRef.current = mode; }, [mode]);

  const { user } = useAuth();
  const userId = user?.id || 0;
  const resumeRef = useRef(null);   // 待恢复的进度秒数(audio 加载完成后 seek 到这里)
  const restoredRef = useRef(false); // 防重复恢复

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

  // 恢复上次播放:登录后(userId 确定)读 localStorage,加载上次的歌+队列+进度,
  // 但不自动播放(浏览器禁 autoplay)——只把进度暂存 resumeRef,onLoadedMetadata 时 seek。
  useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;
    try {
      const raw = localStorage.getItem(playbackKey(userId));
      if (!raw) return;
      const saved = JSON.parse(raw);
      if (!saved || !saved.song) return;
      const q = Array.isArray(saved.queue) && saved.queue.length ? saved.queue : [saved.song];
      queueRef.current = q;
      setQueue(q);
      resumeRef.current = saved.cur > 0 ? saved.cur : null;
      setNowPlaying(saved.song);
      // 预载音频(paused 状态),onLoadedMetadata 会 seek 到 resumeRef
      setTimeout(() => {
        if (audioRef.current) audioRef.current.src = getStreamUrl(saved.song);
      }, 0);
    } catch { /* 损坏数据忽略 */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  // 保存当前播放快照(节流:由调用点控制频率)。
  const savePlayback = useCallback((cur) => {
    try {
      const song = nowPlaying;
      if (!song) return;
      localStorage.setItem(playbackKey(userId), JSON.stringify({
        song,
        queue: queueRef.current,
        cur: cur > 0 ? cur : 0,
      }));
    } catch { /* 配额满等忽略 */ }
  }, [nowPlaying, userId]);

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
    const q = Array.isArray(list) && list.length ? list : [song];
    queueRef.current = q;
    setQueue(q);
    triedRef.current = new Set();
    setNotice('');
    startPlay(song);
  }, [startPlay]);

  // playFromQueue:从队列面板点击某首,直接播放(不改变队列)
  const playFromQueue = useCallback((song) => {
    triedRef.current = new Set();
    setNotice('');
    startPlay(song);
  }, [startPlay]);

  // 计算下一首。auto=true 表示自动续播(歌曲自然结束):order 模式到队尾返回 null(停止);
  // auto=false 表示用户手动点上/下一首:任何模式都绕回(不停)。
  // shuffle 随机;loop/repeat/手动 均环绕。
  const pickNext = useCallback((cur, forward = true, auto = false) => {
    const list = queueRef.current;
    if (!list.length) return null;
    const idx = list.findIndex((s) => songKey(s) === songKey(cur));
    if (modeRef.current === 'shuffle' && list.length > 1) {
      let r = idx;
      while (r === idx) r = Math.floor(Math.random() * list.length);
      return list[r];
    }
    const step = forward ? 1 : -1;
    const rawNext = idx + step;
    // order 模式自动续播到队尾后停止(不环绕)。
    if (auto && modeRef.current === 'order' && rawNext >= list.length) {
      return null;
    }
    const nextIdx = (rawNext + list.length) % list.length;
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

  // 进度更新:刷新进度条 + 节流保存播放快照(每 5 秒)。
  const lastSaveRef = useRef(0);
  const handleTimeUpdate = useCallback((e) => {
    const cur = e.target.currentTime;
    const dur = e.target.duration || 0;
    setProgress({ cur, dur });
    const now = Date.now();
    if (now - lastSaveRef.current > 5000) {
      lastSaveRef.current = now;
      savePlayback(cur);
    }
  }, [savePlayback]);

  // 元数据加载完成:更新时长 + 若有待恢复进度则 seek 过去(只定位不播放)。
  const handleLoadedMetadata = useCallback((e) => {
    const dur = e.target.duration || 0;
    setProgress({ cur: e.target.currentTime, dur });
    if (resumeRef.current != null && isFinite(resumeRef.current)) {
      const t = Math.min(resumeRef.current, dur > 0 ? dur - 1 : resumeRef.current);
      if (t > 0) { try { e.target.currentTime = t; } catch { /* ignore */ } }
      resumeRef.current = null;
    }
  }, []);

  // 播放结束:repeat 重播当前,否则跳下一首
  const handleEnded = useCallback(() => {
    if (modeRef.current === 'repeat' && nowPlaying) { startPlay(nowPlaying); return; }
    triedRef.current = new Set();
    const n = pickNext(nowPlaying, true, true); // auto 续播:order 到尾则停
    if (n) startPlay(n);
  }, [nowPlaying, pickNext, startPlay]);

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
      queue, playFromQueue,
      isPlaying: (s) => nowPlaying && nowPlaying.id === s.id && nowPlaying.source === s.source,
      next, prev, togglePlay, seek, handleError, handleEnded, setIsPaused, setProgress,
      handleTimeUpdate, handleLoadedMetadata, savePlayback,
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

const MODE_LABEL = { order: '顺序', loop: '列表循环', repeat: '单曲循环', shuffle: '随机' };

// 跑马灯:文字超出容器宽度才滚动,否则静态显示(避免短标题也无谓滚动)。
const Marquee = ({ text, className }) => {
  const wrapRef = useRef(null);
  const textRef = useRef(null);
  const [scroll, setScroll] = useState(false);
  useEffect(() => {
    const w = wrapRef.current, t = textRef.current;
    if (w && t) setScroll(t.scrollWidth > w.clientWidth + 2);
  }, [text]);
  return (
    <div ref={wrapRef} className={`marquee ${className || ''}`}>
      {scroll ? (
        <span className="marquee__inner"><span ref={textRef}>{text}</span></span>
      ) : (
        <span ref={textRef}>{text}</span>
      )}
    </div>
  );
};

// 解析 LRC 为 [{t, end, text, words}],按时间升序。
//   - 逐字 LRC(QQ:一行多个时间戳,每字一个)→ words=[{t, end, s}],可做卡拉OK填色
//   - 行级 LRC(网易:一行仅一个时间戳)→ words=null,整行高亮
// end = 下一行起始时间(用于算最后一字/整行的结束)。
const parseLRC = (raw) => {
  if (!raw || typeof raw !== 'string') return [];
  const re = /\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
  const toSec = (m) => parseInt(m[1], 10) * 60 + parseInt(m[2], 10) + (m[3] ? parseInt(m[3].padEnd(3, '0'), 10) / 1000 : 0);
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    // 收集本行所有 (时间戳, 其后到下一个时间戳前的文本) 片段
    re.lastIndex = 0;
    const segs = [];
    let m, prev = null, prevEnd = 0;
    while ((m = re.exec(line)) !== null) {
      if (prev !== null) segs.push({ t: prev, s: line.slice(prevEnd, m.index) });
      prev = toSec(m);
      prevEnd = re.lastIndex;
    }
    if (prev !== null) segs.push({ t: prev, s: line.slice(prevEnd) });
    if (segs.length === 0) continue; // 无时间戳:元信息行,跳过

    const text = segs.map((x) => x.s).join('').replace(/\s+$/, '');
    if (!text.trim()) continue;

    // 真逐字 LRC(QQ)每字一个时间戳,过滤空段后仍有多个有效字段;
    // 网易"行首+行尾两个时间戳"过滤空段后只剩 1 个有效字段 → 走整行高亮。
    const words = segs.filter((x) => x.s.length > 0).map((x) => ({ t: x.t, s: x.s }));
    if (words.length >= 2) {
      out.push({ t: segs[0].t, text, words });
    } else {
      out.push({ t: segs[0].t, text, words: null });
    }
  }
  out.sort((a, b) => a.t - b.t);
  // 填充每行/每字的 end = 下一个起点
  for (let i = 0; i < out.length; i++) {
    out[i].end = i + 1 < out.length ? out[i + 1].t : out[i].t + 5;
    if (out[i].words) {
      const w = out[i].words;
      for (let j = 0; j < w.length; j++) w[j].end = j + 1 < w.length ? w[j + 1].t : out[i].end;
    }
  }
  return out;
};

// 当前时间对应的歌词行索引(最后一个 t<=cur)。
const currentLyricIndex = (lines, cur) => {
  if (!lines.length) return -1;
  let lo = 0, hi = lines.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].t <= cur) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
};

// 卡拉OK式当前行:逐字按播放进度填色。已唱字全亮,正在唱的字按时间比例渐变填充,
// 未唱字暗。无字级时间戳(words=null)则整行高亮。
const KaraokeLine = ({ line, cur }) => {
  if (!line.words) {
    return <span className="text-primary font-semibold">{line.text}</span>;
  }
  return (
    <span className="inline">
      {line.words.map((w, i) => {
        let ratio = 0;
        if (cur >= w.end) ratio = 1;
        else if (cur > w.t && w.end > w.t) ratio = (cur - w.t) / (w.end - w.t);
        const pct = Math.max(0, Math.min(1, ratio)) * 100;
        return (
          <span
            key={i}
            style={{
              backgroundImage: `linear-gradient(90deg, hsl(var(--primary)) ${pct}%, hsl(var(--muted-foreground)) ${pct}%)`,
              WebkitBackgroundClip: 'text',
              backgroundClip: 'text',
              color: 'transparent',
              fontWeight: 600,
            }}
          >
            {w.s}
          </span>
        );
      })}
    </span>
  );
};

// 常驻底部播放器条:封面/标题 + 上/播/下 + 进度条 + 播放模式
export const PlayerBar = () => {
  const {
    nowPlaying, audioRef, notice, isPaused, progress, mode,
    next, prev, togglePlay, seek, handleError, handleEnded,
    setIsPaused, setProgress, cycleMode,
    volume, setVolume, muted, toggleMute,
    queue, playFromQueue,
    handleTimeUpdate, handleLoadedMetadata, savePlayback,
  } = usePlayer();

  const [queueOpen, setQueueOpen] = useState(false);
  const [expanded, setExpanded] = useState(false); // 移动端:点击迷你条展开全屏播放页
  const [showLyric, setShowLyric] = useState(false); // 展开页:封面(黑胶)↔ 歌词切换
  const [closing, setClosing] = useState(false); // 展开页收起动画中
  const [lrc, setLrc] = useState([]); // 解析后的同步歌词
  const curKey = nowPlaying ? `${nowPlaying.source}-${nowPlaying.id}` : '';

  // 收藏状态:当前歌切换时查询;点心形切换并乐观更新。
  const [favorited, setFavorited] = useState(false);
  useEffect(() => {
    let cancelled = false;
    if (!nowPlaying) { setFavorited(false); return; }
    getFavoriteStatus(nowPlaying).then((f) => { if (!cancelled) setFavorited(f); });
    return () => { cancelled = true; };
  }, [curKey, nowPlaying]);

  const onToggleFavorite = async () => {
    if (!nowPlaying) return;
    const prev = favorited;
    setFavorited(!prev); // 乐观更新
    try {
      const f = await toggleFavorite(nowPlaying);
      setFavorited(f);
    } catch {
      setFavorited(prev); // 失败回滚
    }
  };

  const expandedRef = useRef(false);
  useEffect(() => { expandedRef.current = expanded; }, [expanded]);

  // 收起播放页。fromPop=true 表示由返回键(popstate)触发,此时不再 history.back
  // (历史已被浏览器弹出);否则主动收起需 history.back() 弹掉展开时压入的历史条目。
  const collapseExpanded = useCallback((fromPop = false) => {
    expandedRef.current = false; // 立即置否,避免 history.back 触发的 popstate 二次收起
    setClosing(true);
    setTimeout(() => { setExpanded(false); setClosing(false); }, 260);
    if (fromPop !== true && window.history.state && window.history.state.playerExpanded) {
      window.history.back();
    }
  }, []);

  // 展开播放页:压入一条带标记的历史,让手机返回键先收起而非退站。
  const openExpanded = useCallback(() => {
    setExpanded(true);
    if (!window.history.state || !window.history.state.playerExpanded) {
      window.history.pushState({ playerExpanded: true }, '');
    }
  }, []);

  // 返回键(popstate):若正展开,拦截为收起播放页(带下滑动画,不再退站)。
  useEffect(() => {
    const onPop = () => {
      if (expandedRef.current) collapseExpanded(true);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [collapseExpanded]);

  // 展开且当前歌变化时拉取并解析歌词(仅在展开播放页用,省请求)。
  useEffect(() => {
    if (!expanded || !nowPlaying) return;
    let cancelled = false;
    setLrc([]);
    getLyric(nowPlaying)
      .then((text) => { if (!cancelled) setLrc(parseLRC(text)); })
      .catch(() => { if (!cancelled) setLrc([]); });
    return () => { cancelled = true; };
  }, [expanded, curKey, nowPlaying]);

  const lyricIdx = currentLyricIndex(lrc, progress.cur);

  // 歌词自动滚动:当前行变化时滚到视图中央。
  const activeLyricRef = useRef(null);
  useEffect(() => {
    if (showLyric && activeLyricRef.current) {
      activeLyricRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [lyricIdx, showLyric]);

  const modeIcon = mode === 'repeat'
    ? <Repeat1 size={18} />
    : mode === 'loop'
      ? <Repeat size={18} />
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
    <>
      {/* ===== 桌面端:完整播放条(原样) ===== */}
      <div className="hidden md:block fixed bottom-0 left-0 right-0 bg-card border-t border-border px-3 py-2 z-40"
        style={{ display: nowPlaying ? undefined : 'none' }}>
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
                className="flex-grow min-w-0 accent-primary cursor-pointer" aria-label="播放进度"
              />
              <span className="text-xs text-muted-foreground tabular-nums w-9">{fmtTime(progress.dur)}</span>
            </div>
            {/* 音量:仅桌面。点击图标静音/恢复,拖动调音量 */}
            <div className="flex items-center gap-1.5 flex-shrink-0" style={{ width: 120 }}>
              <button onClick={toggleMute}
                className="text-muted-foreground hover:text-foreground transition-colors flex-shrink-0"
                title={muted ? '取消静音' : '静音'} aria-label="静音">
                {volIcon}
              </button>
              <input
                type="range" min={0} max={1} step="0.01" value={effectiveVol}
                onChange={(e) => setVolume(Number(e.target.value))}
                className="flex-grow min-w-0 accent-primary cursor-pointer" aria-label="音量"
              />
            </div>
            {/* 播放队列:音量键右侧 */}
            <div className="relative flex-shrink-0">
              <button onClick={() => setQueueOpen((o) => !o)}
                className={`transition-colors ${queueOpen ? 'text-primary' : 'text-muted-foreground hover:text-foreground'}`}
                title="播放队列" aria-label="播放队列">
                <ListMusic size={18} />
              </button>
              {queueOpen && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setQueueOpen(false)} />
                  <div className="absolute bottom-full right-0 mb-3 w-80 max-h-96 overflow-y-auto app-scroll bg-card border border-border rounded-lg shadow-xl z-50">
                    <div className="sticky top-0 bg-card border-b border-border px-3 py-2 flex items-center justify-between">
                      <span className="font-semibold text-sm">播放队列</span>
                      <span className="text-xs text-muted-foreground">{queue.length} 首</span>
                    </div>
                    {queue.length === 0 ? (
                      <p className="text-sm text-muted-foreground px-3 py-4">队列为空</p>
                    ) : (
                      <div className="py-1">
                        {queue.map((s, i) => {
                          const k = `${s.source}-${s.id}`;
                          const active = k === curKey;
                          return (
                            <button key={`${k}-${i}`} onClick={() => { playFromQueue(s); }}
                              className={`w-full flex items-center gap-2 px-3 py-1.5 text-left transition-colors ${active ? 'bg-secondary' : 'hover:bg-secondary/60'}`}>
                              <span className={`w-5 text-right text-xs tabular-nums flex-shrink-0 ${active ? 'text-primary' : 'text-muted-foreground'}`}>
                                {active ? '▶' : i + 1}
                              </span>
                              <div className="min-w-0">
                                <p className={`text-sm truncate ${active ? 'text-primary font-medium' : ''}`}>{s.name}</p>
                                <p className="text-xs text-muted-foreground truncate">{s.artist}{s.source ? ` · ${s.source}` : ''}</p>
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* ===== 移动端:迷你条(封面+名+播放),点击展开全屏播放页 ===== */}
      <div className="md:hidden fixed bottom-14 left-0 right-0 bg-card border-t border-border z-40"
        style={{ display: nowPlaying ? 'block' : 'none' }}>
        {notice && <p className="text-xs text-primary font-medium px-3 pt-1 truncate">{notice}</p>}
        {/* 顶部细进度条 */}
        <div className="h-0.5 bg-secondary">
          <div className="h-full bg-primary" style={{ width: progress.dur ? `${(progress.cur / progress.dur) * 100}%` : '0%' }} />
        </div>
        <div className="flex items-center gap-2 px-3 py-2">
          <button className="flex items-center gap-3 min-w-0 flex-grow text-left" onClick={openExpanded} aria-label="展开播放页">
            {nowPlaying?.cover
              ? <img src={coverProxyUrl(nowPlaying)} alt="" className="w-11 h-11 rounded object-cover flex-shrink-0 shadow" />
              : <div className="w-11 h-11 rounded bg-secondary flex items-center justify-center flex-shrink-0"><ListMusic size={18} className="text-muted-foreground" /></div>}
            <div className="min-w-0">
              <Marquee text={nowPlaying?.name || ''} className="font-semibold text-sm" />
              <p className="text-muted-foreground text-xs truncate">{nowPlaying?.artist}</p>
            </div>
          </button>
          {/* 收藏 */}
          <button onClick={onToggleFavorite} className="flex-shrink-0 p-1" aria-label="收藏">
            <Heart size={22} className={favorited ? 'text-primary' : 'text-muted-foreground'} fill={favorited ? 'currentColor' : 'none'} />
          </button>
          {/* 播放/暂停 */}
          <button onClick={togglePlay}
            className="flex items-center justify-center w-10 h-10 rounded-full bg-primary text-primary-foreground flex-shrink-0"
            aria-label="播放/暂停">
            {isPaused ? <Play size={20} fill="currentColor" /> : <Pause size={20} fill="currentColor" />}
          </button>
          {/* 播放列表 */}
          <button onClick={() => { openExpanded(); setQueueOpen(true); }} className="text-muted-foreground flex-shrink-0 p-1" aria-label="播放列表">
            <ListMusic size={22} />
          </button>
        </div>
      </div>

      {/* ===== 移动端:全屏展开播放页(QQ音乐式) ===== */}
      {expanded && nowPlaying && (
        <div className={`md:hidden fixed inset-0 z-[70] bg-background flex flex-col ${closing ? 'player-sheet-exit' : 'player-sheet-enter'}`}
          style={{ paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'calc(env(safe-area-inset-bottom) + 1rem)' }}>
          {/* 顶部:收起 */}
          <div className="flex items-center justify-between px-4 py-3">
            <button onClick={collapseExpanded} className="text-muted-foreground" aria-label="收起">
              <ChevronDown size={28} />
            </button>
            <span className="text-xs uppercase tracking-wider text-muted-foreground">正在播放</span>
            <span className="w-7" />
          </div>

          {/* 移动端队列覆盖层(展开页内) */}
          {queueOpen && (
            <div className="absolute inset-0 z-[71] bg-background flex flex-col"
              style={{ paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'calc(env(safe-area-inset-bottom) + 1rem)' }}>
              <div className="flex items-center justify-between px-4 py-3 border-b border-border">
                <span className="font-semibold">播放队列 · {queue.length} 首</span>
                <button onClick={() => setQueueOpen(false)} className="text-muted-foreground" aria-label="关闭队列">
                  <ChevronDown size={26} />
                </button>
              </div>
              <div className="flex-grow overflow-y-auto app-scroll py-1">
                {queue.length === 0 ? (
                  <p className="text-sm text-muted-foreground px-4 py-4">队列为空</p>
                ) : queue.map((s, i) => {
                  const k = `${s.source}-${s.id}`;
                  const active = k === curKey;
                  return (
                    <button key={`${k}-${i}`} onClick={() => { playFromQueue(s); setQueueOpen(false); }}
                      className={`w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors ${active ? 'bg-secondary' : ''}`}>
                      <span className={`w-5 text-right text-xs tabular-nums flex-shrink-0 ${active ? 'text-primary' : 'text-muted-foreground'}`}>{active ? '▶' : i + 1}</span>
                      <div className="min-w-0">
                        <p className={`text-sm truncate ${active ? 'text-primary font-medium' : ''}`}>{s.name}</p>
                        <p className="text-xs text-muted-foreground truncate">{s.artist}{s.source ? ` · ${s.source}` : ''}</p>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          {/* 中部:黑胶唱片 ↔ 歌词(点击切换) */}
          <div className="flex-grow flex items-center justify-center px-8 min-h-0 overflow-hidden"
            onClick={() => setShowLyric((v) => !v)}>
            {showLyric ? (
              <div className="fade-in w-full h-full max-w-md overflow-y-auto app-scroll py-8 text-center" aria-label="歌词">
                {lrc.length === 0 ? (
                  <p className="text-muted-foreground mt-10">暂无歌词</p>
                ) : (
                  lrc.map((line, i) => (
                    <p key={i}
                      ref={i === lyricIdx ? activeLyricRef : null}
                      className={`py-1.5 px-2 leading-relaxed ${
                        i === lyricIdx ? 'text-base' : 'text-muted-foreground text-sm'
                      }`}>
                      {i === lyricIdx ? <KaraokeLine line={line} cur={progress.cur} /> : line.text}
                    </p>
                  ))
                )}
              </div>
            ) : (
              <div className="fade-in turntable flex-shrink-0" style={{ width: 'min(78vw, 20rem)', height: 'min(78vw, 20rem)' }}>
                {/* 唱臂:暂停时抬起,播放时落到唱片上 */}
                <div className={`tonearm ${isPaused ? 'up' : 'down'}`}>
                  <div className="tonearm__base" />
                  <div className="tonearm__arm" />
                  <div className="tonearm__head" />
                </div>
                {/* 黑胶唱片 */}
                <div className={`vinyl-wrap vinyl-disc ${isPaused ? 'paused' : ''} w-full h-full`}>
                  {nowPlaying?.cover
                    ? <img src={coverProxyUrl(nowPlaying)} alt=""
                        onError={(e) => { e.currentTarget.style.display = 'none'; }} />
                    : <ListMusic size={64} className="text-muted-foreground" />}
                </div>
              </div>
            )}
          </div>
          <p className="text-center text-xs text-muted-foreground/60">{showLyric ? '点击显示封面' : '点击显示歌词'}</p>
          {/* 标题/歌手 + 收藏 */}
          <div className="px-8 mt-3 flex items-center gap-3">
            <div className="min-w-0 flex-grow">
              <p className="text-xl font-bold truncate">{nowPlaying?.name}</p>
              <p className="text-muted-foreground truncate mt-1">{nowPlaying?.artist}{nowPlaying?.source ? ` · ${nowPlaying.source}` : ''}</p>
            </div>
            <button onClick={onToggleFavorite} className="flex-shrink-0 p-1" aria-label="收藏">
              <Heart size={28} className={favorited ? 'text-primary' : 'text-muted-foreground'} fill={favorited ? 'currentColor' : 'none'} />
            </button>
          </div>
          {/* 进度 */}
          <div className="px-8 mt-5">
            <input
              type="range" min={0} max={progress.dur || 0} value={progress.cur || 0} step="0.5"
              onChange={(e) => seek(Number(e.target.value))}
              className="w-full accent-primary cursor-pointer" aria-label="播放进度"
            />
            <div className="flex justify-between text-xs text-muted-foreground tabular-nums mt-1">
              <span>{fmtTime(progress.cur)}</span>
              <span>{fmtTime(progress.dur)}</span>
            </div>
          </div>
          {/* 控制按钮 */}
          <div className="flex items-center justify-between px-10 mt-6">
            <button onClick={cycleMode}
              className={`${mode === 'order' ? 'text-muted-foreground' : 'text-primary'}`}
              title={`播放模式:${MODE_LABEL[mode]}`} aria-label="播放模式">
              {modeIcon}
            </button>
            <button onClick={prev} className="text-foreground" aria-label="上一首">
              <SkipBack size={32} fill="currentColor" />
            </button>
            <button onClick={togglePlay}
              className="flex items-center justify-center w-16 h-16 rounded-full bg-primary text-primary-foreground"
              aria-label="播放/暂停">
              {isPaused ? <Play size={30} fill="currentColor" /> : <Pause size={30} fill="currentColor" />}
            </button>
            <button onClick={next} className="text-foreground" aria-label="下一首">
              <SkipForward size={32} fill="currentColor" />
            </button>
            <button onClick={() => setQueueOpen((o) => !o)}
              className={queueOpen ? 'text-primary' : 'text-muted-foreground'} aria-label="播放列表">
              <ListMusic size={26} />
            </button>
          </div>
        </div>
      )}

      {/* 全局唯一 audio 元素(桌面/移动共用) */}
      <audio
        ref={audioRef}
        onError={handleError}
        onEnded={handleEnded}
        onPlay={() => setIsPaused(false)}
        onPause={(e) => { setIsPaused(true); savePlayback(e.target.currentTime); }}
        onTimeUpdate={handleTimeUpdate}
        onLoadedMetadata={handleLoadedMetadata}
        style={{ display: 'none' }}
      />
    </>
  );
};
