import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Captions } from 'lucide-react';
import { apiBase } from '../services/musicdl';
import {
  DESKTOP_LYRICS_PROTOCOL,
  desktopLyricsProgressMessage,
  desktopLyricsTrackMessage,
  desktopLyricsWebSocketURL,
  dispatchDesktopLyricsCommand,
} from '../contexts/playerDesktopLyrics';

const SOCKET_OPEN = 1;
const PROGRESS_INTERVAL_MS = 250;
const RECONNECT_MAX_MS = 15000;

const sendJSON = (socket, payload) => {
  if (!socket || socket.readyState !== SOCKET_OPEN) return false;
  socket.send(JSON.stringify(payload));
  return true;
};

const DesktopLyricsBridge = ({
  song,
  lines,
  activeIndex,
  currentTime,
  duration,
  isPaused,
  onTogglePlay,
  onPrev,
  onNext,
}) => {
  const [status, setStatus] = useState('connecting');
  const socketRef = useRef(null);
  const reconnectRef = useRef(null);
  const reconnectDelayRef = useRef(1000);
  const stoppedRef = useRef(false);
  const stateRef = useRef({ song: null, lines: [], activeIndex: -1, currentTime: 0, duration: 0, isPaused: true });
  const callbacksRef = useRef({ prev: onPrev, toggle: onTogglePlay, next: onNext });

  stateRef.current = { song, lines, activeIndex, currentTime, duration, isPaused };
  callbacksRef.current = { prev: onPrev, toggle: onTogglePlay, next: onNext };

  const trackKey = useMemo(() => JSON.stringify({
    track: song ? { id: song.id, source: song.source, name: song.name, artist: song.artist } : null,
    lyrics: lines,
  }), [song, lines]);

  const currentTrackMessage = () => desktopLyricsTrackMessage({
    track: stateRef.current.song,
    lines: stateRef.current.lines,
    position: stateRef.current.currentTime,
    duration: stateRef.current.duration,
    paused: stateRef.current.isPaused,
    currentIndex: stateRef.current.activeIndex,
  });

  useEffect(() => {
    stoppedRef.current = false;
    const connect = () => {
      if (stoppedRef.current) return;
      let socket;
      try {
        socket = new WebSocket(desktopLyricsWebSocketURL(apiBase), DESKTOP_LYRICS_PROTOCOL);
      } catch (error) {
        console.warn('创建桌面歌词同步连接失败', error);
        setStatus('error');
        reconnectRef.current = window.setTimeout(connect, reconnectDelayRef.current);
        reconnectDelayRef.current = Math.min(RECONNECT_MAX_MS, reconnectDelayRef.current * 2);
        return;
      }
      socketRef.current = socket;
      setStatus('connecting');
      socket.onopen = () => {
        reconnectDelayRef.current = 1000;
        setStatus('connected');
        sendJSON(socket, currentTrackMessage());
      };
      socket.onmessage = (event) => {
        dispatchDesktopLyricsCommand(event.data, callbacksRef.current);
      };
      socket.onerror = () => setStatus('error');
      socket.onclose = () => {
        if (socketRef.current === socket) socketRef.current = null;
        if (stoppedRef.current) return;
        setStatus('disconnected');
        reconnectRef.current = window.setTimeout(connect, reconnectDelayRef.current);
        reconnectDelayRef.current = Math.min(RECONNECT_MAX_MS, reconnectDelayRef.current * 2);
      };
    };
    connect();
    return () => {
      stoppedRef.current = true;
      if (reconnectRef.current) window.clearTimeout(reconnectRef.current);
      reconnectRef.current = null;
      const socket = socketRef.current;
      socketRef.current = null;
      if (socket) socket.close();
    };
  }, []);

  useEffect(() => {
    sendJSON(socketRef.current, currentTrackMessage());
  }, [trackKey]);

  useEffect(() => {
    let lastMessage = '';
    const timer = window.setInterval(() => {
      const state = stateRef.current;
      const message = JSON.stringify(desktopLyricsProgressMessage({
        position: state.currentTime,
        duration: state.duration,
        paused: state.isPaused,
        currentIndex: state.activeIndex,
      }));
      if (message !== lastMessage && socketRef.current?.readyState === SOCKET_OPEN) {
        socketRef.current.send(message);
        lastMessage = message;
      }
    }, PROGRESS_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, []);

  const connected = status === 'connected';
  return (
    <button
      type="button"
      onClick={() => { window.location.hash = 'settings'; }}
      aria-label="桌面歌词助手"
      className={`transition-colors ${connected ? 'text-primary' : 'text-muted-foreground hover:text-foreground'}`}
      title={connected ? '桌面歌词同步服务已连接；点击管理 Windows/macOS 助手' : '点击配对 Windows/macOS 桌面歌词助手'}
    >
      <Captions size={19} />
    </button>
  );
};

export default DesktopLyricsBridge;
