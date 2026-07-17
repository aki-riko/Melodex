import React, { createContext, useContext, useRef, useState, useCallback, useEffect } from 'react';
import { SkipBack, SkipForward, Play, Pause, Volume2, Volume1, VolumeX, ListMusic, ChevronDown, Heart } from 'lucide-react';
import SleepTimerControl from '../components/SleepTimerControl';
import { getStreamUrl, getPlaybackSegmentUrl, coverProxyUrl, getLyric, getFavoriteStatus, toggleFavorite, saveToServer, serverSaveSucceeded, recordPlayHistory, reportPlaybackDiagnostic, switchSource as switchSongSource, getMe } from '../services/musicdl';
import { deleteCachedSong, getPlayableCachedSong, touchCachedSong } from '../services/offlineAudio';
import { useAuth } from './AuthContext';
import { sourceLabel } from '../utils/sourceLabels';
import { songIdentityKey } from '../utils/songIdentity';
import { normalizeSong } from '../utils/songFields';
import { ensurePlaybackSession } from './playerAuth.js';
import { MODES, isCurrentAudioEvent, pickNextSong } from './playerQueue.js';
import { useServerDownloads } from './ServerDownloadsContext';
import {
  createSleepTimer,
  getSleepTimerRemainingMs,
  loadStopAfterTrackPreference,
  saveStopAfterTrackPreference,
  shouldStopAtTrackEnd,
} from './playerSleepTimer.js';
import { shouldAutoDownloadOnPlay } from './playerAutoDownload.js';
import { fadeAudioVolume, shouldResumePlayback } from './playerVolumeFade.js';
import {
  beginPlaybackTransition,
  buildPlaybackDiagnostic,
  replaceAudioSource,
  resolveCurrentPlaybackSong,
} from './playerPlayback.js';
import {
  createPreparedAudio,
  preparedAudioForTransition,
} from './playerPrefetch.js';
import {
  resumeUnexpectedBackgroundPause,
  shouldDeferPausedStateToEndedHandler,
  shouldRecoverUnexpectedBackgroundPause,
} from './playerPauseRecovery.js';
import {
  ContinuousMediaSourcePlayback,
  supportsContinuousMediaSource,
} from './playerMediaSource.js';

const PlayerContext = createContext(null);

const songSourceText = (song) => (song?.source ? sourceLabel(song.source) : '');
const lyricCache = new Map();

const switchAttemptKey = (song) => {
  const s = normalizeSong(song);
  const title = (s.name || '').trim().toLowerCase();
  const artist = (s.artist || '').trim().toLowerCase();
  const duration = s.duration || 0;
  return title ? `${title}|${artist}|${duration}` : songIdentityKey(s);
};

// 播放模式:shuffle 随机 / order 顺序(放完停) / repeat 单曲循环 / loop 列表循环(放完从头)

// 音量持久化(纯前端展示偏好,localStorage 即可,无需后端)。
const VOLUME_KEY = 'melodex_volume';
const loadVolume = () => {
  const v = parseFloat(localStorage.getItem(VOLUME_KEY));
  return isFinite(v) && v >= 0 && v <= 1 ? v : 1;
};

