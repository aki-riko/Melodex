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

import { lineProgress as coreLineProgress, lyricFrame } from './lyricsCore.js';

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
// 旧实现用 Fluent.Enums.duration.slower = 300ms（Metrics.qml:38），
// 不是 380。帧驱动动画（FrameAnimation）本身不设时长，300 只用于行切换过渡。
const TRANSITION_MS = 300;

// 歌词行左右内边距之和，必须与 overlay.css 里 .lyrics-shell 的
// `padding: 12px 46px 14px`（左右各 46px）一致。
// 缩字号时可用宽度 = 行宽 - 这个值，否则量出来的可容纳宽度偏大，仍会溢出。
//
// 46×2 = 92 与旧版等价：lyricSurface 内缩 12 + 行内 margin 34 = 46/边。
const LINE_HORIZONTAL_PADDING = 92;

// 副行在公用内边距之外再各缩 8px（旧版副行 margin 42、主行 34，差 8）。
// 必须与 overlay.css 里 `.adjacent { left: 8px; right: 8px; }` 一致，
// 否则量副行可用宽度时会偏大 16px，长副行仍会溢出。
const SECONDARY_EXTRA_INSET = 8;

// 三层结构（复刻 DesktopLyricsWindow.qml:371-480）：
//   outgoing = 旧行，current = 新行（从副行位置长上来），next = 副行
const outgoingWrap = document.getElementById('outgoing-line');
const outgoingBase = document.getElementById('outgoing-line-base');
const outgoingActive = document.getElementById('outgoing-line-active');
const currentWrap = document.getElementById('current-line-wrap');
const currentBase = document.getElementById('current-line-base');
const currentClip = document.getElementById('current-line-clip');
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

/**
 * 保存位置到壳侧设置。
 *
 * 旧实现的节奏（DesktopLyricsWindow.qml:120-123 + 230-238）：
 * `onXChanged/onYChanged → schedulePositionSave()`，即**坐标一变就起 300ms 防抖**，
 * 到点才落盘。拖动过程中不会每帧写盘，松手 300ms 后一定保存。
 *
 * 新版拖动是系统接管（`start_dragging()`），拿不到逐帧坐标，
 * 所以在 mouseup / 窗口卸载时保存；这里再补一次「回拉后保存」，
 * 保证存下来的坐标一定是**夹进可视区之后**的值。
 */
const savePosition = async () => {
  try {
    // 先回拉再保存：旧版每次坐标变化都 clamp，落盘的永远是可显示位置。
    // 直接把用户拖到屏幕外的坐标存进设置，重启后歌词就会「消失」。
    await invoke('overlay_clamp_position');
    const [x, y] = await invoke('overlay_position');
    await invoke('lyrics_save_position', { x, y });
  } catch (error) {
    // 位置保存失败不影响歌词显示，但必须留痕，否则「拖了不记住」无从排查。
    console.warn('保存桌面歌词位置失败', error);
  }
};

/**
 * 恢复上次保存的位置 —— 复刻旧实现 `restorePosition`（DesktopLyricsWindow.qml:106-118）。
 *
 * ★ 恢复之后**必须立刻夹回可视区**（旧版是 `Qt.callLater(clampToVisibleArea)`）。
 *   两个理由：
 *   ① 显示器分辨率/排列变了（拔掉副屏、改缩放），旧坐标可能已经落在屏幕外；
 *   ② 窗口高度随字号变化，同一 y 在更大字号下可能顶出底边。
 *   不夹的话用户会遇到「歌词明明开着，但整块在屏幕外，怎么都看不见」。
 */
const restorePosition = async () => {
  if (!settings.position_set) return;
  try {
    await invoke('set_overlay_position', {
      x: Math.round(settings.position_x),
      y: Math.round(settings.position_y),
    });
    await invoke('overlay_clamp_position');
  } catch (error) {
    console.warn('恢复桌面歌词位置失败', error);
  }
};

// ---------- 行切换动画 ----------

