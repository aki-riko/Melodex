import React, { useCallback, useEffect, useRef, useState } from 'react';
import { getStreamUrl, coverProxyUrl, recordPlayHistory, saveToServer, serverSaveSucceeded } from '../services/musicdl.js';
import { normalizeSong } from '../utils/songFields.js';
import { songIdentityKey } from '../utils/songIdentity.js';
import { useAuth } from './AuthContext.js';
import { useServerDownloads } from './ServerDownloadsContext.js';
import { shouldAutoDownloadOnPlay } from './playerAutoDownload.js';
import { nextPlaybackMode } from './playerQueue.js';
import {
  createSleepTimer,
  getSleepTimerRemainingMs,
  loadStopAfterTrackPreference,
  saveStopAfterTrackPreference,
} from './playerSleepTimer.js';
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
  const restoredRef = useRef(false);
  const recordedSongRef = useRef('');
  const autoDownloadedRef = useRef(new Set());
  const lastSavedAtRef = useRef(0);
  const { user, offline } = useAuth();
  const { isDownloaded: isServerDownloaded } = useServerDownloads();
  const userId = user?.id || 0;

  useEffect(() => { nowPlayingRef.current = nowPlaying; }, [nowPlaying]);
  useEffect(() => { modeRef.current = mode; localStorage.setItem(MODE_KEY, mode); }, [mode]);
  useEffect(() => { volumeRef.current = volume; localStorage.setItem(VOLUME_KEY, String(volume)); }, [volume]);
  useEffect(() => { mutedRef.current = muted; }, [muted]);
  useEffect(() => { sleepTimerRef.current = sleepTimer; }, [sleepTimer]);
  useEffect(() => { saveStopAfterTrackPreference(sleepStopAfterTrack); }, [sleepStopAfterTrack]);

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
    if (!shouldAutoDownloadOnPlay(song, isServerDownloaded) || autoDownloadedRef.current.has(key)) return;
    autoDownloadedRef.current.add(key);
    saveToServer(song)
      .then((result) => {
        if (!serverSaveSucceeded(result)) autoDownloadedRef.current.delete(key);
      })
      .catch((error) => {
        autoDownloadedRef.current.delete(key);
        console.warn('原生播放自动下载失败', error);
      });
  }, [isServerDownloaded, offline]);

  const applyNativeState = useCallback((rawState) => {
    const snapshot = nativePlaybackSnapshot(rawState, queueRef.current);
    if (snapshot.song) {
      const changed = songIdentityKey(nowPlayingRef.current || {}) !== songIdentityKey(snapshot.song);
      nowPlayingRef.current = snapshot.song;
      setNowPlaying(snapshot.song);
      if (changed || snapshot.isPlaying) recordStartedSong(snapshot.song);
    }
    setProgress(snapshot.progress);
    setIsPaused(snapshot.isPaused);

    const now = Date.now();
    if (now - lastSavedAtRef.current >= 5000 || snapshot.isPaused) {
      lastSavedAtRef.current = now;
      savePlayback(snapshot.progress.cur);
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
    NativePlayback.seekTo({ positionMs: value * 1000 }).catch((error) => setNotice(`跳转进度失败：${error?.message || error}`));
  }, []);

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
    NativePlayback.setStopAfterCurrent({ enabled: false }).catch(() => {});
  }, []);
  const startSleepTimer = useCallback((minutes) => {
    const timer = createSleepTimer(minutes);
    if (!timer) return;
    sleepTimerRef.current = timer;
    setSleepTimer(timer);
    setSleepRemainingMs(getSleepTimerRemainingMs(timer));
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
          NativePlayback.setStopAfterCurrent({ enabled: true })
            .catch((error) => setNotice(`设置播完停止失败：${error?.message || error}`));
          setNotice('睡眠定时已到点，播完当前歌曲后停止。');
        }
        return;
      }
      NativePlayback.pause().catch(() => {});
      clearSleepTimer();
      setNotice('睡眠定时已停止播放。');
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
      usesNativePlayback: true,
    }}>
      {children}
    </PlayerContext.Provider>
  );
}
