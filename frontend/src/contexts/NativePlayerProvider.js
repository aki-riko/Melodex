import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getStreamUrl, coverProxyUrl, recordPlayHistory, saveToServer, serverSaveSucceeded } from '../services/musicdl.js';
import { normalizeSong } from '../utils/songFields.js';
import { songIdentityKey } from '../utils/songIdentity.js';
import { useAuth } from './AuthContext.js';
import { useServerDownloads } from './ServerDownloadsContext.js';
import { autoDownloadOnPlayPlan, retainAutoDownloadAttempt } from './playerAutoDownload.js';
import { nextPlaybackMode } from './playerQueue.js';
import {
  createSleepTimer,
  getSleepTimerRemainingMs,
  loadStopAfterTrackPreference,
  saveStopAfterTrackPreference,
} from './playerSleepTimer.js';
import {
  armSeekTarget,
  beginScrub,
  createScrubState,
  endScrub,
  resetScrubState,
  shouldApplyProgressReport,
} from './playerScrub.js';
import {
  NativePlayback,
  buildNativeQueue,
  nativePlaybackSnapshot,
} from './nativePlayback.js';

const VOLUME_KEY = 'melodex_volume';
const MODE_KEY = 'melodex_play_mode';
const playbackKey = (userId) => `melodex_playback_${userId || 'anon'}`;

const loadVolume = () => {
  const value = Number.parseFloat(localStorage.getItem(VOLUME_KEY));
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : 1;
};

const loadMode = () => {
  const value = localStorage.getItem(MODE_KEY);
  return ['order', 'loop', 'repeat', 'shuffle'].includes(value) ? value : 'loop';
};

