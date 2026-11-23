// 桌面歌词窗：壳内直连，不需要配对码与服务器中转。
//
// ★ 唯一权威是旧 PrismQML 实现，不要凭观感随手改：
//     desktop-prismqml/qml/components/DesktopLyricsWindow.qml
//     desktop-prismqml/qml/components/WordFill.qml
//     desktop-prismqml/cpp/Lyrics.cpp
//     desktop-prismqml/melodex_desktop/desktop_state.py
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

// ---- 与旧实现对齐的常量（改之前对照 config.py / DesktopLyricsWindow.qml）----
const FONT_SIZE_MIN = 20;
const FONT_SIZE_MAX = 64;
const FONT_SIZE_DEFAULT = 36;
const SECONDARY_SCALE = 0.67;
const SECONDARY_MIN_PX = 16;
// 旧实现用 Fluent.Enums.duration.slower = **300ms**（Metrics.qml 实测值，
// 不是 380）。帧驱动动画（FrameAnimation）本身不设时长，300 只用于行切换过渡。
const TRANSITION_MS = 300;

// 几何常量 —— 必须与 overlay.css 逐项相等，由 lyricsSettings.test.mjs 断言。
//
// 主行文字可用宽 = 窗口宽 - (12 + 34) * 2 = 窗口宽 - 92
//   12 = lyricSurface 相对窗口的左右内缩（QML :62 `width - 24`）
//   34 = 主行 anchors.left/rightMargin（QML :378-379）
// 副行文字可用宽 = 窗口宽 - (12 + 42) * 2 = 窗口宽 - 108
//   42 = 副行 anchors.left/rightMargin（QML :444-445）
const SURFACE_INSET = 12;
const LINE_INSET = 34;
const SECONDARY_INSET = 42;
const LINE_HORIZONTAL_PADDING = (SURFACE_INSET + LINE_INSET) * 2;
const SECONDARY_HORIZONTAL_PADDING = (SURFACE_INSET + SECONDARY_INSET) * 2;

// 三层结构（复刻 DesktopLyricsWindow.qml:371-480）：
//   outgoing = 旧行，current = 新行（从副行位置长上来），next = 副行
const outgoingWrap = document.getElementById('outgoing-line');
const outgoingBase = document.getElementById('outgoing-line-base');
const outgoingActive = document.getElementById('outgoing-line-active');
const currentWrap = document.getElementById('current-line-wrap');
const currentBase = document.getElementById('current-line-base');
const currentLine = document.getElementById('current-line');
const nextLine = document.getElementById('next-line');
const lyricsShell = document.getElementById('lyrics-shell');
const controls = document.getElementById('controls');
const toggleButton = document.getElementById('toggle-button');

let overlayVisible = false;
// -2 表示「还没有渲染过任何行」，与旧版 `property int renderedLineIndex: -2` 一致。
let renderedLineIndex = -2;
let renderedActiveText = '';
let renderedNextText = '';
// 正在播放切换动画时的旧行文字（QML 的 outgoingActiveText）。
let outgoingActiveText = '';
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

/** 播放状态的完整身份：source + id。用来判断"是否换了歌"。 */
const trackKey = (track) => (track ? `${track.source || ''}|${track.id || ''}` : '');

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

/** 副行字号 —— 复刻 config.py/overlay.rs 同式：max(16, round(主行 × 0.67))。 */
const secondaryFontSizeFor = (fontSize) => Math.max(
  SECONDARY_MIN_PX,
  Math.round(clampFontSize(fontSize) * SECONDARY_SCALE),
);

