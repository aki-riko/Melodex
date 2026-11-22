// 桌面歌词窗：走壳内直连，不再需要配对码与服务器中转。
//
// 架构变更（2026-11）：旧版通过 WebSocket 连服务器 hub，必须先配对拿到设备令牌。
// 新客户端里播放与歌词同进程，改为：
//   主窗口页面 --invoke('lyrics_push_state')--> Rust --emit--> 本窗口
//   本窗口 --invoke('lyrics_send_command')--> Rust --eval event--> 主窗口页面
//
// 好处：开箱即用、不需要配对、断网也能显示歌词。

import { lyricFrame, lyricWordFill } from './lyricsCore.js';

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const STATE_EVENT = 'melodex:lyrics-state';
const RENDER_INTERVAL_MS = 80;

const previousLine = document.getElementById('previous-line');
const currentLine = document.getElementById('current-line');
const nextLine = document.getElementById('next-line');
const lyricsShell = document.getElementById('lyrics-shell');
const controls = document.getElementById('controls');
const toggleButton = document.getElementById('toggle-button');

let overlayVisible = false;
let playback = {
  track: null,
  lyrics: [],
  position: 0,
  duration: 0,
  paused: true,
  currentIndex: -1,
  receivedAt: performance.now(),
  // 是否至少收到过一次有效状态；没收到前不显示窗口。
  hasState: false,
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

const hasLyrics = () => Boolean(playback.track && Array.isArray(playback.lyrics) && playback.lyrics.length > 0);

const render = () => {
  // 只有「收到过状态 + 有歌词」才显示；否则隐藏，避免空白窗浮在桌面上。
  setOverlayVisible(playback.hasState && hasLyrics());

  if (!hasLyrics()) {
    previousLine.textContent = '';
    currentLine.textContent = '';
    nextLine.textContent = '';
    return;
  }
  const position = effectivePosition();
  const frame = lyricFrame(playback.lyrics, position);
  setPlainLine(previousLine, frame.previous);
  renderCurrentLine(frame.current, position);
  setPlainLine(nextLine, frame.next);
  toggleButton.textContent = playback.paused ? '▶' : 'Ⅱ';
};

const applyStateMessage = (message) => {
  if (!message || (message.type !== 'track' && message.type !== 'progress')) return;

  if (message.type === 'track') {
    playback.track = message.track || null;
    playback.lyrics = Array.isArray(message.lyrics) ? message.lyrics : [];
  }
  playback.position = Math.max(0, Number(message.position) || 0);
  playback.duration = Math.max(0, Number(message.duration) || 0);
  playback.paused = Boolean(message.paused);
  playback.currentIndex = Number.isInteger(message.current_index) ? message.current_index : -1;
  playback.receivedAt = performance.now();
  playback.hasState = true;
  render();
};

// 主通道：壳转发主窗口推来的状态。
listen(STATE_EVENT, (event) => {
  applyStateMessage(event.payload);
});

controls.addEventListener('click', async (event) => {
  const command = event.target.closest('button')?.dataset.command;
  if (!['prev', 'toggle', 'next'].includes(command)) return;
  try {
    await invoke('lyrics_send_command', { command });
  } catch (error) {
    console.warn('发送桌面歌词控制命令失败', error);
  }
});

lyricsShell.addEventListener('mousedown', (event) => {
  if (event.button !== 0 || event.target.closest('.controls')) return;
  invoke('start_overlay_drag').catch((error) => console.warn('拖动桌面歌词窗口失败', error));
});

listen('click-through-changed', (event) => {
  document.body.classList.toggle('passthrough', Boolean(event.payload));
});

invoke('get_click_through')
  .then((enabled) => document.body.classList.toggle('passthrough', Boolean(enabled)))
  .catch((error) => console.warn('读取鼠标穿透状态失败', error));

// 本地进度插值：壳只转发关键帧，这里按 80ms 平滑推进歌词位置。
window.setInterval(render, RENDER_INTERVAL_MS);

// 启动时先隐藏，等主窗口推来第一条状态。
setOverlayVisible(false);