export default function NativePlayerProvider({ context: PlayerContext, children }) {
  const [nowPlaying, setNowPlaying] = useState(null);
  const [notice, setNotice] = useState('');
  const [isPaused, setIsPaused] = useState(true);
  const [progress, setProgress] = useState({ cur: 0, dur: 0 });
  const [mode, setModeState] = useState(loadMode);
  const [volume, setVolumeState] = useState(loadVolume);
  const [muted, setMuted] = useState(false);
  const [queue, setQueue] = useState([]);
  const [sleepTimer, setSleepTimer] = useState(null);
  const [sleepRemainingMs, setSleepRemainingMs] = useState(0);
  const [sleepStopAfterTrack, setSleepStopAfterTrackState] = useState(loadStopAfterTrackPreference);
  const audioRef = useRef(null);
  const queueRef = useRef([]);
  const nowPlayingRef = useRef(null);
  const modeRef = useRef(mode);
  const volumeRef = useRef(volume);
  const mutedRef = useRef(muted);
  const sleepTimerRef = useRef(null);
  const pendingStopAfterTrackRef = useRef(false);
  const sleepStopAfterTrackRef = useRef(sleepStopAfterTrack);
  const restoredRef = useRef(false);
  const recordedSongRef = useRef('');
  const autoDownloadedRef = useRef(new Set());
  const lastSavedAtRef = useRef(0);
  // 拖动仲裁(见 playerScrub.js)。原生侧尤其需要:插件每 500ms 轮询一次
  // player.currentPosition,拖动中的旧 positionMs 会盖掉刚拖到的新位置
  // —— 这就是手机端"拖完回弹"的直接原因。
  const scrubRef = useRef(createScrubState());
  const { user, offline } = useAuth();
  const { downloadedCopy } = useServerDownloads();
  const userId = user?.id || 0;

  useEffect(() => { nowPlayingRef.current = nowPlaying; }, [nowPlaying]);
  useEffect(() => { modeRef.current = mode; localStorage.setItem(MODE_KEY, mode); }, [mode]);
  useEffect(() => { volumeRef.current = volume; localStorage.setItem(VOLUME_KEY, String(volume)); }, [volume]);
  useEffect(() => { mutedRef.current = muted; }, [muted]);
  useEffect(() => { sleepTimerRef.current = sleepTimer; }, [sleepTimer]);
  useEffect(() => {
    sleepStopAfterTrackRef.current = sleepStopAfterTrack;
    saveStopAfterTrackPreference(sleepStopAfterTrack);
    const timer = sleepTimerRef.current;
    if (timer) {
      NativePlayback.setSleepTimer({
        deadlineMs: timer.endsAt,
        mode: sleepStopAfterTrack ? 'track' : 'immediate',
      }).catch((error) => console.warn('同步原生睡眠定时模式失败', error));
    }
  }, [sleepStopAfterTrack]);

  const savePlayback = useCallback((cur) => {
    try {
      const song = nowPlayingRef.current;
      if (!song) return;
      localStorage.setItem(playbackKey(userId), JSON.stringify({
        song,
        queue: queueRef.current,
        cur: Math.max(0, Number(cur) || 0),
      }));
    } catch {
      // localStorage 配额或隐私模式异常不影响播放。
    }
  }, [userId]);

  const recordStartedSong = useCallback((song) => {
    if (offline || !song) return;
    const key = songIdentityKey(song);
    if (!key || recordedSongRef.current === key) return;
    recordedSongRef.current = key;
    Promise.resolve(recordPlayHistory(song)).catch((error) => console.warn('记录播放历史失败', error));
    const plan = autoDownloadOnPlayPlan(song, downloadedCopy);
    if (!plan.download || autoDownloadedRef.current.has(key)) return;
    autoDownloadedRef.current.add(key);
    saveToServer(song)
      .then((result) => {
        if (serverSaveSucceeded(result)) return;
        // 升级失败即放弃本次会话(保留 key 不再重试);首次下载失败保留重试语义。
        retainAutoDownloadAttempt(autoDownloadedRef.current, key, plan.upgrade);
      })
      .catch((error) => {
        retainAutoDownloadAttempt(autoDownloadedRef.current, key, plan.upgrade);
        console.warn('原生播放自动下载失败', error);
      });
  }, [downloadedCopy, offline]);

  const applyNativeState = useCallback((rawState) => {
    const snapshot = nativePlaybackSnapshot(rawState, queueRef.current);
    if (snapshot.song) {
      const changed = songIdentityKey(nowPlayingRef.current || {}) !== songIdentityKey(snapshot.song);
      nowPlayingRef.current = snapshot.song;
      setNowPlaying(snapshot.song);
      if (changed || snapshot.isPlaying) recordStartedSong(snapshot.song);
      // 原生切歌(自动续播/锁屏上一首)时上一首的闸门必须清掉。
      if (changed) resetScrubState(scrubRef.current);
    }
    // 拖动中或跳转尚未到位时,原生的 positionMs 是"旧位置",写进去就是回弹。
    // 但时长不受闸门影响(它只跟这首歌有关,拖动不会改变它)。
    const progressApplies = shouldApplyProgressReport(scrubRef.current, snapshot.progress.cur);
    if (progressApplies) {
      setProgress(snapshot.progress);
    } else {
      setProgress((current) => ({ cur: current.cur, dur: snapshot.progress.dur || current.dur }));
    }
    setIsPaused(snapshot.isPaused);

    // 快照只存已落到界面的位置,否则回弹前的旧值会被持久化。
    const now = Date.now();
    if (progressApplies && (now - lastSavedAtRef.current >= 5000 || snapshot.isPaused)) {
      lastSavedAtRef.current = now;
      savePlayback(snapshot.progress.cur);
    }

    const timer = sleepTimerRef.current;
    if (timer && snapshot.isPaused && Date.now() >= timer.endsAt) {
      const stoppedAfterTrack = timer.pendingEndOfTrack || pendingStopAfterTrackRef.current;
      pendingStopAfterTrackRef.current = false;
      sleepTimerRef.current = null;
      setSleepTimer(null);
      setSleepRemainingMs(0);
      setNotice(stoppedAfterTrack ? '睡眠定时已在本曲结束后停止播放。' : '睡眠定时已停止播放。');
    }

    if (pendingStopAfterTrackRef.current && snapshot.isPaused && !snapshot.playWhenReady) {
      pendingStopAfterTrackRef.current = false;
      sleepTimerRef.current = null;
      setSleepTimer(null);
      setSleepRemainingMs(0);
      NativePlayback.setStopAfterCurrent({ enabled: false }).catch((error) => console.warn('恢复连续播放模式失败', error));
      setNotice('睡眠定时已在本曲结束后停止播放。');
    }
  }, [recordStartedSong, savePlayback]);

  useEffect(() => {
    let cancelled = false;
    const handles = [];
    const connect = async () => {
      const stateHandle = await NativePlayback.addListener('playbackState', (state) => {
        if (!cancelled) applyNativeState(state);
      });
      handles.push(stateHandle);
      const errorHandle = await NativePlayback.addListener('playbackError', (error) => {
        if (!cancelled) {
          setIsPaused(true);
          setNotice(`原生播放器错误：${error?.message || '未知错误'}`);
        }
      });
      handles.push(errorHandle);
    };
    connect().catch((error) => setNotice(`连接原生播放器失败：${error?.message || error}`));
    return () => {
      cancelled = true;
      handles.forEach((handle) => handle.remove().catch(() => {}));
    };
  }, [applyNativeState]);

  const nativeQueue = useCallback((songs) => buildNativeQueue(songs, {
    streamUrl: getStreamUrl,
    coverUrl: coverProxyUrl,
  }), []);

  const setNativeQueue = useCallback(async (songs, startIndex, positionSeconds = 0) => {
    await NativePlayback.setQueue({
      items: nativeQueue(songs),
      startIndex,
      positionMs: Math.max(0, Number(positionSeconds) || 0) * 1000,
    });
    await NativePlayback.setPlaybackMode({ mode: modeRef.current });
    await NativePlayback.setVolume({ volume: mutedRef.current ? 0 : volumeRef.current });
  }, [nativeQueue]);

  useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;
    let saved = null;
    try {
      const raw = localStorage.getItem(playbackKey(userId));
      saved = raw ? JSON.parse(raw) : null;
    } catch {
      saved = null;
    }
    const restoredQueue = saved?.song
      ? (Array.isArray(saved.queue) && saved.queue.length ? saved.queue : [saved.song]).map(normalizeSong)
      : [];
    if (restoredQueue.length) {
      queueRef.current = restoredQueue;
      setQueue(restoredQueue);
      nowPlayingRef.current = normalizeSong(saved.song);
      setNowPlaying(nowPlayingRef.current);
      setProgress({ cur: Math.max(0, Number(saved.cur) || 0), dur: Number(saved.song.duration) || 0 });
    }
    NativePlayback.getState().then(async (state) => {
      if (state?.mediaItemCount > 0) {
        applyNativeState(state);
        return;
      }
      if (!restoredQueue.length) return;
      const targetKey = songIdentityKey(saved.song);
      const index = Math.max(0, restoredQueue.findIndex((song) => songIdentityKey(song) === targetKey));
      await setNativeQueue(restoredQueue, index, saved.cur);
    }).catch((error) => setNotice(`恢复原生播放器失败：${error?.message || error}`));
  }, [applyNativeState, setNativeQueue, userId]);

  const play = useCallback(async (song, list = []) => {
    const target = normalizeSong(song);
    const nextQueue = (Array.isArray(list) && list.length ? list : [target]).map(normalizeSong);
    const targetKey = songIdentityKey(target);
    const startIndex = Math.max(0, nextQueue.findIndex((item) => songIdentityKey(item) === targetKey));
    queueRef.current = nextQueue;
    setQueue(nextQueue);
    nowPlayingRef.current = target;
    setNowPlaying(target);
    setNotice('');
    try {
      await setNativeQueue(nextQueue, startIndex, 0);
      await NativePlayback.play();
    } catch (error) {
      setIsPaused(true);
      setNotice(`原生播放失败：${error?.message || error}`);
    }
  }, [setNativeQueue]);

  const playFromQueue = useCallback((song) => play(song, queueRef.current), [play]);
  const next = useCallback(() => NativePlayback.next().catch((error) => setNotice(`切换下一首失败：${error?.message || error}`)), []);
  const prev = useCallback(() => NativePlayback.previous().catch((error) => setNotice(`切换上一首失败：${error?.message || error}`)), []);
  const togglePlay = useCallback(() => {
    const operation = isPaused ? NativePlayback.play() : NativePlayback.pause();
    operation.catch((error) => setNotice(`播放控制失败：${error?.message || error}`));
  }, [isPaused]);
  const seek = useCallback((seconds) => {
    const value = Math.max(0, Number(seconds) || 0);
    setProgress((current) => ({ ...current, cur: value }));
    // 立刻立闸:原生 seekTo 是异步 IPC,而插件每 500ms 还会报一次旧位置,
    // 不压住的话下一次轮询就把拇指位置顶掉(手机端回弹的主因)。
    armSeekTarget(scrubRef.current, value);
    NativePlayback.seekTo({ positionMs: value * 1000 }).catch((error) => setNotice(`跳转进度失败：${error?.message || error}`));
  }, []);

  // 进度条拖动句柄:与 Web 端同一套语义(拖动中只认拇指)。
  const scrubHandlers = useMemo(() => ({
    onPointerDown: () => beginScrub(scrubRef.current),
    onPointerUp: () => endScrub(scrubRef.current),
    onPointerCancel: () => endScrub(scrubRef.current),
    onBlur: () => endScrub(scrubRef.current),
    onKeyDown: (event) => {
      if (['ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) {
        beginScrub(scrubRef.current);
      }
    },
    onKeyUp: () => endScrub(scrubRef.current),
  }), []);

  const setMode = useCallback((nextValue) => {
    setModeState((current) => {
      const value = typeof nextValue === 'function' ? nextValue(current) : nextValue;
      modeRef.current = value;
      NativePlayback.setPlaybackMode({ mode: value }).catch((error) => console.warn('切换原生播放模式失败', error));
      return value;
    });
  }, []);
  const cycleMode = useCallback(() => setMode((current) => nextPlaybackMode(current)), [setMode]);

  const setVolume = useCallback((nextVolume) => {
    const value = Math.min(1, Math.max(0, Number(nextVolume) || 0));
    volumeRef.current = value;
    setVolumeState(value);
    if (value > 0) {
      mutedRef.current = false;
      setMuted(false);
    }
    NativePlayback.setVolume({ volume: value }).catch((error) => console.warn('设置原生音量失败', error));
  }, []);
  const toggleMute = useCallback(() => {
    setMuted((current) => {
      const nextMuted = !current;
      mutedRef.current = nextMuted;
      NativePlayback.setVolume({ volume: nextMuted ? 0 : volumeRef.current }).catch((error) => console.warn('切换原生静音失败', error));
      return nextMuted;
    });
  }, []);

  const clearSleepTimer = useCallback(() => {
    sleepTimerRef.current = null;
    pendingStopAfterTrackRef.current = false;
    setSleepTimer(null);
    setSleepRemainingMs(0);
    NativePlayback.clearSleepTimer().catch((error) => console.warn('取消原生睡眠定时失败', error));
    NativePlayback.setStopAfterCurrent({ enabled: false }).catch(() => {});
  }, []);
  const startSleepTimer = useCallback((minutes) => {
    const timer = createSleepTimer(minutes);
    if (!timer) return;
    sleepTimerRef.current = timer;
    setSleepTimer(timer);
    setSleepRemainingMs(getSleepTimerRemainingMs(timer));
    NativePlayback.setSleepTimer({
      deadlineMs: timer.endsAt,
      mode: sleepStopAfterTrackRef.current ? 'track' : 'immediate',
    }).catch((error) => setNotice(`设置原生睡眠定时失败：${error?.message || error}`));
    setNotice(`睡眠定时已设置为 ${minutes} 分钟。`);
  }, []);
  const cancelSleepTimer = useCallback(() => {
    clearSleepTimer();
    setNotice('睡眠定时已取消。');
  }, [clearSleepTimer]);
  const setSleepStopAfterTrack = useCallback((enabled) => setSleepStopAfterTrackState(Boolean(enabled)), []);

  useEffect(() => {
    if (!sleepTimer) return undefined;
    const tick = () => {
      const timer = sleepTimerRef.current;
      if (!timer) return;
      const remaining = getSleepTimerRemainingMs(timer);
      setSleepRemainingMs(remaining);
      if (remaining > 0) return;
      if (sleepStopAfterTrack && !isPaused) {
        if (!pendingStopAfterTrackRef.current) {
          pendingStopAfterTrackRef.current = true;
          setSleepTimer((current) => current ? { ...current, pendingEndOfTrack: true } : current);
          setNotice('睡眠定时已到点，播完当前歌曲后停止。');
        }
        return;
      }
      if (!isPaused) {
        // 原生服务负责锁屏场景；前台同时发一次暂停，覆盖 JS tick 与原生
        // 截止任务在同一时刻竞争时先清理原生任务的竞态。
        NativePlayback.pause().catch((error) => console.warn('睡眠定时暂停失败', error));
        setNotice('睡眠定时已停止播放。');
      }
      clearSleepTimer();
    };
    tick();
    const timerID = window.setInterval(tick, 1000);
    return () => window.clearInterval(timerID);
  }, [clearSleepTimer, isPaused, sleepStopAfterTrack, sleepTimer]);

  const noop = useCallback(() => {}, []);
  return (
    <PlayerContext.Provider value={{
      nowPlaying,
      play,
      audioRef,
      notice,
      isPaused,
      progress,
      mode,
      setMode,
      volume,
      setVolume,
      muted,
      toggleMute,
      cachedCoverUrl: '',
      queue,
      playFromQueue,
      sleepTimer,
      sleepRemainingMs,
      sleepStopAfterTrack,
      startSleepTimer,
      cancelSleepTimer,
      setSleepStopAfterTrack,
      isPlaying: (song) => Boolean(nowPlaying) && songIdentityKey(nowPlaying) === songIdentityKey(song),
      next,
      prev,
      togglePlay,
      seek,
      handleError: noop,
      handleEnded: noop,
      handlePlay: noop,
      handlePlaying: noop,
      handlePause: noop,
      handleBufferEvent: noop,
      setIsPaused,
      setProgress,
      handleTimeUpdate: noop,
      handleLoadedMetadata: noop,
      savePlayback,
      cycleMode,
      scrubHandlers,
      usesNativePlayback: true,
    }}>
      {children}
    </PlayerContext.Provider>
  );
}