const applyFontSize = (px) => {
  const size = clampFontSize(px);
  const secondary = secondaryFontSizeFor(size);
  document.documentElement.style.setProperty('--lyric-font-size', `${size}px`);
  document.documentElement.style.setProperty('--secondary-font-size', `${secondary}px`);
  // 注：不再写 --incoming-scale —— 切行动画已去掉缩放（只保留位移 + 淡入）。
  // 缩放会让浏览器每帧用新的非整数比例重新栅格化字形，是「文字有锯齿」的根因，
  // 详见 overlay.css 里 .current-wrap 的注释。
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
  applyFontSize(settings.font_size);
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

// ---------- 字号适配（等价旧版 Text.Fit）----------

/** 字号适配测量用的隐藏 canvas（只用于「要不要缩字号」的估算，不用于定位裁剪区）。 */
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
 * 用 canvas 量文字宽度。
 *
 * ★ 旧版 letterSpacing 是 **0**（WordFill.qml:36 / :72 显式写 0），所以 canvas
 *   与 DOM 排版只差描边外扩那 1px，用于「要不要缩字号」的估算完全够。
 *   曾经 CSS 写 0.01em 字距，canvas 却按 0 量，实测同一句差 13.33px
 *   （0.01em × 36px × 37 字 ≈ 13.3px）—— 那才是当年「裁剪区对不上」的根因。
 *   定位裁剪区仍用真实 DOM 测量（见 measureLineWidth），不靠这个估算。
 */
const measureText = (text, sizePx, weight = 600) => {
  if (!text || !measureCtx) return 0;
  measureCtx.font = `${weight} ${sizePx}px ${lyricFontFamily()}`;
  return measureCtx.measureText(text).width;
};

/** 字号适配结果缓存：key = `${text}|${baseSize}|${availableWidth}|${minimum}` */
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
 * @returns {number} 缩放系数（<1 表示需要缩小）；1 表示原始字号即可
 */
const fitScale = (text, baseSize, availableWidth, minimumPixelSize = FONT_SIZE_MIN, weight = 600) => {
  if (!text || !availableWidth) return 1;

  const key = `${text}|${baseSize}|${Math.round(availableWidth)}|${minimumPixelSize}|${weight}`;
  const cached = fitCache.get(key);
  if (cached !== undefined) return cached;

  const measured = measureText(text, baseSize, weight);

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

// ---------- 真实排版测量（定位裁剪区用）----------

/** 读某个元素自身及祖先累计的视觉缩放（transform: scale 的乘积）。 */
const accumulatedScale = (element) => {
  let scale = 1;
  let node = element;
  while (node && node !== document.body && node !== document.documentElement) {
    const transform = getComputedStyle(node).transform;
    if (transform && transform !== 'none') {
      // matrix(a, b, c, d, e, f) —— 水平/垂直缩放取 a / d（我们只用等比缩放）
      const match = transform.match(/^matrix\(([^,]+),.*?([-0-9.]+),\s*([-0-9.]+),\s*([-0-9.]+)/);
      if (match) {
        const sx = Math.abs(Number(match[1]));
        const sy = Math.abs(Number(match[4]));
        if (Number.isFinite(sx) && sx > 0) scale *= sx;
        else if (Number.isFinite(sy) && sy > 0) scale *= sy;
      }
    }
    node = node.parentElement;
  }
  return scale > 0 ? scale : 1;
};

/**
 * 量某层文字**实际排版宽度**（已剔除祖先 transform 缩放）。
 *
 * 用 DOM 测量而不是 canvas：canvas 只算字形 advance，**不计描边外扩**，
 * 拿它当裁剪宽度会让 clip 比白底文字窄一圈，未播放色的白字从四周露出来
 * —— 观感就是「粉字外面一圈白边 + 重影」。
 *
 * ★★ `getBoundingClientRect()` 返回的是**被祖先 transform 缩放后**的尺寸，
 *   而这个函数在切行动画期间被调用 —— 主行正在 `scale(0.667 → 1)`。
 *   实测（CDP 现场量）：progress=0 时量到 96px，progress=1 时才 144px，
 *   动画期间只有真实宽度的 **2/3**。
 *   后果：`--text-width` 偏小 → 粉色裁剪区提前截断、右边露出白字；
 *   `--text-left` 也偏 → 两层横向错开。用户看到的正是「歌词向上滚动时
 *   粉字与白字分离」，而且只存在几帧（动画结束 scale=1 就正常了）。
 *   所以必须除以累计缩放，量到与 transform 无关的真实排版宽度。
 *
 * 只在**行文字或字号变化**时量一次（结果写进 CSS 变量后复用），
 * 不放进每帧的进度更新里：Range 测量会触发布局，80ms 一次纯属自找卡顿。
 *
 * @returns {number} 文字实际宽度（px，未缩放）；量不到返回 0
 */
const measureLineWidth = (baseElement) => {
  if (!baseElement || !baseElement.textContent) return 0;
  const range = document.createRange();
  range.selectNodeContents(baseElement);
  const rect = range.getBoundingClientRect();
  if (!rect.width) return 0;
  const scale = accumulatedScale(baseElement);
  return scale === 1 ? rect.width : rect.width / scale;
};

/**
 * 每行最近一次已应用的几何签名。
 *
 * ★ 为什么必须带 `availableWidth` 一起比较（踩过）：
 *   窗口隐藏时 `clientWidth` 量到 0，几何算不出来；等窗口显示、宽度到位后，
 *   文字与缩放系数都没变，只比「文字+缩放」会判定"不用重算"，
 *   于是 `--text-width` 永远停在 0 → 裁剪区宽 0 → **整行填色完全不可见**。
 *   把可用宽度纳入签名，宽度一变就自动补算。
 */
const geometrySignature = new WeakMap();

/** 副行最近一次应用的缩放签名（含可用宽度，理由同 geometrySignature）。 */
let lastSecondarySignature = '';

/**
 * 把一行文字的双层填色几何写进它自己的 wrapper。
 *
 * ★ 复刻 WordFill.qml:24-25：
 *     textPaintedWidth = min(可用宽度, 文字实际宽度)
 *     textLeft         = max(0, (可用宽度 - textPaintedWidth) / 2)
 *   裁剪从**文字左边缘**开始，切掉的是"已经唱过的部分"，
 *   而不是从行左边缘开始（后者对短句明显错位）。
 *
 * ★ 变量必须写在**各自 wrapper** 上，不能统一写到 .lyrics-shell：
 *   旧行与主行文字不同宽，共用会让旧行的裁剪区按主行的宽度算、整个错位。
 *
 * @returns {boolean} 是否真的重新量了（量不到宽度时返回 false，下次再试）
 */
const applyLineGeometry = (wrap, baseElement, activeElement, availableWidth, scale, text) => {
  if (!wrap || availableWidth <= 0) return false;
  const signature = `${text}|${scale}|${Math.round(availableWidth)}`;
  if (geometrySignature.get(wrap) === signature) return true;

  // ★★ 顺序不能反：**先写字号，再量文字宽度**。
  //
  // 踩过的坑（真机截图：填色断在半路 + 文字重影）：
  // 原来先 `measureLineWidth()` 再 `setProperty('--line-font-scale')`，
  // 量到的是**上一个字号**下的宽度。实测 --text-width 停在 160px
  // （旧字号 20px 时的宽度），而新字号 35px 下真实需要 281.5px →
  //   ① 裁剪区宽度 = 160 × 进度，只覆盖文字左半边，粉色断在半路；
  //   ② textLeft = (292-160)/2 = 66px，比真实的 5.25px 偏了 60px，
  //      裁剪区整体右移，与底层文字错开 → 看起来像重影。
  //
  // measureLineWidth 内部用 Range.getBoundingClientRect，它会**强制同步布局**，
  // 所以紧接着读就能拿到新字号下的真实宽度，不需要 rAF 等一帧（等一帧会闪）。
  wrap.style.setProperty('--line-font-scale', String(scale));

  // ★★ canvas 估算的 scale 不够，必须用 **DOM 实测**再收敛。
  //
  // 踩过的坑（用户截图：白字与粉字叠在一起、边缘错位）：
  // canvas 只算字形 advance，与 DOM 真实排版差 1~2%（描边外扩、字距取整）。
  // 实测「答应我的家」：canvas 认为行宽 148px 放得下（scale≈0.957），
  // 但 DOM 实际要 **172.2px** —— 比行宽多 24px。
  // 文字溢出后被 `overflow:hidden` 从右边硬切，两层裁切基准不同，
  // 于是白字（底层）与粉字（上层）错开、叠成双影。
  //
  // 这里按 DOM 实测比例再压（最多 3 轮，每轮强制同步布局，不可能死循环）。
  let finalScale = scale;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const measured = measureLineWidth(baseElement);
    if (!measured || measured <= availableWidth + 0.5) break;
    finalScale *= availableWidth / measured;
    wrap.style.setProperty('--line-font-scale', String(finalScale));
  }

  // 裁剪宽度取「文字实际宽度」但上限是行内可用宽（QML WordFill :24 的
  // `min(width, baseLabel.paintedWidth)`）。
  const painted = Math.min(availableWidth, measureLineWidth(baseElement));
  // textLeft 相对**行左边**居中（QML :25）。裁剪区从这里开始，不是从行左边缘。
  const textLeft = Math.max(0, (availableWidth - painted) / 2);
  // ★ --line-width 必须是**整行宽度**（上层文字按整行居中排版，再靠负 margin
  //   抵消裁剪区偏移）。若写成文字宽度，短句的上层会被压窄再居中 → 与底层错位。
  const rowWidth = Math.max(availableWidth, wrap.clientWidth || 0);

  wrap.style.setProperty('--text-left', `${textLeft}px`);
  wrap.style.setProperty('--text-width', `${painted}px`);
  wrap.style.setProperty('--line-width', `${rowWidth}px`);
  geometrySignature.set(wrap, signature);
  return true;
};

/**
 * 每帧核对已渲染两行的几何（文字/缩放/行宽任一变化才真正重算）。
 *
 * 抽成独立函数是为了让 render() 每帧调用而不必关心细节；
 * 内部由 applyLineGeometry 的签名去重兜底，稳定态下只有几次字符串比较。
 */
const refreshRenderedGeometry = () => {
  const baseSize = clampFontSize(settings.font_size);

  const mainAvailable = Math.max(0, currentWrap.clientWidth || 0);
  if (mainAvailable > 0) {
    const mainScale = fitScale(renderedActiveText, baseSize, mainAvailable);
    applyLineGeometry(
      currentWrap, currentBase, currentLine, mainAvailable, mainScale, renderedActiveText,
    );
  }

  const secondaryBase = secondaryFontSizeFor(settings.font_size);
  const secondaryAvailable = Math.max(0, nextLine.clientWidth || 0);
  if (secondaryAvailable > 0) {
    const secondarySignature = `${renderedNextText}|${secondaryBase}|${Math.round(secondaryAvailable)}`;
    if (lastSecondarySignature !== secondarySignature) {
      lastSecondarySignature = secondarySignature;
      let secondaryScale = fitScale(
        renderedNextText, secondaryBase, secondaryAvailable, secondaryMinimumPixelSize(), 400,
      );
      lyricsShell.style.setProperty('--secondary-font-scale', String(secondaryScale));
      // ★ 副行同样要按 DOM 实测收敛（理由见 applyLineGeometry 里的长注释）：
      //   只靠 canvas 估算，长副行会溢出容器被右边硬切。
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const measured = measureLineWidth(nextLine);
        if (!measured || measured <= secondaryAvailable + 0.5) break;
        secondaryScale *= secondaryAvailable / measured;
        lyricsShell.style.setProperty('--secondary-font-scale', String(secondaryScale));
      }
    }
  }
};

// ---------- 窗口宽度：**固定**，不随内容变化 ----------
//
// ★★ 为什么不再"贴合内容"（用户实测：「歌词一直在往右移动，得固定中心点
//    往两边扩散」）：
//   之前窗口宽度跟着每行文字算，短句窗口缩、长句窗口撑。CDP 实测连续三行：
//     「眉目缱绻中 飘零」 窗口 360 → 文字中心 x=180
//     「心之 所寄」       窗口 252 → 文字中心 x=126
//     「劫数应声而起」     窗口 312 → 文字中心 x=156
//   文字中心**始终等于窗口中心**（偏离 0），但窗口宽度变了 ——
//   于是整块歌词在屏幕上左右横移了 54px，看起来就是"一直往右移"。
//
//   窗口是独立原生的透明窗口，它的位置由壳侧固定；只有**宽度固定**，
//   文字才能真的钉在屏幕同一处。旧版 PrismQML 也是固定宽度
//   （`min(920, max(640, 屏宽-96))`），"贴合内容"是本鱼自己加的。
//
//   副作用（可接受）：透明区域会拦截鼠标。缓解办法是**默认锁定/穿透**，
//   需要操作时再解锁 —— 这正是旧版的行为。
//
// 所以这里不再按内容请求宽度；宽度只在字号变化时由壳侧按屏幕重算。

/** 最近一次应用的字号，用来判断要不要让壳侧重算窗口几何。 */
let lastGeometryFontSize = 0;

/**
 * 字号变化时让壳侧按屏幕重算窗口尺寸（宽度固定为屏宽推导值，高度按字号）。
 *
 * 不再传 contentWidth —— 窗口宽度与歌词内容无关了。
 */
const syncWindowGeometry = () => {
  const fontSize = clampFontSize(settings.font_size);
  if (fontSize === lastGeometryFontSize) return;
  lastGeometryFontSize = fontSize;
  invoke('lyrics_resize_to_content', {
    // 传 0 让壳侧走"按屏幕重算宽度"的分支（而不是按内容夹取）。
    contentWidth: 0,
    fontSize,
  }).catch((error) => {
    console.warn('同步歌词窗口尺寸失败', error);
  });
};

// ---------- 行切换动画 ----------
//
// 复刻旧实现 DesktopLyricsWindow.qml:482-491：
// 旧版用 NumberAnimation 把 lyricTransitionProgress 从 0 推到 1，
// duration = Fluent.Enums.duration.slower = **300ms**，easing = InOutCubic，
// 然后由 QML 绑定把同一个 progress 映射到三个元素上：
//
//   旧行：y -= 行高*0.45*exit，opacity = 1-exit，  exit = min(1, p/0.78)
//   新行：y 从副行位置插值到主行位置，scale = incomingScale → 1，opacity 0.96→1
//   副行：y 从下方 35% 行高浮起，opacity = 0.92*entry，entry = max(0,(p-0.3)/0.7)
//
// 三个元素**共用同一个 progress**，所以是连续一体的过渡，不是各自独立淡入。
const TRANSITION_EASE = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

let transitionFrame = 0;

/** 把 progress(0..1) 写进 CSS 变量，三个元素一起动。 */
const applyTransitionProgress = (progress) => {
  document.documentElement.style.setProperty('--transition-progress', String(progress));
};

/** 结束过渡：progress=1，清掉旧行文本（旧行只在过渡期可见）。 */
const finishTransition = () => {
  if (transitionFrame) {
    window.cancelAnimationFrame(transitionFrame);
    transitionFrame = 0;
  }
  applyTransitionProgress(1);
  outgoingActiveText = '';
  outgoingBase.textContent = '';
  outgoingActive.textContent = '';
  outgoingWrap.style.visibility = 'hidden';
};

/**
 * 启动一次换行动画。
 *
 * @param {string} previousText 上一行的文字（作为上移淡出的"旧行"）
 */
const startLineTransition = (previousText) => {
  if (transitionFrame) {
    window.cancelAnimationFrame(transitionFrame);
    transitionFrame = 0;
  }

  // 旧行内容与位置在动画期间可见（QML :371-400 的 outgoingLyric）。
  if (previousText) {
    outgoingActiveText = previousText;
    outgoingBase.textContent = previousText;
    outgoingActive.textContent = previousText;
    // 旧行的 progress 恒为 1（QML :387）→ 整行用已播放色。
    outgoingWrap.style.setProperty('--fill-ratio', '1');
    outgoingWrap.style.visibility = 'visible';
    // 旧行有自己的文字宽度，必须按它自己的文字量一遍（不能沿用主行的）。
    const baseSize = clampFontSize(settings.font_size);
    const available = Math.max(0, outgoingWrap.clientWidth || 0);
    if (available > 0) {
      const scale = fitScale(previousText, baseSize, available);
      applyLineGeometry(outgoingWrap, outgoingBase, outgoingActive, available, scale, previousText);
    }
  } else {
    outgoingActiveText = '';
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

/**
 * 是否应该播放「向前推进」的切行动画 —— 复刻 QML `canAnimateForward`（:129-148）。
 *
 * 两个分支：
 *   ① 新行正好是上一行的下一行 → 动画；
 *   ② 中间跳过若干行，但它们**与上一行时间戳完全相同**（同一 LRC 分组，
 *      合唱/原词+翻译常同戳）→ 也算向前，动画。
 *      否则表现为「同一句的第二行突然跳出来」。
 */
const canAnimateForward = (previousIndex, previousText, nextIndex, nextText) => {
  if (previousIndex < 0 || previousText.length === 0 || nextText.length === 0) return false;
  if (nextIndex === previousIndex + 1) return true;
  const lines = Array.isArray(playback.lyrics) ? playback.lyrics : [];
  if (nextIndex <= previousIndex + 1 || previousIndex >= lines.length) return false;

  const previousTimestamp = Number(lines[previousIndex]?.t);
  for (let index = previousIndex + 1; index < nextIndex; index += 1) {
    if (Number(lines[index]?.t) !== previousTimestamp) return false;
  }
  return true;
};

/**
 * 同步「已渲染」状态到新的一行 —— 复刻 QML `syncRenderedLyrics`（:150-171）。
 *
 * @param {boolean} animateForward 是否允许播放向前推进的动画
 */
const syncRenderedLyrics = (animateForward) => {
  const frame = currentFrame();
  const nextIndex = frame ? frame.index : -1;
  const mainText = currentDisplayText(frame);
  const secondaryText = nextDisplayText(frame);

  const previousIndex = renderedLineIndex;
  const previousText = renderedActiveText;
  const shouldAnimate = animateForward
    && canAnimateForward(previousIndex, previousText, nextIndex, mainText);

  renderedLineIndex = nextIndex;
  renderedActiveText = mainText;
  renderedNextText = secondaryText;

  renderCurrentLine(mainText);
  renderSecondaryLine(secondaryText);

  if (shouldAnimate) {
    startLineTransition(previousText);
  } else {
    finishTransition();
  }
};

/**
 * 写主行的**文字**（底层 + 上层两层同步写）。
 *
 * 几何（字号缩放、裁剪区定位）不在这里做 —— 由 refreshRenderedGeometry
 * 在 render() 每帧核对，因为窗口宽度是异步变化的，只在这里算一次会停在旧值。
 *
 * 也不碰进度：进度由 updateFillProgress 每帧单独更新。
 * 曾经把「换行/换字」与「唱到哪了」混在一个函数里，render() 传进来的 `line`
 * 是个只有 text 的残缺对象，lineProgress 读不到 t/end/words → 进度恒为 1 →
 * 「整行一次性亮、逐字填色完全看不出来」。现在结构上就分开了。
 *
 * @param {string} text 要显示的文字（无歌词时是歌曲名）
 */
const renderCurrentLine = (text) => {
  const value = text || '';
  if (currentBase.textContent !== value) {
    currentBase.textContent = value;
    currentLine.textContent = value;
  }
};

/** 只更新主行的填色进度（每帧都跑，必须廉价：只写一个 CSS 变量）。 */
const updateFillProgress = (line, position) => {
  const ratio = line ? coreLineProgress(line, position) : 0;
  currentWrap.style.setProperty('--fill-ratio', String(ratio));
};

/**
 * 副行：只负责写文字，字号适配由 refreshRenderedGeometry 每帧核对。
 *
 * 分成两步是因为窗口宽度会异步变化：只在换行时算缩放，
 * 窗口后来变宽/变窄都不会重算（实测副行会停在旧字号上）。
 */
const renderSecondaryLine = (text) => {
  const value = text || '';
  if (nextLine.textContent !== value) nextLine.textContent = value;
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
 * 当前该显示的歌词帧。没有歌词时不返回帧（进度按 0 处理）。
 *
 * 与 QML 的区别：旧版 `Player.visualLyricIndex` 在无歌词时返回 -1，
 * 这里同样返回 null，由调用方决定回退到歌曲名/歌手名。
 */
const currentFrame = () => {
  if (!hasLyrics()) return null;
  return lyricFrame(playback.lyrics, effectivePosition());
};

/**
 * 主行/副行该显示什么。
 *
 * ★ 逐字复刻旧实现 DesktopLyricsWindow.qml:20-25：
 *   activeText: activeLine ? activeLine.text : (Player.currentSong.name || "")
 *   nextText:   nextLine   ? nextLine.text   : (Player.currentSong.artist || "")
 *
 * 注意两个回退**都是无条件的**，不要额外加「有歌词才回退」之类的分支：
 *   · 还没有任何歌词（frame 为 null）→ 主行歌曲名、副行歌手名；
 *   · 有歌词但还没唱到第一行（activeLine 为 null）→ 主行同样是歌曲名；
 *   · 唱到最后一行（nextLine 为 null，副行索引 -1）→ 副行回退到歌手名。
 *   本鱼曾给第 3 种情况单独返回空字符串，副行就整条空掉 ——
 *   与旧版观感不一致，且由 desktopLyrics.runtime.test.mjs 当场抓出。
 */
const currentDisplayText = (frame) => (
  frame?.current ? (frame.current.text || '') : (playback.track?.name || '')
);

const nextDisplayText = (frame) => (
  frame?.next ? (frame.next.text || '') : (playback.track?.artist || '')
);

const render = () => {
  // ★ 可见性 = 用户开关 **且** 有歌可显示 —— 复刻旧实现 `desktop_state.py:40-48`：
  //     should_show = settings.lyricsVisible and bool(current_song.get("id"))
  //
  // 踩过的坑：曾经只看 settings.visible，于是「没在放歌」时窗口仍然显示，
  // 但它是一片全透明、还默认不穿透的置顶矩形 —— 实测会实打实挡住下面的窗口，
  // 用户点不到被它盖住的地方，而且屏幕上什么都看不见，无从判断是什么在挡。
  //
  // 注意判据是 playback.track（收到过歌曲信息就一直有），
  // **不是** hasState/hasLyrics：暂停时 track 仍在，窗口不该消失；
  // 纯音乐没有 LRC 时旧版显示歌曲名/歌手名，也不该消失。
  setOverlayVisible(Boolean(settings.visible && playback.track));

  // 没有歌曲信息时才彻底清空（此时本来就没东西可显示）。
  if (!playback.track) {
    if (currentBase.textContent !== '') {
      currentBase.textContent = '';
      currentLine.textContent = '';
    }
    nextLine.textContent = '';
    renderedLineIndex = -2;
    renderedActiveText = '';
    renderedNextText = '';
    finishTransition();
    return;
  }

  const frame = currentFrame();
  const nextIndex = frame ? frame.index : -1;
  const mainText = currentDisplayText(frame);
  const secondaryText = nextDisplayText(frame);

  // 行索引变了 → 尝试向前动画；只是文字变了（同一行被刷新）→ 直接换，不动画。
  if (nextIndex !== renderedLineIndex) {
    syncRenderedLyrics(true);
  } else if (mainText !== renderedActiveText || secondaryText !== renderedNextText) {
    syncRenderedLyrics(false);
  }

  // ★ 每帧都重新核对几何 —— 但不能每帧都做 DOM 测量。
  //
  // 为什么必须每帧（真机实测踩到）：窗口宽度是**异步**经 IPC 变的
  // （requestContentWidth → 壳侧改窗口 → 下一次布局才反映到 clientWidth）。
  // 只在换行时算一次的话，`--line-width` 会永远停在"窗口还没变宽"那一刻的值
  // （实测停在 164px，而实际行宽已是 292px）→ 上层文字被压缩并居中偏移
  // → 裁剪区与底层文字错位、歌词看着像重影。
  //
  // 成本可控：applyLineGeometry 内部按 (文字|缩放|可用宽) 去重，
  // 三者都没变时只做一次字符串比较，不碰 DOM。
  refreshRenderedGeometry();

  // 每帧只更新填色进度：用**已渲染那一行**的行对象与当前播放位置。
  // （QML 的 activeLyric.progress 同样绑 renderedLineIndex 而不是 displayLineIndex，
  //   动画期间两者会短暂不同，用错会让填色在切行瞬间跳一下。）
  const renderedLine = renderedLineIndex >= 0
    ? playback.lyrics[renderedLineIndex] || null
    : null;
  updateFillProgress(renderedLine, effectivePosition());

  // 窗口尺寸只在字号变化时同步（宽度固定，不随歌词内容变）。
  syncWindowGeometry();

  // 播放/暂停图标二选一由 class 控制（旧实现 icon 随 Player.playing 切换）。
  toggleButton.classList.toggle('is-playing', !playback.paused);
  toggleButton.title = playback.paused ? '播放' : '暂停';
};

/**
 * 渲染主循环 —— **按显示器刷新率逐帧驱动**（rAF）。
 *
 * ★★ 为什么不再用 `setInterval(render, 80)`（用户实测：「逐字逐句播放时
 *    动画不够平滑」）：
 *   80ms 一次 = **12.5fps**。填色进度每 80ms 才前进一格，而显示器是 60/120Hz，
 *   于是肉眼看到的是一跳一跳的格子，而不是连续推进。
 *   旧版 PrismQML 用的是 `FrameAnimation`（跟着合成器帧走），不是定时器。
 *
 * 现在改成 requestAnimationFrame：浏览器按显示器刷新率回调（60Hz → 16.7ms，
 * 120Hz → 8.3ms），逐字填色每帧前进，平滑度与刷新率一致。
 *
 * 每帧成本必须极低：refreshRenderedGeometry / updateFillProgress 内部都有
 * 签名去重，稳定态只做字符串比较 + 一次 CSS 变量写入。
 */
let renderFrame = 0;
let lastRenderAt = 0;

/** 两次 DOM 写入的最小间隔（ms）：节流到 ~60fps，避免高刷屏空转。 */
const MIN_RENDER_INTERVAL_MS = 1000 / 60;

const renderLoop = (now) => {
  renderFrame = window.requestAnimationFrame(renderLoop);
  if (now - lastRenderAt < MIN_RENDER_INTERVAL_MS) return;
  lastRenderAt = now;
  render();
};

const startRenderLoop = () => {
  if (renderFrame) return;
  renderFrame = window.requestAnimationFrame(renderLoop);
};

const applyStateMessage = (message) => {
  if (!message || (message.type !== 'track' && message.type !== 'progress')) return;

  if (message.type === 'track') {
    const nextTrack = message.track || null;
    const previousKey = trackKey(playback.track);
    const nextKey = trackKey(nextTrack);
    playback.track = nextTrack;
    playback.lyrics = Array.isArray(message.lyrics) ? message.lyrics : [];

    // ★ 切歌必须把「已渲染行」状态整体重置（用户实测：会看到上一首的歌词）。
    //
    // 踩过的坑：这里原先只换 track/lyrics，`renderedLineIndex` 与
    // `renderedActiveText` 仍是上一首的（比如上一首唱到第 50 行）。
    // 新歌第一句的 index 是 0，而 syncRenderedLyrics 拿 previousIndex=50 去判
    // canAnimateForward，同时把上一首的歌词文字当成"旧行"传给
    // startLineTransition —— 于是屏幕上真的画出上一首那句歌词，
    // 在 outgoing 层停留到动画结束。
    //
    // 判据用 trackKey（source+id）：同一首歌重复推送（歌词晚到、seek）不该重置，
    // 否则每次进度包都会清掉当前行、画面闪一下。
    if (previousKey !== nextKey) {
      renderedLineIndex = -2;
      renderedActiveText = '';
      renderedNextText = '';
      outgoingActiveText = '';
      geometrySignature.delete(currentWrap);
      lastSecondarySignature = '';
      finishTransition();
    }
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

// 渲染主循环：按显示器刷新率逐帧驱动（详见 renderLoop 的注释）。
startRenderLoop();

// 启动时先隐藏，等主窗口推来第一条状态。
setOverlayVisible(false);

// 初始 progress=1：静止状态下新行就在主行位置、副行完全可见。
// 若不初始化，CSS 里 --transition-progress 缺失会让首帧显示成"正在动画"的缩小态。
applyTransitionProgress(1);
outgoingWrap.style.visibility = 'hidden';
// 旧行 progress 恒为 1（QML :387）：不初始化的话它会继承主行的动态进度。
outgoingWrap.style.setProperty('--fill-ratio', '1');