// 播放模式持久化(默认列表循环 loop)。
const MODE_KEY = 'melodex_play_mode';
const loadMode = () => {
  const m = localStorage.getItem(MODE_KEY);
  return ['order', 'loop', 'repeat', 'shuffle'].includes(m) ? m : 'loop';
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
  const [mode, setMode] = useState(loadMode);
  const [volume, setVolumeState] = useState(loadVolume);
  const [muted, setMuted] = useState(false);
  const [queue, setQueue] = useState([]); // 当前播放队列(state 副本,供队列面板渲染)
  const [cachedCover, setCachedCover] = useState({ url: '', mime: '' });
  const [sleepTimer, setSleepTimer] = useState(null);
  const [sleepRemainingMs, setSleepRemainingMs] = useState(0);
  const [sleepStopAfterTrack, setSleepStopAfterTrackState] = useState(loadStopAfterTrackPreference);
  const audioRef = useRef(null);
  const playbackPageIDRef = useRef('');
  const playbackBundleRef = useRef('');
  const queueRef = useRef([]); // 当前播放队列(ref,供 next/prev 等回调读取免闭包陈旧)
  const triedRef = useRef(new Set()); // 本次已试过的死链,避免循环
  const switchTriedRef = useRef(new Set()); // 同一首歌只自动换源一次,避免坏源之间来回重试
  const modeRef = useRef(loadMode());
  const nowPlayingRef = useRef(null);
  const sleepTimerRef = useRef(null);
  const sleepStopAfterTrackRef = useRef(loadStopAfterTrackPreference());
  const volumeRef = useRef(volume);
  const mutedRef = useRef(muted);
  const playbackFadeCancelRef = useRef(null);
  const playbackIntentRef = useRef('');
  const pauseReasonRef = useRef('');
  useEffect(() => { modeRef.current = mode; localStorage.setItem(MODE_KEY, mode); }, [mode]);

  const { user, offline } = useAuth();
  const { isDownloaded: isServerDownloaded } = useServerDownloads();
  const userId = user?.id || 0;
  const resumeRef = useRef(null);   // 待恢复的进度秒数(audio 加载完成后 seek 到这里)
  const restoredRef = useRef(false); // 防重复恢复
  const coverObjectUrlRef = useRef('');
  const playSeqRef = useRef(0);
  const recordedPlaySeqRef = useRef('');
  const prefetchedPlaySeqRef = useRef('');
  const preparedNextRef = useRef(null);
  const prefetchControllerRef = useRef(null);
  const prefetchSeqRef = useRef(0);
  const recoveredUnexpectedPauseSeqRef = useRef('');
  const continuousPlaybackRef = useRef(null);
  const continuousTrackChangeRef = useRef(() => {});
  const continuousBeforeTrackChangeRef = useRef(() => true);
  const continuousPlaybackErrorRef = useRef(() => {});
  // 本会话已自动下载过的歌 key,避免同一首反复播放重复拉流(后端下载不幂等、每次覆盖)。
  const autoDownloadedRef = useRef(new Set());

  if (!playbackPageIDRef.current) {
    playbackPageIDRef.current = globalThis.crypto?.randomUUID?.()
      || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }
  if (!playbackBundleRef.current && globalThis.document) {
    playbackBundleRef.current = [...document.scripts]
      .map((script) => script.src || '')
      .find((src) => /\/assets\/index-[^/]+\.js(?:\?|$)/.test(src))
      ?.split('/').pop() || '';
  }

  const buildPlayerDiagnostic = useCallback((options) => buildPlaybackDiagnostic({
    ...options,
    pageID: playbackPageIDRef.current,
    bundle: playbackBundleRef.current,
    activeAudio: audioRef.current,
    standbyAudio: null,
    mediaSessionState: globalThis.navigator?.mediaSession?.playbackState || '',
    wasDiscarded: Boolean(globalThis.document?.wasDiscarded),
  }), []);

  useEffect(() => { nowPlayingRef.current = nowPlaying; }, [nowPlaying]);
  useEffect(() => { sleepTimerRef.current = sleepTimer; }, [sleepTimer]);
  useEffect(() => {
    sleepStopAfterTrackRef.current = sleepStopAfterTrack;
    saveStopAfterTrackPreference(sleepStopAfterTrack);
  }, [sleepStopAfterTrack]);

  const revokeAudioObjectUrl = useCallback((audio) => {
    const objectUrl = audio?.dataset?.objectUrl || '';
    if (!objectUrl) return;
    URL.revokeObjectURL(objectUrl);
    delete audio.dataset.objectUrl;
  }, []);

  const destroyContinuousPlayback = useCallback(() => {
    continuousPlaybackRef.current?.destroy();
    continuousPlaybackRef.current = null;
  }, []);

  const resetAudioElement = useCallback((audio) => {
    if (!audio) return;
    destroyContinuousPlayback();
    revokeAudioObjectUrl(audio);
    try { audio.pause(); } catch { /* 已卸载或未初始化 */ }
    delete audio.dataset.playSeq;
    delete audio.dataset.songKey;
    delete audio.dataset.sourceKind;
    audio.removeAttribute('src');
    audio.load();
  }, [destroyContinuousPlayback, revokeAudioObjectUrl]);

  const revokeCoverObjectUrl = useCallback(() => {
    if (!coverObjectUrlRef.current) return;
    URL.revokeObjectURL(coverObjectUrlRef.current);
    coverObjectUrlRef.current = '';
  }, []);

  const cancelPlaybackFade = useCallback(() => {
    playbackFadeCancelRef.current?.();
    playbackFadeCancelRef.current = null;
    playbackIntentRef.current = '';
  }, []);

  const startVolumeFade = useCallback((audio, targetVolume, intent, onComplete) => {
    playbackFadeCancelRef.current?.();
    playbackIntentRef.current = intent;
    let completed = false;
    const cancel = fadeAudioVolume(audio, targetVolume, {
      onComplete: () => {
        if (playbackIntentRef.current !== intent) return;
        completed = true;
        playbackFadeCancelRef.current = null;
        playbackIntentRef.current = '';
        onComplete?.();
      },
    });
    if (!completed) playbackFadeCancelRef.current = cancel;
  }, []);

  const loadAudioForSong = useCallback(async (song, {
    autoplay = true,
    seq: requestedSeq,
    preferCache = true,
    preparedAudio = null,
    forceNative = false,
  } = {}) => {
    const seq = requestedSeq ?? ++playSeqRef.current;
    if (seq !== playSeqRef.current) return;
    const songKey = songIdentityKey(song);
    let src = '';
    let sourceKind = '';
    let objectUrl = '';
    let coverUrl = '';
    let coverMime = '';

    try {
      if (preparedAudio?.blob) {
        objectUrl = URL.createObjectURL(preparedAudio.blob);
        src = objectUrl;
        sourceKind = 'cache_preload';
        if (preparedAudio.coverBlob) {
          coverUrl = URL.createObjectURL(preparedAudio.coverBlob);
          coverMime = preparedAudio.coverMime || preparedAudio.coverBlob.type || 'image/jpeg';
        }
      }
      const cached = !src && preferCache ? await getPlayableCachedSong(song, userId) : null;
      if (cached?.blob) {
        objectUrl = URL.createObjectURL(cached.blob);
        src = objectUrl;
        sourceKind = 'cache';
        if (cached.coverBlob) {
          coverUrl = URL.createObjectURL(cached.coverBlob);
          coverMime = cached.coverMime || cached.coverBlob.type || 'image/jpeg';
        }
        touchCachedSong(song, userId).catch(() => {});
      }
    } catch {
      // IndexedDB 不可用或读取失败时,在线模式退回流播放;离线模式保持本机缓存边界。
    }

    const audio = audioRef.current;
    if (!audio) {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      if (coverUrl) URL.revokeObjectURL(coverUrl);
      return;
    }
    if (seq !== playSeqRef.current) {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      if (coverUrl) URL.revokeObjectURL(coverUrl);
      return;
    }
    cancelPlaybackFade();
    audio.volume = volumeRef.current;
    audio.muted = muted;

    if (!src && !offline && !forceNative && supportsContinuousMediaSource()) {
      destroyContinuousPlayback();
      revokeAudioObjectUrl(audio);
      revokeCoverObjectUrl();
      setCachedCover({ url: '', mime: '' });
      pauseReasonRef.current = 'source_change';
      audio.dataset.playSeq = String(seq);
      audio.dataset.songKey = songKey;
      audio.dataset.sourceKind = 'media_source';

      const playback = new ContinuousMediaSourcePlayback({
        audio,
        getSegmentUrl: getPlaybackSegmentUrl,
        getNextSong: (currentSong) => pickNextSong({
          list: queueRef.current,
          current: currentSong,
          mode: modeRef.current,
          forward: true,
          auto: true,
        }),
        onBeforeSegmentChange: (segment) => continuousBeforeTrackChangeRef.current(segment),
        onSegmentChange: (segment) => continuousTrackChangeRef.current(segment),
        onDiagnostic: ({ event, song: eventSong, reason = '', start = 0, end = 0, bytes = 0 }) => {
          reportPlaybackDiagnostic(buildPlayerDiagnostic({
            event,
            audio,
            song: eventSong || song,
            reason: reason || `start=${start.toFixed?.(3) || start};end=${end.toFixed?.(3) || end};bytes=${bytes}`,
            mode: modeRef.current,
            queueLength: queueRef.current.length,
          }));
        },
        onError: (error, failedSong) => continuousPlaybackErrorRef.current(error, failedSong),
      });
      continuousPlaybackRef.current = playback;
      try {
        await playback.start(song, { autoplay });
        if (seq === playSeqRef.current) {
          reportPlaybackDiagnostic(buildPlayerDiagnostic({
            event: 'mse_play_resolved',
            audio,
            song,
            mode: modeRef.current,
            queueLength: queueRef.current.length,
          }));
        }
        return;
      } catch (err) {
        if (continuousPlaybackRef.current === playback) {
          destroyContinuousPlayback();
        }
        if (seq !== playSeqRef.current) return;
        reportPlaybackDiagnostic(buildPlayerDiagnostic({
          event: 'mse_start_failed',
          audio,
          song,
          reason: `${err?.name || 'Error'}:${err?.message || ''}`,
          mode: modeRef.current,
          queueLength: queueRef.current.length,
        }));
        console.warn('连续媒体管线启动失败，回退原生流播放', err);
      }
    }

    if (!src && !offline) {
      src = getStreamUrl(song);
      sourceKind = 'network';
    }

    revokeCoverObjectUrl();
    setCachedCover({ url: '', mime: '' });
    if (!src) {
      resetAudioElement(audio);
      setIsPaused(true);
      setNotice(`「${song.name}」还没有缓存到本机,离线模式无法播放。`);
      return;
    }
    pauseReasonRef.current = 'source_change';
    destroyContinuousPlayback();
    replaceAudioSource(audio, {
      src,
      playSeq: seq,
      songKey,
      sourceKind,
      objectUrl,
    });
    coverObjectUrlRef.current = coverUrl;
    setCachedCover({ url: coverUrl, mime: coverMime });
    if (autoplay) {
      try {
        await audio.play();
        if (seq === playSeqRef.current) {
          reportPlaybackDiagnostic(buildPlayerDiagnostic({
            event: 'play_resolved',
            audio,
            song,
            mode: modeRef.current,
            queueLength: queueRef.current.length,
          }));
        }
      } catch (err) {
        if (seq === playSeqRef.current) {
          setIsPaused(true);
          setNotice(`「${song.name}」未能自动续播,请在锁屏播放器点一次播放。`);
        }
        reportPlaybackDiagnostic(buildPlayerDiagnostic({
          event: 'autoplay_rejected',
          audio,
          song,
          reason: `${err?.name || 'Error'}:${err?.message || ''}`,
          mode: modeRef.current,
          queueLength: queueRef.current.length,
        }));
        console.warn('自动续播失败', err);
      }
    }
  }, [buildPlayerDiagnostic, cancelPlaybackFade, destroyContinuousPlayback, muted, offline, resetAudioElement, revokeAudioObjectUrl, revokeCoverObjectUrl, userId]);

  continuousPlaybackErrorRef.current = (error, failedSong) => {
    const current = nowPlayingRef.current;
    if (!current || songIdentityKey(current) !== songIdentityKey(failedSong)) return;
    setNotice(`「${failedSong.name}」连续播放管线异常，已回退普通流播放。`);
    const retrySeq = ++playSeqRef.current;
    loadAudioForSong(failedSong, {
      autoplay: true,
      seq: retrySeq,
      preferCache: false,
      forceNative: true,
    }).catch((fallbackError) => {
      console.warn('普通流播放回退失败', fallbackError || error);
    });
  };

  useEffect(() => {
    if (!userId) return;
    const navigationType = globalThis.performance?.getEntriesByType?.('navigation')?.[0]?.type || '';
    reportPlaybackDiagnostic(buildPlayerDiagnostic({
      event: 'page_loaded',
      audio: audioRef.current,
      song: nowPlayingRef.current,
      reason: `navigation=${navigationType}`,
      mode: modeRef.current,
      queueLength: queueRef.current.length,
    }));
  }, [buildPlayerDiagnostic, userId]);

  useEffect(() => () => {
    playSeqRef.current += 1;
    prefetchSeqRef.current += 1;
    prefetchControllerRef.current?.abort();
    cancelPlaybackFade();
    resetAudioElement(audioRef.current);
    revokeCoverObjectUrl();
  }, [cancelPlaybackFade, resetAudioElement, revokeCoverObjectUrl]);

  // 音量/静音应用到 audio 元素,并持久化音量。
  useEffect(() => {
    volumeRef.current = volume;
    mutedRef.current = muted;
    const audio = audioRef.current;
    if (audio) {
      audio.muted = muted;
      if (playbackIntentRef.current === 'play' && !audio.paused) {
        startVolumeFade(audio, volume, 'play');
      } else if (playbackIntentRef.current !== 'pause') {
        audio.volume = volume;
      }
    }
    localStorage.setItem(VOLUME_KEY, String(volume));
  }, [muted, startVolumeFade, volume]);

  const setVolume = useCallback((v) => {
    const nv = Math.min(1, Math.max(0, v));
    setVolumeState(nv);
    if (nv > 0) setMuted(false); // 拖动音量自动取消静音
  }, []);

  const toggleMute = useCallback(() => setMuted((m) => !m), []);

  const pauseWithFade = useCallback((reason = 'user') => {
    const audio = audioRef.current;
    if (!audio) return;
    if (playbackIntentRef.current === 'play' && audio.paused) {
      cancelPlaybackFade();
      audio.volume = volumeRef.current;
      return;
    }
    if (audio.paused) return;
    pauseReasonRef.current = reason;
    startVolumeFade(audio, 0, 'pause', () => {
      audio.pause();
      audio.volume = volumeRef.current;
    });
  }, [cancelPlaybackFade, startVolumeFade]);

  const resumeWithFade = useCallback(async () => {
    const audio = audioRef.current;
    if (!audio || !nowPlayingRef.current) return;

    playbackFadeCancelRef.current?.();
    playbackFadeCancelRef.current = null;
    playbackIntentRef.current = 'play';
    audio.volume = 0;
    try {
      await audio.play();
    } catch {
      if (playbackIntentRef.current === 'play') {
        playbackIntentRef.current = '';
        audio.volume = volumeRef.current;
      }
      return;
    }
    if (playbackIntentRef.current !== 'play') {
      audio.pause();
      audio.volume = volumeRef.current;
      return;
    }
    startVolumeFade(audio, volumeRef.current, 'play');
  }, [startVolumeFade]);

  const clearSleepTimer = useCallback(() => {
    sleepTimerRef.current = null;
    setSleepTimer(null);
    setSleepRemainingMs(0);
  }, []);

  const stopPlaybackForSleepTimer = useCallback((message = '睡眠定时已停止播放。') => {
    pauseWithFade('sleep_timer');
    clearSleepTimer();
    setNotice(message);
  }, [clearSleepTimer, pauseWithFade]);

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

  const setSleepStopAfterTrack = useCallback((enabled) => {
    setSleepStopAfterTrackState(Boolean(enabled));
  }, []);

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
      nowPlayingRef.current = saved.song;
      setNowPlaying(saved.song);
      // 预载音频(paused 状态),onLoadedMetadata 会 seek 到 resumeRef
      setTimeout(() => loadAudioForSong(saved.song, { autoplay: false }), 0);
    } catch { /* 损坏数据忽略 */ }
  }, [loadAudioForSong, userId]);

  // 保存当前播放快照(节流:由调用点控制频率)。
  const savePlayback = useCallback((cur) => {
    try {
      const song = nowPlayingRef.current;
      if (!song) return;
      localStorage.setItem(playbackKey(userId), JSON.stringify({
        song,
        queue: queueRef.current,
        cur: cur > 0 ? cur : 0,
      }));
    } catch { /* 配额满等忽略 */ }
  }, [userId]);

  useEffect(() => {
    if (!sleepTimer) return undefined;

    const tick = () => {
      const timer = sleepTimerRef.current;
      if (!timer) return;
      const remaining = getSleepTimerRemainingMs(timer);
      setSleepRemainingMs(remaining);
      if (remaining > 0) return;

      const audio = audioRef.current;
      if (sleepStopAfterTrackRef.current && nowPlayingRef.current && audio && !audio.paused) {
        if (!timer.pendingEndOfTrack) {
          const pendingTimer = { ...timer, pendingEndOfTrack: true };
          sleepTimerRef.current = pendingTimer;
          setSleepTimer(pendingTimer);
          setNotice('睡眠定时已到点,播完当前歌曲后停止。');
        }
        return;
      }

      stopPlaybackForSleepTimer();
    };

    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [sleepTimer, stopPlaybackForSleepTimer]);

  const startPlay = useCallback((song, { preparedAudio = null } = {}) => {
    const seq = ++playSeqRef.current;
    const nextSong = normalizeSong(song);
    prefetchSeqRef.current += 1;
    prefetchControllerRef.current?.abort();
    prefetchControllerRef.current = null;
    preparedNextRef.current = null;
    beginPlaybackTransition({
      song: nextSong,
      seq,
      offline,
      preparedAudio,
      selectSong: (selectedSong) => {
        // 音频事件可能早于 React 下一次渲染；ref 必须同步切到新歌，
        // 否则 playing/error 会被误判成上一首的陈旧事件。
        nowPlayingRef.current = selectedSong;
        setNowPlaying(selectedSong);
      },
      loadAudio: loadAudioForSong,
    }).catch((err) => console.warn('加载歌曲失败', err));
  }, [loadAudioForSong, offline]);

  // play(song, list):list 为当前列表(队列),用于上/下一首与失败自动跳
  const play = useCallback((song, list = []) => {
    const q = (Array.isArray(list) && list.length ? list : [song]).map(normalizeSong);
    const target = normalizeSong(song);
    queueRef.current = q;
    setQueue(q);
    triedRef.current = new Set();
    switchTriedRef.current = new Set();
    setNotice('');
    startPlay(target);
  }, [startPlay]);

  // playFromQueue:从队列面板点击某首,直接播放(不改变队列)
  const playFromQueue = useCallback((song) => {
    triedRef.current = new Set();
    switchTriedRef.current = new Set();
    setNotice('');
    startPlay(song);
  }, [startPlay]);

  // 计算下一首。auto=true 表示自动续播(歌曲自然结束):order 模式到队尾返回 null(停止);
  // auto=false 表示用户手动点上/下一首:任何模式都绕回(不停)。
  // shuffle 随机;loop/repeat/手动 均环绕。
  const pickNext = useCallback((cur, forward = true, auto = false) => {
    return pickNextSong({
      list: queueRef.current,
      current: cur,
      mode: modeRef.current,
      forward,
      auto,
    });
  }, []);

  const prepareFollowingSong = useCallback((cur) => {
    prefetchSeqRef.current += 1;
    const prefetchSeq = prefetchSeqRef.current;
    prefetchControllerRef.current?.abort();
    prefetchControllerRef.current = null;
    preparedNextRef.current = null;

    // 在线播放保持一个常驻 audio；不要用第二个媒体元素预载，避免 Android
    // Chromium 为多个播放器反复申请音频焦点。后台切歌会在 ended 同一调用栈
    // 直接给这个 audio 换流地址。这里只为纯离线模式提前读取 IndexedDB Blob。
    if (!offline) return;

    const nextSong = modeRef.current === 'repeat' ? cur : pickNext(cur, true, true);
    if (!nextSong) return;

    const storePrepared = (prepared, reason) => {
      if (prefetchSeq !== prefetchSeqRef.current) return;
      preparedNextRef.current = prepared;
      reportPlaybackDiagnostic(buildPlayerDiagnostic({
        event: 'prefetch_ready',
        audio: audioRef.current,
        song: cur,
        nextSong: prepared.song,
        reason,
        mode: modeRef.current,
        queueLength: queueRef.current.length,
      }));
    };

    const controller = new AbortController();
    prefetchControllerRef.current = controller;
    getPlayableCachedSong(nextSong, userId).then((cached) => {
      if (!cached?.blob || controller.signal.aborted) return;
      if (prefetchSeq !== prefetchSeqRef.current) return;
      storePrepared(createPreparedAudio({
        currentSong: cur,
        nextSong,
        mode: modeRef.current,
        blob: cached.blob,
        mime: cached.mime || cached.blob.type || '',
        coverBlob: cached.coverBlob || null,
        coverMime: cached.coverMime || '',
      }), `kind=cache_preload;state=source_configured;bytes=${cached.blob.size}`);
    }).catch((err) => {
      if (controller.signal.aborted || err?.name === 'AbortError') return;
      reportPlaybackDiagnostic(buildPlayerDiagnostic({
        event: 'prefetch_failed',
        audio: audioRef.current,
        song: cur,
        nextSong,
        reason: `${err?.name || 'Error'}:${err?.message || ''}`,
        mode: modeRef.current,
        queueLength: queueRef.current.length,
      }));
      console.warn('离线预载下一首失败', err);
    });
  }, [buildPlayerDiagnostic, offline, pickNext, userId]);

  // 手动下一首/上一首
  const next = useCallback(() => {
    const cur = nowPlayingRef.current;
    if (!cur) return;
    triedRef.current = new Set();
    switchTriedRef.current = new Set();
    const n = pickNext(cur, true);
    const preparedAudio = preparedAudioForTransition(preparedNextRef.current, cur, n, modeRef.current);
    if (n) startPlay(n, { preparedAudio });
  }, [pickNext, startPlay]);

  const prev = useCallback(() => {
    const cur = nowPlayingRef.current;
    if (!cur) return;
    triedRef.current = new Set();
    switchTriedRef.current = new Set();
    const p = pickNext(cur, false);
    if (p) startPlay(p);
  }, [pickNext, startPlay]);

  const togglePlay = useCallback(() => {
    const a = audioRef.current;
    if (!a || !nowPlayingRef.current) return;
    if (shouldResumePlayback(a.paused, playbackIntentRef.current)) {
      resumeWithFade();
    } else {
      pauseWithFade();
    }
  }, [pauseWithFade, resumeWithFade]);

  const recordStartedSong = useCallback((song, marker) => {
    if (offline || !song || !marker || recordedPlaySeqRef.current === marker) return;
    recordedPlaySeqRef.current = marker;
    recordPlayHistory(song);
    if (!shouldAutoDownloadOnPlay(song, isServerDownloaded)) return;
    const dlKey = songIdentityKey(song);
    if (!dlKey || autoDownloadedRef.current.has(dlKey)) return;
    autoDownloadedRef.current.add(dlKey);
    saveToServer(song)
      .then((result) => {
        if (!serverSaveSucceeded(result)) autoDownloadedRef.current.delete(dlKey);
      })
      .catch(() => {
        autoDownloadedRef.current.delete(dlKey);
      });
  }, [isServerDownloaded, offline]);

  const activateContinuousTrack = useCallback(({ song, start = 0, end = 0, index = 0 }) => {
    const audio = audioRef.current;
    if (!audio || audio.dataset?.sourceKind !== 'media_source') return;
    const selectedSong = normalizeSong(song);
    nowPlayingRef.current = selectedSong;
    setNowPlaying(selectedSong);
    audio.dataset.songKey = songIdentityKey(selectedSong);
    triedRef.current = new Set();
    switchTriedRef.current = new Set();
    const local = continuousPlaybackRef.current?.currentLocalProgress(audio.currentTime)
      || { cur: 0, dur: selectedSong.duration || Math.max(0, end - start) };
    setProgress(local);
    recordStartedSong(selectedSong, `${audio.dataset.playSeq}:${songIdentityKey(selectedSong)}:${index}`);
    reportPlaybackDiagnostic(buildPlayerDiagnostic({
      event: index === 0 ? 'mse_track_active' : 'mse_track_transition',
      audio,
      song: selectedSong,
      reason: `segment=${index};start=${start};end=${end}`,
      mode: modeRef.current,
      queueLength: queueRef.current.length,
    }));
  }, [buildPlayerDiagnostic, recordStartedSong]);
  continuousTrackChangeRef.current = activateContinuousTrack;

  const beforeContinuousTrackChange = useCallback(() => {
    if (!shouldStopAtTrackEnd(sleepTimerRef.current, sleepStopAfterTrackRef.current)) return true;
    const audio = audioRef.current;
    const local = continuousPlaybackRef.current?.currentLocalProgress(audio?.currentTime || 0);
    pauseReasonRef.current = 'sleep_timer';
    clearSleepTimer();
    setIsPaused(true);
    savePlayback(local?.dur || local?.cur || 0);
    setNotice('睡眠定时已在本曲结束后停止播放。');
    return false;
  }, [clearSleepTimer, savePlayback]);
  continuousBeforeTrackChangeRef.current = beforeContinuousTrackChange;

  const seek = useCallback((sec) => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.dataset?.sourceKind === 'media_source' && continuousPlaybackRef.current?.seekLocal(sec)) return;
    audio.currentTime = sec;
  }, []);

  // 进度更新:刷新进度条 + 节流保存播放快照(每 5 秒)。
  const lastSaveRef = useRef(0);
  const handleTimeUpdate = useCallback((e) => {
    const audio = e.currentTarget;
    const song = resolveCurrentPlaybackSong(nowPlayingRef.current, nowPlaying);
    if (!isCurrentAudioEvent(audio, playSeqRef.current, song)) return;
    let cur = audio.currentTime;
    let dur = audio.duration || 0;
    if (audio.dataset?.sourceKind === 'media_source' && continuousPlaybackRef.current) {
      if (resumeRef.current != null && isFinite(resumeRef.current)
        && continuousPlaybackRef.current.seekLocal(resumeRef.current)) {
        resumeRef.current = null;
      }
      const local = continuousPlaybackRef.current.handleTimeUpdate(audio.currentTime);
      cur = local.cur;
      dur = local.dur;
    }
    setProgress({ cur, dur });
    const now = Date.now();
    if (now - lastSaveRef.current > 5000) {
      lastSaveRef.current = now;
      savePlayback(cur);
    }
  }, [nowPlaying, savePlayback]);

  // 元数据加载完成:更新时长 + 若有待恢复进度则 seek 过去(只定位不播放)。
  const handleLoadedMetadata = useCallback((e) => {
    const audio = e.currentTarget;
    const song = resolveCurrentPlaybackSong(nowPlayingRef.current, nowPlaying);
    if (!isCurrentAudioEvent(audio, playSeqRef.current, song)) return;
    if (audio.dataset?.sourceKind === 'media_source') {
      const local = continuousPlaybackRef.current?.currentLocalProgress(audio.currentTime)
        || { cur: 0, dur: Number(song?.duration || 0) };
      setProgress(local);
      return;
    }
    const dur = audio.duration || 0;
    setProgress({ cur: audio.currentTime, dur });
    if (resumeRef.current != null && isFinite(resumeRef.current)) {
      const t = Math.min(resumeRef.current, dur > 0 ? dur - 1 : resumeRef.current);
      if (t > 0) { try { audio.currentTime = t; } catch { /* ignore */ } }
      resumeRef.current = null;
    }
  }, [nowPlaying]);

  const handlePlaying = useCallback((event) => {
    const cur = resolveCurrentPlaybackSong(nowPlayingRef.current, nowPlaying);
    const audio = event?.currentTarget || audioRef.current;
    if (!isCurrentAudioEvent(audio, playSeqRef.current, cur)) return;
    setIsPaused(false);
    reportPlaybackDiagnostic(buildPlayerDiagnostic({
      event: 'playing',
      audio,
      song: cur,
      mode: modeRef.current,
      queueLength: queueRef.current.length,
    }));
    const seq = audio?.dataset?.playSeq || '';
    pauseReasonRef.current = '';
    if (seq && prefetchedPlaySeqRef.current !== seq) {
      prefetchedPlaySeqRef.current = seq;
      prepareFollowingSong(cur);
    }
    recordStartedSong(cur, `${seq}:${songIdentityKey(cur)}:0`);
  }, [buildPlayerDiagnostic, nowPlaying, prepareFollowingSong, recordStartedSong]);

  const handlePlay = useCallback((event) => {
    const cur = resolveCurrentPlaybackSong(nowPlayingRef.current, nowPlaying);
    const audio = event?.currentTarget || audioRef.current;
    if (!isCurrentAudioEvent(audio, playSeqRef.current, cur)) return;
    setIsPaused(false);
  }, [nowPlaying]);

  const reportPauseRecoveryDiagnostic = useCallback((event, audio, song, reason) => {
    reportPlaybackDiagnostic(buildPlayerDiagnostic({
      event,
      audio,
      song,
      reason,
      mode: modeRef.current,
      queueLength: queueRef.current.length,
    }));
  }, [buildPlayerDiagnostic]);

  const recoverBackgroundPause = useCallback((audio, song, playSeq) => {
    recoveredUnexpectedPauseSeqRef.current = playSeq;
    reportPauseRecoveryDiagnostic('background_pause_recovery', audio, song, 'attempt');
    resumeUnexpectedBackgroundPause(audio).then((resumed) => {
      if (audio?.dataset?.playSeq !== playSeq) return;
      setIsPaused(!resumed);
      reportPauseRecoveryDiagnostic(
        resumed ? 'background_pause_recovered' : 'background_pause_rejected',
        audio,
        song,
        resumed ? 'play_resolved' : 'still_paused',
      );
    }).catch((err) => {
      if (audio?.dataset?.playSeq !== playSeq) return;
      setIsPaused(true);
      setNotice('后台播放被系统暂停，自动恢复失败，请在锁屏播放器点一次播放。');
      reportPauseRecoveryDiagnostic(
        'background_pause_rejected',
        audio,
        song,
        `${err?.name || 'Error'}:${err?.message || ''}`,
      );
    });
  }, [reportPauseRecoveryDiagnostic]);

  const handlePause = useCallback((event) => {
    const audio = event?.currentTarget || audioRef.current;
    const cur = resolveCurrentPlaybackSong(nowPlayingRef.current, nowPlaying);
    if (!isCurrentAudioEvent(audio, playSeqRef.current, cur)) return;
    const reason = pauseReasonRef.current || (audio?.ended ? 'ended' : 'unexpected');
    const playSeq = audio?.dataset?.playSeq || '';
    pauseReasonRef.current = '';
    const savedTime = audio?.dataset?.sourceKind === 'media_source'
      ? continuousPlaybackRef.current?.currentLocalProgress(audio?.currentTime || 0)?.cur || 0
      : audio?.currentTime || 0;
    savePlayback(savedTime);
    reportPauseRecoveryDiagnostic('pause', audio, cur, reason);
    if (shouldDeferPausedStateToEndedHandler(reason)) return;
    const shouldRecover = shouldRecoverUnexpectedBackgroundPause({
      reason,
      sourceKind: audio?.dataset?.sourceKind || '',
      ended: Boolean(audio?.ended),
      playSeq,
      recoveredPlaySeq: recoveredUnexpectedPauseSeqRef.current,
    });
    if (!shouldRecover) {
      setIsPaused(true);
      return;
    }
    recoverBackgroundPause(audio, cur, playSeq);
  }, [nowPlaying, recoverBackgroundPause, reportPauseRecoveryDiagnostic, savePlayback]);

  const handleBufferEvent = useCallback((event) => {
    const audio = event?.currentTarget || audioRef.current;
    const cur = resolveCurrentPlaybackSong(nowPlayingRef.current, nowPlaying);
    if (!isCurrentAudioEvent(audio, playSeqRef.current, cur)) return;
    reportPlaybackDiagnostic(buildPlayerDiagnostic({
      event: event.type,
      audio,
      song: cur,
      mode: modeRef.current,
      queueLength: queueRef.current.length,
    }));
  }, [buildPlayerDiagnostic, nowPlaying]);

  // 播放结束:repeat 重播当前,否则跳下一首
  const handleEnded = useCallback((event) => {
    const cur = resolveCurrentPlaybackSong(nowPlayingRef.current, nowPlaying);
    const audio = event?.currentTarget || audioRef.current;
    if (!isCurrentAudioEvent(audio, playSeqRef.current, cur)) {
      reportPlaybackDiagnostic(buildPlayerDiagnostic({
        event: 'ended_ignored',
        audio,
        song: cur,
        reason: `expected_seq=${playSeqRef.current}`,
        mode: modeRef.current,
        queueLength: queueRef.current.length,
      }));
      return;
    }
    if (shouldStopAtTrackEnd(sleepTimerRef.current, sleepStopAfterTrackRef.current)) {
      clearSleepTimer();
      setIsPaused(true);
      savePlayback(audio?.currentTime || audio?.duration || 0);
      setNotice('睡眠定时已在本曲结束后停止播放。');
      return;
    }
    if (audio?.dataset?.sourceKind === 'media_source') {
      const local = continuousPlaybackRef.current?.currentLocalProgress(audio?.currentTime || 0);
      reportPlaybackDiagnostic(buildPlayerDiagnostic({
        event: 'mse_queue_exhausted',
        audio,
        song: cur,
        mode: modeRef.current,
        queueLength: queueRef.current.length,
      }));
      setIsPaused(true);
      savePlayback(local?.dur || local?.cur || 0);
      return;
    }
    triedRef.current = new Set();
    switchTriedRef.current = new Set();
    const planned = preparedNextRef.current;
    const plannedForMode = planned?.mode === modeRef.current ? planned : null;
    const n = modeRef.current === 'repeat'
      ? cur
      : plannedForMode?.currentKey === songIdentityKey(cur) && plannedForMode.song
        ? plannedForMode.song
        : pickNext(cur, true, true); // auto 续播:order 到尾则停
    const preparedAudio = preparedAudioForTransition(plannedForMode, cur, n, modeRef.current);
    reportPlaybackDiagnostic(buildPlayerDiagnostic({
      event: n ? 'ended_transition' : 'queue_exhausted',
      audio,
      song: cur,
      nextSong: n,
      mode: modeRef.current,
      queueLength: queueRef.current.length,
    }));
    if (preparedAudio) {
      reportPlaybackDiagnostic(buildPlayerDiagnostic({
        event: 'prefetch_consumed',
        audio,
        song: cur,
        nextSong: n,
        reason: `kind=cache_preload;bytes=${preparedAudio.blob?.size || 0}`,
        mode: modeRef.current,
        queueLength: queueRef.current.length,
      }));
    }
    if (n) startPlay(n, { preparedAudio });
    else setIsPaused(true);
  }, [buildPlayerDiagnostic, clearSleepTimer, nowPlaying, pickNext, savePlayback, startPlay]);

  // audio 报错(死链/无法播放)→ 先自动换源,失败后再跳下一首没试过的
  const handleError = useCallback(async (event) => {
    const cur = resolveCurrentPlaybackSong(nowPlayingRef.current, nowPlaying);
    if (!cur) return;
    const audio = event?.currentTarget || audioRef.current;
    const seqAtError = playSeqRef.current;
    if (!isCurrentAudioEvent(audio, seqAtError, cur)) return;
    const curKey = songIdentityKey(cur);

    if (audio?.dataset?.sourceKind === 'media_source') {
      continuousPlaybackErrorRef.current(audio?.error || new Error('MediaSource decode error'), cur);
      return;
    }

    if (!offline && ['cache', 'cache_preload'].includes(audio?.dataset?.sourceKind)) {
      setNotice(`「${cur.name}」本机音频无法播放,正在重新拉取当前源…`);
      if (['cache', 'cache_preload'].includes(audio?.dataset?.sourceKind)) {
        try {
          await deleteCachedSong(cur, userId);
        } catch (err) {
          console.warn('删除损坏本机缓存失败', err);
        }
      }
      if (seqAtError !== playSeqRef.current || songIdentityKey(nowPlayingRef.current || {}) !== curKey) return;
      const retrySeq = ++playSeqRef.current;
      loadAudioForSong(cur, { autoplay: true, seq: retrySeq, preferCache: false })
        .catch((err) => console.warn('重新拉取当前源失败', err));
      return;
    }

    if (!offline && audio?.dataset?.sourceKind === 'network') {
      const authenticated = await ensurePlaybackSession(getMe);
      if (!authenticated) {
        if (seqAtError !== playSeqRef.current || songIdentityKey(nowPlayingRef.current || {}) !== curKey) return;
        try {
          cancelPlaybackFade();
          pauseReasonRef.current = 'auth_expired';
          audio.pause();
          audio.removeAttribute('src');
          audio.load();
        } catch { /* ignore */ }
        setIsPaused(true);
        setNotice('登录状态已失效,请重新登录后再播放。');
        return;
      }
    }

    const switchKey = switchAttemptKey(cur);
    const canSwitchSource = !offline && cur.source && cur.source !== 'local' && cur.name && !switchTriedRef.current.has(switchKey);
    if (canSwitchSource) {
      switchTriedRef.current.add(switchKey);
      setNotice(`「${cur.name}」当前源无法播放,正在自动换源…`);
      try {
        const replacement = await switchSongSource(cur);
        const replacementKey = songIdentityKey(replacement);
        const stillCurrent = seqAtError === playSeqRef.current
          && songIdentityKey(nowPlayingRef.current || {}) === curKey;
        if (!stillCurrent) return;
        if (stillCurrent && replacement.id && replacement.source && replacementKey !== curKey) {
          let replacedInQueue = false;
          const nextQueue = queueRef.current.map((s) => {
            if (songIdentityKey(s) !== curKey) return s;
            replacedInQueue = true;
            return replacement;
          });
          queueRef.current = replacedInQueue ? nextQueue : [replacement, ...nextQueue];
          setQueue(queueRef.current);
          setNotice(`「${cur.name}」已换到 ${songSourceText(replacement) || '可用源'}。`);
          startPlay(replacement);
          return;
        }
      } catch (err) {
        console.warn('自动换源失败', err);
      }
    }

    if (seqAtError !== playSeqRef.current || songIdentityKey(nowPlayingRef.current || {}) !== curKey) return;
    triedRef.current.add(curKey);
    const list = queueRef.current;
    const idx = list.findIndex((s) => songIdentityKey(s) === curKey);
    const nxt = list.slice(idx + 1).find((s) => !triedRef.current.has(songIdentityKey(s)));
    if (nxt) {
      setNotice(`「${cur.name}」该源无法播放,已自动切换…`);
      startPlay(nxt);
    } else {
      setNotice(`「${cur.name}」暂时无法播放(可换源或稍后再试)。`);
    }
  }, [buildPlayerDiagnostic, cancelPlaybackFade, loadAudioForSong, nowPlaying, offline, startPlay, userId]);

  // MediaSession:PC 全局媒体键 / 锁屏 / 通知栏 / 蓝牙耳机控制 + 元数据
  useEffect(() => {
    if (!('mediaSession' in navigator)) return;
    if (nowPlaying) {
      const artworkSrc = cachedCover.url || (!offline && nowPlaying.cover ? coverProxyUrl(nowPlaying) : '');
      navigator.mediaSession.metadata = new window.MediaMetadata({
        title: nowPlaying.name || '',
        artist: nowPlaying.artist || '',
        album: nowPlaying.album || '',
        // 离线模式不请求 cover_proxy;在线时走代理解决混合内容和防盗链。
        artwork: artworkSrc
          ? [96, 192, 300, 512].map((s) => ({ src: artworkSrc, sizes: `${s}x${s}`, type: cachedCover.mime || 'image/jpeg' }))
          : [],
      });
    }
    const safe = (action, fn) => () => {
      try {
        const pending = fn();
        if (pending && typeof pending.catch === 'function') {
          pending.catch((err) => console.warn(`MediaSession ${action} 执行失败`, err));
        }
      } catch (err) {
        console.warn(`MediaSession ${action} 执行失败`, err);
      }
    };
    // 渐变使用后台安全的定时器调度,前后台媒体键都保留淡入淡出。
    navigator.mediaSession.setActionHandler('play', safe('play', resumeWithFade));
    navigator.mediaSession.setActionHandler('pause', safe('pause', () => pauseWithFade('media_session')));
    navigator.mediaSession.setActionHandler('previoustrack', safe('previoustrack', prev));
    navigator.mediaSession.setActionHandler('nexttrack', safe('nexttrack', next));
    navigator.mediaSession.setActionHandler('stop', safe('stop', () => pauseWithFade('media_session_stop')));
    try {
      navigator.mediaSession.setActionHandler('seekto', (d) => { if (d.seekTime != null) seek(d.seekTime); });
      navigator.mediaSession.setActionHandler('seekforward', (d) => seek(progress.cur + (d.seekOffset || 10)));
      navigator.mediaSession.setActionHandler('seekbackward', (d) => seek(Math.max(0, progress.cur - (d.seekOffset || 10))));
    } catch (err) {
      console.debug('当前浏览器不支持部分 MediaSession seek 动作', err);
    }
  }, [cachedCover, next, nowPlaying, offline, pauseWithFade, prev, progress.cur, resumeWithFade, seek]);

  // 同步播放状态给 OS(playbackState 决定全局媒体键能否正确恢复/暂停)
  useEffect(() => {
    if (!('mediaSession' in navigator)) return;
    navigator.mediaSession.playbackState = nowPlaying ? (isPaused ? 'paused' : 'playing') : 'none';
  }, [isPaused, nowPlaying]);

  // 上报播放进度(OS 媒体面板显示进度条 + 改善媒体键路由)
  useEffect(() => {
    if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;
    const dur = progress.dur || 0;
    if (dur > 0 && progress.cur <= dur) {
      try {
        navigator.mediaSession.setPositionState({ duration: dur, playbackRate: 1, position: progress.cur || 0 });
      } catch { /* ignore */ }
    }
  }, [progress.cur, progress.dur]);


  return (
    <PlayerContext.Provider value={{
      nowPlaying, play, audioRef, notice, isPaused, progress, mode, setMode,
      volume, setVolume, muted, toggleMute,
      cachedCoverUrl: cachedCover.url,
      queue, playFromQueue,
      sleepTimer, sleepRemainingMs, sleepStopAfterTrack,
      startSleepTimer, cancelSleepTimer, setSleepStopAfterTrack,
      isPlaying: (s) => nowPlaying && songIdentityKey(nowPlaying) === songIdentityKey(s),
      next, prev, togglePlay, seek, handleError, handleEnded, handlePlay, handlePlaying, handlePause, handleBufferEvent, setIsPaused, setProgress,
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

// 播放模式图标:统一圆角描边风格(参考 QQ 音乐)。
// 顺序=右箭头直线 / 列表循环=回环箭头 / 单曲循环=回环+1 / 随机=交叉箭头。
const PlayModeIcon = ({ mode, size = 20 }) => {
  const common = { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' };
  if (mode === 'shuffle') {
    return (
      <svg {...common}>
        <path d="M16 3h5v5" /><path d="M4 20 21 3" />
        <path d="M21 16v5h-5" /><path d="m15 15 6 6" /><path d="M4 4l5 5" />
      </svg>
    );
  }
  if (mode === 'loop') {
    return (
      <svg {...common}>
        <path d="m17 2 4 4-4 4" /><path d="M3 11v-1a4 4 0 0 1 4-4h14" />
        <path d="m7 22-4-4 4-4" /><path d="M21 13v1a4 4 0 0 1-4 4H3" />
      </svg>
    );
  }
  if (mode === 'repeat') {
    return (
      <svg {...common}>
        <path d="m17 2 4 4-4 4" /><path d="M3 11v-1a4 4 0 0 1 4-4h14" />
        <path d="m7 22-4-4 4-4" /><path d="M21 13v1a4 4 0 0 1-4 4H3" />
        <path d="M11 10h1v4" />
      </svg>
    );
  }
  // order 顺序:向右的直线箭头(放完停)
  return (
    <svg {...common}>
      <path d="M4 7h11" /><path d="M4 12h11" /><path d="M4 17h7" />
      <path d="m16 14 4 3-4 3" /><path d="M20 17h-5" />
    </svg>
  );
};

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
    next, prev, togglePlay, seek, handleError, handleEnded, handlePlay, handlePlaying, handlePause, handleBufferEvent,
    setIsPaused, setProgress, cycleMode,
    volume, setVolume, muted, toggleMute,
    queue, playFromQueue,
    sleepTimer, sleepRemainingMs, sleepStopAfterTrack,
    startSleepTimer, cancelSleepTimer, setSleepStopAfterTrack,
    cachedCoverUrl,
    handleTimeUpdate, handleLoadedMetadata, savePlayback,
  } = usePlayer();

  const [queueOpen, setQueueOpen] = useState(false);
  const [expanded, setExpanded] = useState(false); // 移动端:点击迷你条展开全屏播放页
  const [showLyric, setShowLyric] = useState(false); // 展开页:封面(黑胶)↔ 歌词切换
  const [closing, setClosing] = useState(false); // 展开页收起动画中
  const [lrc, setLrc] = useState([]); // 解析后的同步歌词
  const curKey = nowPlaying ? `${nowPlaying.source}-${nowPlaying.id}` : '';
  const { offline } = useAuth();
  const coverUrl = cachedCoverUrl || (!offline && nowPlaying?.cover ? coverProxyUrl(nowPlaying) : '');

  // 收藏状态:当前歌切换时查询;点心形切换并乐观更新。
  const [favorited, setFavorited] = useState(false);
  useEffect(() => {
    let cancelled = false;
    if (!nowPlaying || offline) { setFavorited(false); return; }
    getFavoriteStatus(nowPlaying).then((f) => { if (!cancelled) setFavorited(f); });
    return () => { cancelled = true; };
  }, [curKey, nowPlaying, offline]);

  const onToggleFavorite = async () => {
    if (!nowPlaying || offline) return;
    const prev = favorited;
    setFavorited(!prev); // 乐观更新
    try {
      const f = await toggleFavorite(nowPlaying);
      setFavorited(f);
      // 收藏(加入「我喜欢」)时后台静默下载到 NAS,与"加歌单即下载"一致;取消收藏不下载。
      if (f) saveToServer(nowPlaying).catch(() => {});
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

  // 当前歌变化时拉取并解析歌词。桌面底栏和展开播放页共用同一份结果。
  useEffect(() => {
    if (!nowPlaying || offline) {
      setLrc([]);
      return;
    }
    let cancelled = false;
    const cached = lyricCache.get(curKey);
    if (cached) {
      setLrc(cached);
      return () => { cancelled = true; };
    }
    setLrc([]);
    getLyric(nowPlaying)
      .then((text) => {
        const parsed = parseLRC(text);
        lyricCache.set(curKey, parsed);
        if (!cancelled) setLrc(parsed);
      })
      .catch(() => { if (!cancelled) setLrc([]); });
    return () => { cancelled = true; };
  }, [curKey, nowPlaying, offline]);

  const lyricIdx = currentLyricIndex(lrc, progress.cur);
  const activeLyricLine = lyricIdx >= 0 ? lrc[lyricIdx] : null;
  const miniLyricText = activeLyricLine?.text || '';
  const artistSourceText = nowPlaying ? `${nowPlaying.artist}${nowPlaying.source ? ` · ${songSourceText(nowPlaying)}` : ''}` : '';

  // 歌词自动滚动:当前行变化时滚到视图中央。
  const activeLyricRef = useRef(null);
  useEffect(() => {
    if (showLyric && activeLyricRef.current) {
      activeLyricRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [lyricIdx, showLyric]);

  // 桌面全屏页歌词常驻显示(不走 showLyric 开关),用独立 ref + effect 自动滚动。
  const desktopLyricRef = useRef(null);
  useEffect(() => {
    if (expanded && desktopLyricRef.current) {
      desktopLyricRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [lyricIdx, expanded]);

  // 播放模式图标(自定义 SVG,圆角风格统一):顺序/列表循环/单曲循环/随机
  const modeIcon = <PlayModeIcon mode={mode} size={20} />;

  // 音量图标:静音/0 → X,低 → Volume1,高 → Volume2
  const effectiveVol = muted ? 0 : volume;
  const volIcon = effectiveVol === 0
    ? <VolumeX size={18} />
    : effectiveVol < 0.5
      ? <Volume1 size={18} />
      : <Volume2 size={18} />;
  const sleepTimerControlProps = {
    active: Boolean(sleepTimer),
    pendingEndOfTrack: Boolean(sleepTimer?.pendingEndOfTrack),
    remainingMs: sleepRemainingMs,
    stopAfterTrack: sleepStopAfterTrack,
    onStopAfterTrackChange: setSleepStopAfterTrack,
    onStart: startSleepTimer,
    onCancel: cancelSleepTimer,
  };

  return (
    <>
      {/* ===== 桌面端:完整播放条(原样) ===== */}
      <div className="hidden md:block fixed bottom-0 left-0 right-0 bg-card border-t border-border px-3 py-2 z-40"
        style={{ display: nowPlaying ? undefined : 'none' }}>
        <div className="max-w-6xl mx-auto">
          {notice && <p className="text-xs text-primary font-medium mb-1">{notice}</p>}
          <div className="flex items-center gap-3">
            {/* 左:封面 + 标题/歌手(点击展开全屏播放页) */}
            <button onClick={openExpanded}
              className="flex items-center gap-3 min-w-0 text-left group" style={{ width: '26%' }}
              title="展开播放页" aria-label="展开播放页">
              {coverUrl
                ? <img src={coverUrl} alt="" className="w-12 h-12 rounded object-cover flex-shrink-0 shadow transition-transform group-hover:scale-105" />
                : <div className="w-12 h-12 rounded bg-secondary flex items-center justify-center flex-shrink-0"><ListMusic size={20} className="text-muted-foreground" /></div>}
              <div className="min-w-0">
                <p className="truncate font-semibold text-sm group-hover:text-primary transition-colors">{nowPlaying?.name}</p>
                <div className="mt-0.5 h-4 overflow-hidden text-xs text-muted-foreground">
                  {miniLyricText ? (
                    <span key={`${curKey}-${lyricIdx}`} className="player-mini-lyric block whitespace-nowrap text-primary/90">
                      {miniLyricText}
                    </span>
                  ) : (
                    <span className="block truncate">{artistSourceText}</span>
                  )}
                </div>
              </div>
            </button>
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
            <SleepTimerControl {...sleepTimerControlProps} align="center" />
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
                                <p className="text-xs text-muted-foreground truncate">{s.artist}{s.source ? ` · ${songSourceText(s)}` : ''}</p>
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
      {nowPlaying && (
      <div className="md:hidden fixed left-0 right-0 bg-card border-t border-border z-40"
        style={{ bottom: 'calc(3.25rem + env(safe-area-inset-bottom))' }}>
        {notice && <p className="text-xs text-primary font-medium px-3 pt-1 truncate">{notice}</p>}
        {/* 顶部细进度条 */}
        <div className="h-0.5 bg-secondary">
          <div className="h-full bg-primary" style={{ width: progress.dur ? `${(progress.cur / progress.dur) * 100}%` : '0%' }} />
        </div>
        <div className="flex items-center gap-2 px-3 py-2">
          <button className="flex items-center gap-3 min-w-0 flex-grow text-left" onClick={openExpanded} aria-label="展开播放页">
            {coverUrl
              ? <img src={coverUrl} alt="" className="w-11 h-11 rounded object-cover flex-shrink-0 shadow" />
              : <div className="w-11 h-11 rounded bg-secondary flex items-center justify-center flex-shrink-0"><ListMusic size={18} className="text-muted-foreground" /></div>}
            <div className="min-w-0">
              <Marquee text={nowPlaying?.name || ''} className="font-semibold text-sm" />
              <p className="text-muted-foreground text-xs truncate">{nowPlaying?.artist}</p>
            </div>
          </button>
          {/* 收藏 */}
          <button onClick={onToggleFavorite} disabled={offline} className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full disabled:opacity-50" aria-label="收藏">
            <Heart size={22} className={favorited ? 'text-primary' : 'text-muted-foreground'} fill={favorited ? 'currentColor' : 'none'} />
          </button>
          {/* 播放/暂停 */}
          <button onClick={togglePlay}
            className="flex h-11 w-11 items-center justify-center rounded-full bg-primary text-primary-foreground flex-shrink-0"
            aria-label="播放/暂停">
            {isPaused ? <Play size={20} fill="currentColor" /> : <Pause size={20} fill="currentColor" />}
          </button>
          {/* 播放列表 */}
          <button onClick={() => { openExpanded(); setQueueOpen(true); }} className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full text-muted-foreground" aria-label="播放列表">
            <ListMusic size={22} />
          </button>
        </div>
      </div>
      )}

      {/* ===== 移动端:全屏展开播放页(QQ音乐式) ===== */}
      {expanded && nowPlaying && (
        <div className={`md:hidden fixed inset-0 z-[70] bg-background flex flex-col ${closing ? 'player-sheet-exit' : 'player-sheet-enter'}`}
          style={{ paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'calc(env(safe-area-inset-bottom) + 1rem)' }}>
          {/* 顶部:收起 */}
          <div className="flex items-center justify-between px-4 py-3">
            <button onClick={collapseExpanded} className="flex h-11 w-11 items-center justify-center rounded-full text-muted-foreground" aria-label="收起">
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
                <button onClick={() => setQueueOpen(false)} className="flex h-11 w-11 items-center justify-center rounded-full text-muted-foreground" aria-label="关闭队列">
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
                      className={`flex min-h-12 w-full items-center gap-3 px-4 py-2.5 text-left transition-colors ${active ? 'bg-secondary' : ''}`}>
                      <span className={`w-5 text-right text-xs tabular-nums flex-shrink-0 ${active ? 'text-primary' : 'text-muted-foreground'}`}>{active ? '▶' : i + 1}</span>
                      <div className="min-w-0">
                        <p className={`text-sm truncate ${active ? 'text-primary font-medium' : ''}`}>{s.name}</p>
                        <p className="text-xs text-muted-foreground truncate">{s.artist}{s.source ? ` · ${songSourceText(s)}` : ''}</p>
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
                  {coverUrl
                    ? <img src={coverUrl} alt=""
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
              <p className="text-muted-foreground truncate mt-1">{nowPlaying?.artist}{nowPlaying?.source ? ` · ${songSourceText(nowPlaying)}` : ''}</p>
            </div>
            <button onClick={onToggleFavorite} disabled={offline} className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full disabled:opacity-50" aria-label="收藏">
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
              className={`flex h-12 w-12 items-center justify-center rounded-full ${mode === 'order' ? 'text-muted-foreground' : 'text-primary'}`}
              title={`播放模式:${MODE_LABEL[mode]}`} aria-label="播放模式">
              {modeIcon}
            </button>
            <button onClick={prev} className="flex h-12 w-12 items-center justify-center rounded-full text-foreground" aria-label="上一首">
              <SkipBack size={32} fill="currentColor" />
            </button>
            <button onClick={togglePlay}
              className="flex items-center justify-center w-16 h-16 rounded-full bg-primary text-primary-foreground"
              aria-label="播放/暂停">
              {isPaused ? <Play size={30} fill="currentColor" /> : <Pause size={30} fill="currentColor" />}
            </button>
            <button onClick={next} className="flex h-12 w-12 items-center justify-center rounded-full text-foreground" aria-label="下一首">
              <SkipForward size={32} fill="currentColor" />
            </button>
            <SleepTimerControl
              {...sleepTimerControlProps}
              align="right"
              variant="mobileMenu"
              extraActions={[{
                key: 'queue',
                icon: ListMusic,
                label: '播放队列',
                hint: `${queue.length} 首`,
                onClick: () => setQueueOpen(true),
              }]}
            />
          </div>
        </div>
      )}

      {/* ===== 桌面端:全屏展开播放页(网易云式:左唱片 / 右歌词) ===== */}
      {expanded && nowPlaying && (
        <div className={`hidden md:flex fixed inset-0 z-[70] flex-col player-cover-bg ${closing ? 'player-sheet-exit' : 'player-sheet-enter'}`}>
          {/* 背景:封面大图模糊铺底 + 暗色遮罩 */}
          {coverUrl && (
            <div className="absolute inset-0 -z-10 bg-cover bg-center"
              style={{ backgroundImage: `url(${coverUrl})`, filter: 'blur(60px) brightness(0.35)', transform: 'scale(1.2)' }} />
          )}
          <div className="absolute inset-0 -z-10 bg-background/70" />

          {/* 顶部:收起 */}
          <div className="flex items-center justify-between px-8 py-5">
            <button onClick={collapseExpanded} className="flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors" aria-label="收起">
              <ChevronDown size={28} />
              <span className="text-sm">收起</span>
            </button>
            <span className="text-xs uppercase tracking-wider text-muted-foreground">正在播放</span>
            <span className="w-16" />
          </div>

          {/* 中部:左唱片 + 右歌词 */}
          <div className="flex-grow flex items-center justify-center gap-12 px-16 min-h-0 overflow-hidden">
            {/* 左:黑胶唱片 + 标题/歌手/收藏 */}
            <div className="flex flex-col items-center flex-shrink-0" style={{ width: 'min(40vw, 28rem)' }}>
              <div className="turntable" style={{ width: 'min(30vw, 22rem)', height: 'min(30vw, 22rem)' }}>
                <div className={`tonearm ${isPaused ? 'up' : 'down'}`}>
                  <div className="tonearm__base" />
                  <div className="tonearm__arm" />
                  <div className="tonearm__head" />
                </div>
                <div className={`vinyl-wrap vinyl-disc ${isPaused ? 'paused' : ''} w-full h-full`}>
                  {coverUrl
                    ? <img src={coverUrl} alt="" onError={(e) => { e.currentTarget.style.display = 'none'; }} />
                    : <ListMusic size={72} className="text-muted-foreground" />}
                </div>
              </div>
              <div className="mt-8 text-center max-w-full px-4">
                <p className="text-2xl font-bold truncate">{nowPlaying?.name}</p>
                <p className="text-muted-foreground truncate mt-2">{nowPlaying?.artist}{nowPlaying?.source ? ` · ${songSourceText(nowPlaying)}` : ''}</p>
              </div>
            </div>

            {/* 右:滚动歌词 */}
            <div className="flex-grow max-w-xl h-full overflow-y-auto app-scroll py-16 min-w-0" aria-label="歌词">
              {lrc.length === 0 ? (
                <p className="text-muted-foreground text-center mt-20">暂无歌词</p>
              ) : (
                lrc.map((line, i) => (
                  <p key={i}
                    ref={i === lyricIdx ? desktopLyricRef : null}
                    className={`py-2 leading-relaxed transition-all ${
                      i === lyricIdx ? 'text-xl font-semibold' : 'text-muted-foreground/70 text-base'
                    }`}>
                    {i === lyricIdx ? <KaraokeLine line={line} cur={progress.cur} /> : line.text}
                  </p>
                ))
              )}
            </div>
          </div>

          {/* 底部:进度 + 控制 + 音量 + 收藏 */}
          <div className="px-16 pb-8">
            <div className="flex items-center gap-3 mb-3 max-w-4xl mx-auto w-full">
              <span className="text-xs text-muted-foreground tabular-nums w-10 text-right">{fmtTime(progress.cur)}</span>
              <input type="range" min={0} max={progress.dur || 0} value={progress.cur || 0} step="0.5"
                onChange={(e) => seek(Number(e.target.value))}
                className="flex-grow accent-primary cursor-pointer" aria-label="播放进度" />
              <span className="text-xs text-muted-foreground tabular-nums w-10">{fmtTime(progress.dur)}</span>
            </div>
            <div className="flex items-center justify-center gap-8">
              <button onClick={onToggleFavorite} disabled={offline} className="p-1 disabled:opacity-50" aria-label="收藏" title={offline ? '离线状态无法同步收藏' : '收藏'}>
                <Heart size={24} className={favorited ? 'text-primary' : 'text-muted-foreground hover:text-foreground transition-colors'} fill={favorited ? 'currentColor' : 'none'} />
              </button>
              <button onClick={cycleMode}
                className={`${mode === 'order' ? 'text-muted-foreground hover:text-foreground' : 'text-primary'} transition-colors`}
                title={`播放模式:${MODE_LABEL[mode]}`} aria-label="播放模式">{modeIcon}</button>
              <SleepTimerControl {...sleepTimerControlProps} align="center" />
              <button onClick={prev} className="text-foreground hover:scale-110 transition-transform" aria-label="上一首">
                <SkipBack size={30} fill="currentColor" />
              </button>
              <button onClick={togglePlay}
                className="flex items-center justify-center w-16 h-16 rounded-full bg-primary text-primary-foreground hover:scale-105 transition-transform"
                aria-label="播放/暂停">
                {isPaused ? <Play size={30} fill="currentColor" /> : <Pause size={30} fill="currentColor" />}
              </button>
              <button onClick={next} className="text-foreground hover:scale-110 transition-transform" aria-label="下一首">
                <SkipForward size={30} fill="currentColor" />
              </button>
              <div className="flex items-center gap-2" style={{ width: 130 }}>
                <button onClick={toggleMute} className="text-muted-foreground hover:text-foreground transition-colors flex-shrink-0" aria-label="静音">{volIcon}</button>
                <input type="range" min={0} max={1} step="0.01" value={effectiveVol}
                  onChange={(e) => setVolume(Number(e.target.value))}
                  className="flex-grow accent-primary cursor-pointer" aria-label="音量" />
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 全局唯一 audio:整个队列始终复用同一媒体元素，保持 Android 音频焦点和 MediaSession 连续。 */}
      <audio
        ref={audioRef}
        data-audio-slot="primary"
        preload="auto"
        playsInline
        onError={handleError}
        onEnded={handleEnded}
        onPlay={handlePlay}
        onPlaying={handlePlaying}
        onPause={handlePause}
        onStalled={handleBufferEvent}
        onWaiting={handleBufferEvent}
        onSuspend={handleBufferEvent}
        onTimeUpdate={handleTimeUpdate}
        onLoadedMetadata={handleLoadedMetadata}
        style={{ display: 'none' }}
      />
    </>
  );
};