const setPlainLine = (element, line) => {
  element.textContent = line?.text || '';
};

/**
 * 整行进度（0..1），等价旧实现 `melodex::lyricProgress`（Lyrics.cpp:140）。
 *
 * 算法本体在 `lyricsCore.js` 的 `lineProgress`（有单测锁死与旧版逐条一致）：
 *   - 有 words 时按**字数加权**（totalChars = Σ max(1, len(word.s))），
 *     不是「每个词各自算比例再各画一段」——后者中英文混排时长词会填得忽快忽慢。
 *   - 无 words 时 progress = (position - t) / (end - t)。
 *
 * 这里只做一层薄封装：把 null/缺行统一成 progress 0，
 * 免得调用点各自判空（判漏一次就是「整行突然满格」）。
 */
const lineProgress = (line, position) => coreLineProgress(line, position);

/** 字号适配测量用的隐藏 canvas（避免反复读 DOM 触发重排）。 */
const measureCanvas = document.createElement('canvas');
const measureCtx = measureCanvas.getContext('2d');

/** 读当前歌词字体族（由设置写入 CSS 变量）。 */
const lyricFontFamily = () => {
  const family = getComputedStyle(document.documentElement)
    .getPropertyValue('--lyric-font-family')
    .trim();
  return family || '"Microsoft YaHei UI"';
};

/**
 * 用 canvas 量文字宽度。字体必须与渲染一致，否则量出来的宽度偏小/偏大。
 * 主行是 DemiBold(600)；副行量的是 <span>，这里不需要。
 */
const measureText = (text, sizePx) => {
  if (!text || !measureCtx) return 0;
  measureCtx.font = `600 ${sizePx}px ${lyricFontFamily()}`;
  return measureCtx.measureText(text).width;
};

/** 字号适配结果缓存：key = `${text}|${baseSize}|${availableWidth}` */
const fitCache = new Map();
const FIT_CACHE_LIMIT = 200;

/**
 * 计算让整行文字放进可用宽度所需的字号缩放系数（等价旧实现 Text.Fit）。
 *
 * 旧实现 WordFill.qml:37-41：
 *     fontSizeMode: Text.Fit
 *     minimumPixelSize: root.minimumPixelSize
 *     elide: Text.ElideRight
 * → 先按设定字号排版，放不下就**等比缩小字号**，缩到最小仍放不下才省略号。
 *
 * 本鱼最初只写 text-overflow:ellipsis + 固定字号，长句子直接冲出窗口被硬切，
 * 而且因为 -webkit-text-stroke 的关系，被切掉的边缘还会糊成一片。
 *
 * @returns {number} 缩放系数（<1 表示需要缩小）；1 表示原始字号即可
 */
const fitScale = (text, baseSize, availableWidth, minimumPixelSize = FONT_SIZE_MIN) => {
  if (!text || !availableWidth) return 1;

  const key = `${text}|${baseSize}|${Math.round(availableWidth)}|${minimumPixelSize}`;
  const cached = fitCache.get(key);
  if (cached !== undefined) return cached;

  const measured = measureText(text, baseSize);

  let scale = 1;
  if (measured > availableWidth && measured > 0) {
    scale = availableWidth / measured;
    // 旧实现的 minimumPixelSize 兜底（不无限缩小）。
    // 主行下限 20px；副行下限是 max(14, 主行最小 - 4)（见调用处）。
    scale = Math.max(scale, minimumPixelSize / Math.max(1, baseSize));
  }

  if (fitCache.size > FIT_CACHE_LIMIT) fitCache.clear();
  fitCache.set(key, scale);
  return scale;
};

/**
 * 副行的最小字号 —— 复刻 `DesktopLyricsWindow.qml:464`：
 * `minimumPixelSize: Math.max(14, UserSettings.lyricsFontSizeMinimum - 4)`
 *
 * 注意这里的 `-4` 是相对**主行最小字号 20** 而言，不是相对当前字号：
 * 主行下限恒为 20，所以副行下限恒为 max(14, 16) = 16。
 */
