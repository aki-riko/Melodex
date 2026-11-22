// 桌面歌词窗：壳内直连，不需要配对码与服务器中转。
//
// 视觉与交互对齐旧 PrismQML 实现（desktop-prismqml/qml/components/DesktopLyricsWindow.qml）：
//   - 字号 20..64，默认 36（由设置文件提供，不再是 localStorage）
//   - 副行字号 = 主行 × 0.67（最小 16）
//   - 行切换上移淡出 / 下移淡入（380ms InOutCubic）
//   - 逐字左右填色（CSS 渐变按 --fill 切分）
//   - 控制条 5 按钮：上一首 / 播放暂停 / 下一首 / 锁定 / 关闭
//   - 窗口位置持久化（走壳侧设置文件，等价旧 UserSettings 的 lyrics_x/y）
//
// 数据通道（2026-11 架构）：
//   主窗口页面 --invoke('lyrics_push_state')--> Rust --emit--> 本窗口
//   本窗口 --invoke('lyrics_send_command')--> Rust --eval event--> 主窗口页面
//   本窗口 --invoke('lyrics_settings_*')--> Rust（读/改本机设置）
//
// 设置是**唯一真相源在 Rust 侧**：本窗口不写 localStorage，避免设置页与歌词窗各存一份。

import { lyricFrame, lyricWordFill } from './lyricsCore.js';

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const STATE_EVENT = 'melodex:lyrics-state';
const SETTINGS_EVENT = 'melodex:lyrics-settings';
const RENDER_INTERVAL_MS = 80;

// ---- 与旧实现对齐的常量（改之前对照 config.py / DesktopLyricsWindow.qml）----
const FONT_SIZE_MIN = 20;
const FONT_SIZE_MAX = 64;
const FONT_SIZE_DEFAULT = 36;
const SECONDARY_SCALE = 0.67;
const SECONDARY_MIN_PX = 16;
const TRANSITION_MS = 380;

// 双行：主行 = 当前歌词，副行 = 下一行（对齐旧 PrismQML 实现）。
const currentLine = document.getElementById('current-line');
const nextLine = document.getElementById('next-line');
const lyricsShell = document.getElementById('lyrics-shell');
const controls = document.getElementById('controls');
const toggleButton = document.getElementById('toggle-button');

let overlayVisible = false;
let renderedLineIndex = -2;
let renderedActiveText = '';
let settings = {
  visible: true,
  click_through: true,
  font_size: FONT_SIZE_DEFAULT,
  color_scheme: '珊瑚绯',
  played_color: '#FFC6C6',
  unplayed_color: '#EEEEEE',
  font_family: 'Microsoft YaHei UI',
};
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

// ---------- 设置应用 ----------

const clampFontSize = (value) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return FONT_SIZE_DEFAULT;
  return Math.max(FONT_SIZE_MIN, Math.min(FONT_SIZE_MAX, Math.round(numeric)));
};

const applyFontSize = (px) => {
  document.documentElement.style.setProperty('--lyric-font-size', `${px}px`);
  const secondary = Math.max(SECONDARY_MIN_PX, Math.round(px * SECONDARY_SCALE));
  document.documentElement.style.setProperty('--secondary-font-size', `${secondary}px`);
};

const applyFontFamily = (family) => {
  const value = String(family || '').trim();
  if (!value) return;
  // 系统字体名里可能带空格（如 Microsoft YaHei UI），必须加引号。
  document.documentElement.style.setProperty(
    '--lyric-font-family',
    `"${value}", "Segoe UI", "PingFang SC", sans-serif`,
  );
};

const applyColors = (played, unplayed) => {
  if (played) document.documentElement.style.setProperty('--played-color', played);
  if (unplayed) document.documentElement.style.setProperty('--unplayed-color', unplayed);
};

const applyClickThrough = (enabled) => {
  document.body.classList.toggle('passthrough', Boolean(enabled));
};

