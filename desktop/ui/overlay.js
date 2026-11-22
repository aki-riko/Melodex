// 桌面歌词窗：壳内直连，不需要配对码与服务器中转。
//
// 视觉与交互对齐旧 PrismQML 实现（desktop-prismqml/qml/components/DesktopLyricsWindow.qml）：
//   - 字号 20..64，默认 36，按窗口宽度自动收缩（等价 Text.Fit + minimumPixelSize）
//   - 副行字号 = 主行 × 0.67（最小 16）
//   - 行切换上移淡出 / 下移淡入（380ms InOutCubic）
//   - 逐字左右填色（CSS 渐变按 --fill 切分）
//   - 窗口位置持久化（localStorage，等价 UserSettings.setLyricsPosition）
//
// 数据通道（2026-11 架构）：
//   主窗口页面 --invoke('lyrics_push_state')--> Rust --emit--> 本窗口
//   本窗口 --invoke('lyrics_send_command')--> Rust --eval event--> 主窗口页面

import { lyricFrame, lyricWordFill } from './lyricsCore.js';

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const STATE_EVENT = 'melodex:lyrics-state';
const RENDER_INTERVAL_MS = 80;

// ---- 与旧实现对齐的常量（改之前对照 config.py / DesktopLyricsWindow.qml）----
const FONT_SIZE_MIN = 20;
const FONT_SIZE_MAX = 64;
const FONT_SIZE_DEFAULT = 36;
const SECONDARY_SCALE = 0.67;
const SECONDARY_MIN_PX = 16;
const TRANSITION_MS = 380;

const POSITION_KEY = 'melodex_lyrics_position';
const FONT_KEY = 'melodex_lyrics_font_size';

// 双行：主行 = 当前歌词，副行 = 下一行（对齐旧 PrismQML 实现）。
const currentLine = document.getElementById('current-line');
const nextLine = document.getElementById('next-line');
const lyricsShell = document.getElementById('lyrics-shell');
const controls = document.getElementById('controls');
const toggleButton = document.getElementById('toggle-button');

let overlayVisible = false;
let renderedLineIndex = -2;
let renderedActiveText = '';
let playback = {
  track: null,
  lyrics: [],
  position: 0,
  duration: 0,
  paused: true,
  currentIndex: -1,
  receivedAt: performance.now(),
  hasState: false,
};

/** 旧实现 Player.visualPosition()：暂停时用上报位置，播放时按帧插值。 */
const effectivePosition = () => {
  if (playback.paused) return playback.position;
  const elapsed = Math.max(0, performance.now() - playback.receivedAt) / 1000;
  return Math.min(playback.duration || Number.MAX_SAFE_INTEGER, playback.position + elapsed);
};

// ---------- 字号 ----------

const clampFontSize = (value) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return FONT_SIZE_DEFAULT;
  return Math.max(FONT_SIZE_MIN, Math.min(FONT_SIZE_MAX, Math.round(numeric)));
};

const loadFontSize = () => {
  try {
    const stored = window.localStorage.getItem(FONT_KEY);
    return stored == null ? FONT_SIZE_DEFAULT : clampFontSize(stored);
  } catch {
    return FONT_SIZE_DEFAULT;
  }
};

const applyFontSize = (px) => {
  document.documentElement.style.setProperty('--lyric-font-size', `${px}px`);
  const secondary = Math.max(SECONDARY_MIN_PX, Math.round(px * SECONDARY_SCALE));
  document.documentElement.style.setProperty('--secondary-font-size', `${secondary}px`);
};

// ---------- 窗口位置持久化 ----------

const savePosition = async () => {
  try {
    const [x, y] = await invoke('overlay_position');
    window.localStorage.setItem(POSITION_KEY, JSON.stringify({ x, y }));
  } catch {
    /* 存储或位置读取不可用不影响歌词显示 */
  }
};

const restorePosition = async () => {
  let stored = null;
  try {
    const raw = window.localStorage.getItem(POSITION_KEY);
    if (raw) stored = JSON.parse(raw);
  } catch {
    stored = null;
  }
  if (!stored || !Number.isFinite(stored.x) || !Number.isFinite(stored.y)) return;
  try {
    await invoke('set_overlay_position', {
      x: Math.round(stored.x),
      y: Math.round(stored.y),
    });
  } catch (error) {
    console.warn('恢复桌面歌词位置失败', error);
  }
};

// ---------- 行切换动画 ----------

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

/**
 * 行推进时给主行加一次进出场动画。
 * 只在「真的换行」时触发，同一行内的逐字推进不重放动画（否则会一直闪）。
 */
const animateLineChange = () => {
  currentLine.classList.remove('is-entering');
  currentLine.classList.remove('is-leaving');
  // 强制 reflow 让上面的移除生效，动画可重复触发。
  void currentLine.offsetWidth;
  currentLine.classList.add('is-entering');
  window.setTimeout(() => currentLine.classList.remove('is-entering'), TRANSITION_MS);
};

// ---------- 渲染 ----------

const setOverlayVisible = async (visible) => {
  if (overlayVisible === visible) return;
  overlayVisible = visible;
  try {
    await invoke('set_overlay_visible', { visible });
  } catch (error) {
    console.warn('切换桌面歌词窗口可见性失败', error);
  }
};

const hasLyrics = () => Boolean(
  playback.track && Array.isArray(playback.lyrics) && playback.lyrics.length > 0,
);

const render = () => {
  setOverlayVisible(playback.hasState && hasLyrics());

  if (!hasLyrics()) {
    currentLine.textContent = '';
    nextLine.textContent = '';
    renderedLineIndex = -2;
    renderedActiveText = '';
    return;
  }

  const position = effectivePosition();
  const frame = lyricFrame(playback.lyrics, position);

  const changedLine = frame.index !== renderedLineIndex;
  const changedText = (frame.current?.text || '') !== renderedActiveText;

  renderCurrentLine(frame.current, position);
  setPlainLine(nextLine, frame.next);

  if (changedLine && changedText) animateLineChange();
  renderedLineIndex = frame.index;
  renderedActiveText = frame.current?.text || '';

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

// ---------- 事件 ----------

listen(STATE_EVENT, (event) => applyStateMessage(event.payload));

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

window.addEventListener('mouseup', () => { savePosition(); });
window.addEventListener('beforeunload', () => { savePosition(); });

listen('click-through-changed', (event) => {
  document.body.classList.toggle('passthrough', Boolean(event.payload));
});

// ---------- 启动 ----------

applyFontSize(loadFontSize());
restorePosition();

invoke('get_click_through')
  .then((enabled) => document.body.classList.toggle('passthrough', Boolean(enabled)))
  .catch((error) => console.warn('读取鼠标穿透状态失败', error));

window.setInterval(render, RENDER_INTERVAL_MS);

// 启动时先隐藏，等主窗口推来第一条状态。
setOverlayVisible(false);