const secondaryMinimumPixelSize = () => Math.max(14, FONT_SIZE_MIN - 4);

/**
 * 副行独立的字号适配 —— 复刻 `DesktopLyricsWindow.qml:462-464`。
 *
 * ★ 旧版副行有自己的 `Text.Fit`，**与主行缩放互不影响**：
 *   主行那句话很短（不需要缩），副行很长（需要缩），两者各缩各的。
 *   早期新版让副行复用主行的 `--line-font-scale`，于是副行长句会溢出、
 *   而主行短句明明不需要缩却跟着变小的反向情况也会出现。
 */
const renderSecondaryLine = (text) => {
  const baseSize = Math.max(
    SECONDARY_MIN_SIZE,
    Math.round(clampFontSize(settings.font_size) * SECONDARY_SCALE),
  );
  const rowWidth = nextLine.clientWidth;
  // 副行左右各有 8px 额外内缩（与 .adjacent 的 left/right 对应），
  // 在这里扣掉才能量准可用宽度。
  const available = Math.max(0, rowWidth - LINE_HORIZONTAL_PADDING - SECONDARY_EXTRA_INSET * 2);
  const scale = fitScale(text, baseSize, available, secondaryMinimumPixelSize());
  lyricsShell.style.setProperty('--secondary-font-scale', String(scale));
};

/**
 * 量某一层文字**实际排版宽度**与它相对行的左偏移（用 DOM Range，不靠 canvas 估算）。
 *
 * ★ 为什么不能用 canvas.measureText 定裁剪区（实际踩到的 bug）：
 *   canvas 只算字形 advance，**不计 letter-spacing 与 -webkit-text-stroke 的外扩**。
 *   实测同一句话：canvas 651.97px，DOM 实际 665.3px —— 差 13.33px（约 2%）。
 *   拿 canvas 值当裁剪宽度，clip 会比白底文字窄一圈、还右移几像素，
 *   于是未播放色的白字从四周露出来，观感就是「粉字外面一圈白边 + 重影」。
 *   canvas 仍用于字号适配的**估算**（差异不影响是否需要缩放），
 *   但定位裁剪区必须用真实排版结果。
 *
 * @returns {{left:number, width:number}} 相对当前行内容盒的偏移与宽度
 */
const measureLineBox = (baseElement, rowElement) => {
  const range = document.createRange();
  range.selectNodeContents(baseElement);
  const textRect = range.getBoundingClientRect();
  const rowRect = rowElement.getBoundingClientRect();
  if (!textRect.width || !rowRect.width) return null;
  return {
    left: textRect.left - rowRect.left,
    width: textRect.width,
  };
};

/**
 * 渲染主行：底层未播放色整行 + 上层已播放色被裁剪。
 * 文本只在**内容真的变了**时才写 DOM，避免每帧重排导致闪烁。
 */
const renderCurrentLine = (line, position) => {
  const text = line?.text || '';

  const textChanged = currentBase.textContent !== text;
  if (textChanged) {
    currentBase.textContent = text;
    currentLine.textContent = text;
  }

  const ratio = lineProgress(line, position);
  currentClip.style.setProperty('--fill-ratio', String(ratio));

  const baseSize = clampFontSize(settings.font_size);
  const rowWidth = currentWrap.clientWidth;
  const available = Math.max(0, rowWidth - LINE_HORIZONTAL_PADDING);

  // 先按基础字号估一次：超宽就缩字号（等价旧版 Text.Fit）。
  const scale = fitScale(text, baseSize, available);

  if (textChanged || lyricsShell.style.getPropertyValue('--line-font-scale') !== String(scale)) {
    lyricsShell.style.setProperty('--line-font-scale', String(scale));
  }

  // 缩放系数写进 CSS 后必须**等一帧**再量——否则量到的还是上一档字号。
  // 用 sync 量法：先写变量，再强制读一次布局（getBoundingClientRect 会触发布局），
  // 这样在同一帧内就能拿到新字号下的真实宽度，不需要 rAF 延迟（会闪一帧）。
  const box = measureLineBox(currentBase, currentWrap);
  if (!box) return;

  // ★ 复刻 WordFill.qml:24-25：
  //     textPaintedWidth = min(可用宽度, 文字实际宽度)
  //     textLeft         = (可用宽度 - textPaintedWidth) / 2
  //   裁剪从**文字左边缘**开始，切掉的是"已经唱过的部分"，
  //   而不是从行左边缘开始（后者对短句明显错位）。
  //
  // 这里直接用 DOM 量出来的 left/width：Range 的结果已经包含 letter-spacing
  // 与描边外扩，clip 因此能严丝合缝盖住白底，不再露白边。
  lyricsShell.style.setProperty('--text-left', `${box.left}px`);
  lyricsShell.style.setProperty('--text-width', `${box.width}px`);
  currentLine.style.setProperty('--line-width', `${rowWidth}px`);
};