/**
 * 消费一份设置快照。
 *
 * 只做「同值不动」的判断以外的事情，不做 diff 优化——设置变更频率极低
 * （用户手动点几下），复杂度不值得。
 */
const applySettings = (next) => {
  if (!next || typeof next !== 'object') return;
  settings = { ...settings, ...next };
  applyFontSize(clampFontSize(settings.font_size));
  applyFontFamily(settings.font_family);
  applyColors(settings.played_color, settings.unplayed_color);
  applyClickThrough(settings.click_through);
};

const loadSettings = async () => {
  try {
    applySettings(await invoke('lyrics_settings_get'));
  } catch (error) {
    // 读不到设置就用内置默认值渲染，绝不因此不显示歌词。
    console.warn('读取歌词设置失败，使用默认值', error);
    applySettings(settings);
  }
};

/** 局部更新设置。写盘失败时壳侧不会改状态，这里也不再乐观更新 UI。 */
const updateSettings = async (patch) => {
  try {
    const updated = await invoke('lyrics_settings_update', { patch });
    applySettings(updated);
    return updated;
  } catch (error) {
    console.warn('保存歌词设置失败', error);
    return null;
  }
};

// ---------- 窗口位置持久化 ----------

const savePosition = async () => {
  try {
    const [x, y] = await invoke('overlay_position');
    await invoke('lyrics_save_position', { x, y });
  } catch {
    /* 位置保存失败不影响歌词显示 */
  }
};

const restorePosition = async () => {
  if (!settings.position_set) return;
  try {
    await invoke('set_overlay_position', {
      x: Math.round(settings.position_x),
      y: Math.round(settings.position_y),
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
  // 用户关掉歌词（settings.visible=false）后，即使还有歌在放也不能再弹出来。
  setOverlayVisible(playback.hasState && hasLyrics() && settings.visible);

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

  // 播放/暂停图标二选一由 class 控制（旧实现 icon 随 Player.playing 切换）。
  toggleButton.classList.toggle('is-playing', !playback.paused);
  toggleButton.title = playback.paused ? '播放' : '暂停';
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
listen(SETTINGS_EVENT, (event) => applySettings(event.payload));

controls.addEventListener('click', async (event) => {
  const button = event.target.closest('button');
  const command = button?.dataset.command;
  if (!command) return;

  // 锁定/关闭是**本机设置**，不经主窗口页面（旧实现同样直接改 UserSettings）。
  if (command === 'lock') {
    await updateSettings({ click_through: true });
    return;
  }
  if (command === 'close') {
    await updateSettings({ visible: false });
    return;
  }

  if (!['prev', 'toggle', 'next'].includes(command)) return;
  try {
    await invoke('lyrics_send_command', { command });
  } catch (error) {
    console.warn('发送桌面歌词控制命令失败', error);
  }
});

lyricsShell.addEventListener('mousedown', (event) => {
  if (event.button !== 0 || event.target.closest('.controls')) return;
  // 锁定时窗是穿透的，这里本来也收不到事件；再判一次防边界情况。
  if (settings.click_through) return;
  invoke('start_overlay_drag').catch((error) => console.warn('拖动桌面歌词窗口失败', error));
});

window.addEventListener('mouseup', () => {
  if (settings.click_through) return;
  savePosition();
});
window.addEventListener('beforeunload', () => {
  if (settings.click_through) return;
  savePosition();
});

listen('click-through-changed', (event) => {
  applyClickThrough(event.payload);
});

// ---------- 启动 ----------

invoke('get_click_through')
  .then((enabled) => applyClickThrough(enabled))
  .catch((error) => console.warn('读取鼠标穿透状态失败', error));

// 先取设置再恢复位置：位置是否恢复取决于 settings.position_set。
loadSettings().then(restorePosition);

window.setInterval(render, RENDER_INTERVAL_MS);

// 启动时先隐藏，等主窗口推来第一条状态。
setOverlayVisible(false);
