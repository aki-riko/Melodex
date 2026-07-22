import {
  desktopLyricsDeviceWebSocketURL,
  lyricFrame,
  lyricWordFill,
} from './lyricsCore.js';

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const PROTOCOL = 'melodex.desktop-lyrics.v1';
const TOKEN_PROTOCOL_PREFIX = 'melodex-token.';
const RECONNECT_MAX_MS = 15000;

const previousLine = document.getElementById('previous-line');
const currentLine = document.getElementById('current-line');
const nextLine = document.getElementById('next-line');
const lyricsShell = document.getElementById('lyrics-shell');
const controls = document.getElementById('controls');
const toggleButton = document.getElementById('toggle-button');

let socket = null;
let reconnectTimer = null;
let reconnectDelay = 1000;
let configVersion = 0;
let overlayVisible = false;
let playback = {
  track: null,
  lyrics: [],
  position: 0,
  duration: 0,
  paused: true,
  currentIndex: -1,
  receivedAt: performance.now(),
};

const effectivePosition = () => {
  if (playback.paused) return playback.position;
  const elapsed = Math.max(0, performance.now() - playback.receivedAt) / 1000;
  return Math.min(playback.duration || Number.MAX_SAFE_INTEGER, playback.position + elapsed);
};

const setPlainLine = (element, line) => {
  element.textContent = line?.text || '';
};

const renderCurrentLine = (line, position) => {
  currentLine.replaceChildren();
  if (!line) return;
  if (!Array.isArray(line.words) || line.words.length < 2) {
    currentLine.textContent = line.text || '';
    return;
  }
  for (const word of line.words) {
    const ratio = lyricWordFill(word, position);
    const span = document.createElement('span');
    span.className = 'word';
    span.textContent = word.s || '';
    span.style.setProperty('--fill', `${Math.max(0, Math.min(1, ratio)) * 100}%`);
    currentLine.appendChild(span);
  }
};

const setOverlayVisible = async (visible) => {
  if (overlayVisible === visible) return;
  overlayVisible = visible;
  try {
    await invoke('set_overlay_visible', { visible });
  } catch (error) {
    console.warn('切换桌面歌词窗口可见性失败', error);
  }
};

const render = () => {
  const lyrics = Array.isArray(playback.lyrics) ? playback.lyrics : [];
  const hasLyrics = Boolean(playback.track && lyrics.length > 0);
  setOverlayVisible(hasLyrics && socket?.readyState === WebSocket.OPEN);
  if (!hasLyrics) {
    previousLine.textContent = '';
    currentLine.textContent = '';
    nextLine.textContent = '';
    return;
  }
  const position = effectivePosition();
  const frame = lyricFrame(lyrics, position);
  setPlainLine(previousLine, frame.previous);
  renderCurrentLine(frame.current, position);
  setPlainLine(nextLine, frame.next);
  toggleButton.textContent = playback.paused ? '▶' : 'Ⅱ';
};

const applyStateMessage = (message) => {
  if (message.type === 'track') {
    playback.track = message.track || null;
    playback.lyrics = Array.isArray(message.lyrics) ? message.lyrics : [];
  }
  if (message.type !== 'track' && message.type !== 'progress') return;
  playback.position = Math.max(0, Number(message.position) || 0);
  playback.duration = Math.max(0, Number(message.duration) || 0);
  playback.paused = Boolean(message.paused);
  playback.currentIndex = Number.isInteger(message.current_index) ? message.current_index : -1;
  playback.receivedAt = performance.now();
  render();
};

const closeSocket = () => {
  if (reconnectTimer) window.clearTimeout(reconnectTimer);
  reconnectTimer = null;
  const opened = socket;
  socket = null;
  if (opened) opened.close();
  setOverlayVisible(false);
};

const scheduleReconnect = (version) => {
  if (version !== configVersion) return;
  reconnectTimer = window.setTimeout(() => connect(version), reconnectDelay);
  reconnectDelay = Math.min(RECONNECT_MAX_MS, reconnectDelay * 2);
};

const connect = async (version = configVersion) => {
  if (version !== configVersion) return;
  let config;
  try {
    config = await invoke('connection_config');
  } catch (error) {
    console.warn('读取桌面歌词连接配置失败', error);
    scheduleReconnect(version);
    return;
  }
  if (!config?.base_url || !config?.device_token) {
    setOverlayVisible(false);
    return;
  }
  let opened;
  try {
    opened = new WebSocket(desktopLyricsDeviceWebSocketURL(config.base_url), [PROTOCOL, `${TOKEN_PROTOCOL_PREFIX}${config.device_token}`]);
  } catch (error) {
    console.warn('创建桌面歌词 WebSocket 失败', error);
    scheduleReconnect(version);
    return;
  }
  socket = opened;
  opened.onopen = () => {
    reconnectDelay = 1000;
  };
  opened.onmessage = (event) => {
    try {
      applyStateMessage(JSON.parse(event.data));
    } catch (error) {
      console.warn('忽略无效桌面歌词消息', error);
    }
  };
  opened.onerror = () => {
    console.warn('桌面歌词 WebSocket 连接异常');
  };
  opened.onclose = () => {
    if (socket === opened) socket = null;
    setOverlayVisible(false);
    scheduleReconnect(version);
  };
};

controls.addEventListener('click', (event) => {
  const command = event.target.closest('button')?.dataset.command;
  if (!['prev', 'toggle', 'next'].includes(command) || socket?.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({ type: 'command', command }));
});

lyricsShell.addEventListener('mousedown', (event) => {
  if (event.button !== 0 || event.target.closest('.controls')) return;
  invoke('start_overlay_drag').catch((error) => console.warn('拖动桌面歌词窗口失败', error));
});

listen('click-through-changed', (event) => {
  document.body.classList.toggle('passthrough', Boolean(event.payload));
});

listen('desktop-config-changed', () => {
  configVersion += 1;
  closeSocket();
  reconnectDelay = 1000;
  connect(configVersion);
});

invoke('get_click_through')
  .then((enabled) => document.body.classList.toggle('passthrough', Boolean(enabled)))
  .catch((error) => console.warn('读取鼠标穿透状态失败', error));

window.setInterval(render, 80);
connect();