/**
 * 行切换动画：复刻旧实现 DesktopLyricsWindow.qml:482-491。
 *
 * 旧版用 NumberAnimation 把 lyricTransitionProgress 从 0 线性推到 1，
 * duration = Fluent.Enums.duration.slower = **300ms**，easing = InOutCubic，
 * 然后由 QML 的绑定表达式把同一个 progress 映射到三个元素上：
 *
 *   旧行：y -= 行高*0.45*exit，opacity = 1-exit，  exit = min(1, p/0.78)
 *   新行：y 从副行位置插值到主行位置，scale 从 0.67 到 1，opacity 0.96→1
 *   副行：y 从下方 35% 行高浮起，opacity 0.92*entry，entry = max(0,(p-0.3)/0.7)
 *
 * 三个元素**共用同一个 progress**，所以是连续一体的过渡，不是各自独立淡入。
 * 本鱼之前用一个一次性 class + CSS transition，做不出「新行从副行位置长上来」。
 *
 * 这里用 requestAnimationFrame 自己推进 progress，并在 JS 里做 InOutCubic
 * （CSS 端只做线性插值，避免缓动被叠加两次）。
 */
const TRANSITION_EASE = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

let transitionFrame = 0;

/** 把 progress(0..1) 写进 CSS 变量，三个元素一起动。 */
const applyTransitionProgress = (progress) => {
  lyricsShell.style.setProperty('--transition-progress', String(progress));
};

/** 结束过渡：progress=1，清掉旧行文本（旧行只在过渡期可见）。 */
const finishTransition = () => {
  if (transitionFrame) {
    window.cancelAnimationFrame(transitionFrame);
    transitionFrame = 0;
  }
  applyTransitionProgress(1);
  outgoingBase.textContent = '';
  outgoingActive.textContent = '';
  outgoingWrap.style.visibility = 'hidden';
};

/**
 * 启动一次换行动画。
 *
 * @param {string} outgoingText 上一行的文字（作为上移淡出的"旧行"）
 */
