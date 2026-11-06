// 主题注册表 —— 纯数据 + 纯函数,不含 React / 不碰 DOM,便于 Node 契约测试直接 import。
//
// 现状(2026-11 改造):全站只有 **Fluent Design** 一套设计语言,分深浅两档。
// 此前的 Spotify 暗色皮肤已按项目要求彻底移除。
//
// 深浅色**跟随系统**(prefers-color-scheme),同时允许用户强制指定:
//   · 'system'(默认) → 跟随系统
//   · 'light'         → 强制浅色
//   · 'dark'          → 强制深色
// 三者是"模式",不是"主题 id" —— 真正的主题 id 由模式 + 系统偏好解析得出
// (见 resolveThemeId)。这样 data-theme 上永远只有 'fluent-light' / 'fluent-dark',
// index.css 只需两个变量块,组件完全不需要知道用户选了什么模式。
//
// 契约(frontend/scripts/themeContract.test.mjs 强制):
//   1. DEFAULT_MODE 必须在 THEME_MODES 里;
//   2. 每个**解析后**的主题 id 在 index.css 里必须有对应变量块;
//   3. 每个块必须定义 REQUIRED_THEME_TOKENS 里的**全部** token。

export const THEME_STORAGE_KEY = 'melodex_theme';

// 系统偏好的媒体查询。index.html 的首帧脚本用同一个字符串 ——
// 两处不一致会导致首帧闪一下再跳变。
export const DARK_MEDIA_QUERY = '(prefers-color-scheme: dark)';

/** 用户可选的模式。顺序即设置页展示顺序。 */
export const THEME_MODES = ['system', 'light', 'dark'];

export const DEFAULT_MODE = 'system';

/** 解析后的主题 id:写到 <html data-theme>,也是 index.css 变量块的选择器。 */
export const RESOLVED_THEME_IDS = ['fluent-light', 'fluent-dark'];

/** 单套主题的展示描述(设置页用)。 */
export const THEME_DESCRIPTIONS = {
  'fluent-light': {
    id: 'fluent-light',
    name: 'Fluent 浅色',
    tagline: 'Mica 白面 · Windows 11 浅色',
    metaColor: '#F3F3F3',
    swatchClass: 'theme-swatch--light',
  },
  'fluent-dark': {
    id: 'fluent-dark',
    name: 'Fluent 深色',
    tagline: 'Mica 深面 · Windows 11 深色',
    metaColor: '#212121',
    swatchClass: 'theme-swatch--dark',
  },
};

/** 模式的人话描述,设置页用。 */
export const MODE_DESCRIPTIONS = [
  { id: 'system', name: '跟随系统', tagline: '随设备深浅色自动切换' },
  { id: 'light', name: '浅色', tagline: '始终使用 Fluent 浅色' },
  { id: 'dark', name: '深色', tagline: '始终使用 Fluent 深色' },
];

/**
 * 每个主题必须定义的 CSS 变量(不含 `--` 前缀)。
 * 新增 token = 两个变量块都要补齐,少一个都会被契约测试拦下。
 */
export const REQUIRED_THEME_TOKENS = [
  // ---- 语义色 ----
  'background',
  'foreground',
  'card',
  'card-foreground',
  'popover',
  'popover-foreground',
  'primary',
  'primary-foreground',
  'secondary',
  'secondary-foreground',
  'muted',
  'muted-foreground',
  'accent',
  'accent-foreground',
  'destructive',
  'destructive-foreground',
  'destructive-text',
  'success',
  'success-foreground',
  'warning',
  'warning-foreground',
  'info',
  'info-foreground',
  'border',
  'input',
  'ring',
  // ---- 形状 ----
  'radius',
  'radius-control',
  // ---- 材质(Mica / Acrylic)----
  'material-mica',
  'material-alpha',
  'material-blur',
  'material-saturate',
  'material-veil-alpha',
  'material-rail',
  // ---- 海拔(阴影)----
  'elevation-control',
  'elevation-card',
  'elevation-flyout',
  'elevation-dialog',
  // ---- 滚动条 ----
  'scrollbar-thumb',
  'scrollbar-thumb-hover',
  // ---- 深浅色配套 ----
  'overlay',
  'switch-knob',
  'shimmer-highlight',
  'on-media',
];

/** 模式收敛:非法值一律回落默认,绝不抛错、绝不返回空。 */
export function normalizeThemeMode(mode) {
  if (typeof mode !== 'string') return DEFAULT_MODE;
  const value = mode.trim().toLowerCase();
  // 兼容改造前存下的皮肤 id:那些用户原本选的是"皮肤",现在没有皮肤概念了,
  // 但保留他们的明暗预期(原默认皮肤是暗色)。
  if (value === 'fluent' || value === 'fluent-light') return 'light';
  if (value === 'fluent-dark' || value === 'spotify') return 'dark';
  return THEME_MODES.includes(value) ? value : DEFAULT_MODE;
}

/**
 * 由「模式 + 系统是否深色」解析出真正生效的主题 id。
 * 全站唯一的解析处 —— 首帧脚本、ThemeProvider、契约测试都遵循同一套规则。
 */
export function resolveThemeId(mode, prefersDark = false) {
  const normalized = normalizeThemeMode(mode);
  if (normalized === 'light') return 'fluent-light';
  if (normalized === 'dark') return 'fluent-dark';
  return prefersDark ? 'fluent-dark' : 'fluent-light';
}

/** 按主题 id 取描述;未知 id 回落浅色(不会返回 undefined)。 */
export function getTheme(resolvedId) {
  return THEME_DESCRIPTIONS[resolvedId] || THEME_DESCRIPTIONS['fluent-light'];
}

/** 从 Storage 读取模式。Storage 不可用时回落默认,不阻断启动。 */
export function readStoredThemeMode(storage) {
  try {
    if (!storage || typeof storage.getItem !== 'function') return DEFAULT_MODE;
    return normalizeThemeMode(storage.getItem(THEME_STORAGE_KEY));
  } catch {
    return DEFAULT_MODE;
  }
}

/** 写入 Storage;写失败只代表下次回到默认,不影响当前会话。 */
export function writeStoredThemeMode(storage, mode) {
  const normalized = normalizeThemeMode(mode);
  try {
    if (storage && typeof storage.setItem === 'function') {
      storage.setItem(THEME_STORAGE_KEY, normalized);
    }
  } catch {
    // ignore-on-purpose: 无痕/禁用存储时写不进去,当前会话仍然生效
  }
  return normalized;
}

/**
 * 把主题应用到 documentElement:只动 data-theme 与 <meta theme-color>,
 * 不写内联颜色 —— 所有色值仍由 index.css 的变量块决定。
 */
export function applyThemeToDocument(doc, resolvedId) {
  const theme = getTheme(resolvedId);
  if (!doc || !doc.documentElement) return theme.id;
  doc.documentElement.setAttribute('data-theme', theme.id);
  const meta = typeof doc.querySelector === 'function' ? doc.querySelector('meta[name="theme-color"]') : null;
  if (meta && typeof meta.setAttribute === 'function') {
    meta.setAttribute('content', theme.metaColor);
  }
  return theme.id;
}