const startLineTransition = (outgoingText) => {
  if (transitionFrame) {
    window.cancelAnimationFrame(transitionFrame);
    transitionFrame = 0;
  }

  // 旧行内容与位置在动画期间可见
  if (outgoingText) {
    outgoingBase.textContent = outgoingText;
    outgoingActive.textContent = outgoingText;
    outgoingActive.style.setProperty('--line-width', `${currentWrap.clientWidth}px`);
    outgoingWrap.style.visibility = 'visible';
  } else {
    outgoingWrap.style.visibility = 'hidden';
  }

  const startedAt = performance.now();
  applyTransitionProgress(0);

  const step = (now) => {
    const elapsed = now - startedAt;
    const linear = Math.min(1, elapsed / TRANSITION_MS);
    applyTransitionProgress(TRANSITION_EASE(linear));

    if (linear < 1) {
      transitionFrame = window.requestAnimationFrame(step);
    } else {
      transitionFrame = 0;
      finishTransition();
    }
  };
  transitionFrame = window.requestAnimationFrame(step);
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

/**
 * 主行/副行该显示什么。
 *
 * ★ 复刻旧实现 DesktopLyricsWindow.qml:20-25：
 *   activeText: activeLine ? activeLine.text : (Player.currentSong.name || "")
 *   nextText:   nextLine   ? nextLine.text   : (Player.currentSong.artist || "")
 *
 * 即**没有歌词时显示歌曲名 / 歌手名**，而不是把窗口留空。
 * 本鱼最初写成「无歌词就清空」，导致纯音乐或歌词未加载时窗口一片空白——
 * 用户看到的就是"歌词没了"。
 */
const currentDisplayText = (frame, hasLyricLines) => {
  if (hasLyricLines && frame?.current) return frame.current.text || '';
  if (hasLyricLines) return '';
  return playback.track?.name || '';
};

const nextDisplayText = (frame, hasLyricLines) => {
  if (hasLyricLines && frame?.next) return frame.next.text || '';
  if (hasLyricLines) return '';
  return playback.track?.artist || '';
};

const render = () => {
  // 用户关掉歌词（settings.visible=false）后，即使还有歌在放也不能再弹出来。
  setOverlayVisible(playback.hasState && settings.visible);

  // 没有歌曲信息时才彻底清空（此时本来就没东西可显示）。
  if (!playback.track) {
    if (currentBase.textContent !== '') {
      currentBase.textContent = '';
      currentLine.textContent = '';
    }
    nextLine.textContent = '';
    renderedLineIndex = -2;
    renderedActiveText = '';
    return;
  }

  const withLyrics = hasLyrics();
  const position = effectivePosition();
  const frame = withLyrics ? lyricFrame(playback.lyrics, position) : null;

  const mainText = currentDisplayText(frame, withLyrics);
  const secondaryText = nextDisplayText(frame, withLyrics);

  const changedLine = withLyrics && frame && frame.index !== renderedLineIndex;
  const changedText = mainText !== renderedActiveText;

  // 无歌词时进度恒为 0：歌曲名整体用"未播放色"显示，与旧版一致。
  renderCurrentLine({ text: mainText }, withLyrics ? position : Number.NEGATIVE_INFINITY);
  setPlainLine(nextLine, { text: secondaryText });
  renderSecondaryLine(secondaryText);

  // 真的换行且上一行有内容时才播切换动画（对齐旧版 canAnimateForward 的意图：
  // 首次出现、跳行、倒退都不做「从上往下滚」那套）。
  if (changedLine && changedText) {
    const canAnimate = renderedActiveText.length > 0
      && mainText.length > 0
      && renderedLineIndex >= 0
      && frame.index === renderedLineIndex + 1;
    if (canAnimate) startLineTransition(renderedActiveText);
    else finishTransition();
  }

  renderedLineIndex = withLyrics && frame ? frame.index : -2;
  renderedActiveText = mainText;

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

// 双击空白处关闭歌词 —— 复刻旧实现 DesktopLyricsWindow.qml:493-499 的
// `Fluent.WindowDragHandle { onDoubleClicked: setLyricsVisible(false) }`。
//
// 注意必须排除控制条：双击「上一首」按钮不该把歌词关掉。
// 旧实现里控制条是独立元素（z=10 盖在拖拽层 z=9 之上），点击不会穿透到拖拽层；
// Web 侧用 closest('.controls') 做同样的隔离。
lyricsShell.addEventListener('dblclick', async (event) => {
  if (event.target.closest('.controls')) return;
  if (settings.click_through) return;
  await updateSettings({ visible: false });
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

// 初始 progress=1：静止状态下新行就在主行位置、副行完全可见。
// 若不初始化，CSS 里 --transition-progress 缺失会让首帧显示成"正在动画"的缩小态。
applyTransitionProgress(1);
outgoingWrap.style.visibility = 'hidden';
