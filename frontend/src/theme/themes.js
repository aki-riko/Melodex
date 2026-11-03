// 主题注册表 —— 纯数据 + 纯函数,不含 React / 不碰 DOM,便于 Node 契约测试直接 import。
//
// 为什么要有这个文件:
//   界面此前只有一套写死的皮肤(--background / --primary 等直接是 Spotify 的色值),
//   想换观感就必须改 index.css 的 :root,等于全站返工。现在把「皮肤」抽成注册表:
//   每个 id 对应 index.css 里一个 [data-theme="<id>"] 变量块,组件只读 token,不认识主题名。
//
// 契约(frontend/scripts/themeContract.test.mjs 强制):
//   1. DEFAULT_THEME_ID 必须在 THEMES 里;
//   2. 每个主题 id 在 index.css 里必须有对应变量块(默认主题是 :root);
//   3. 每个块必须定义 REQUIRED_THEME_TOKENS 里的**全部** token,且不得定义未知 token
//      (未知 = 拼写错误,它不会报错,只会静默不生效)。
//
// 注意:本文件属于设计系统层(与 src/ui/ 同级),因此允许出现裸色值(用于 <meta theme-color>
// 这类必须给字面量颜色的位置);uxGuards 的 no-raw-hex 规则据此豁免 theme/ 目录。
// 视觉预览色块不在这里写色值 —— 那是 CSS 的事(.theme-swatch--* 定义在 index.css),
// 这样才能保证"预览看到的配色"与"选中后真正生效的配色"永远来自同一处。

export const THEME_STORAGE_KEY = 'melodex_theme';

export const DEFAULT_THEME_ID = 'spotify';

/**
 * 每个主题必须定义的 CSS 变量(不含 `--` 前缀)。
 * 新增主题 = 在 index.css 里补齐这张表,少一个都会被契约测试拦下。
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
];

/**
 * 主题清单。顺序即设置页里的展示顺序。
 * - id            : 与 index.css 的 [data-theme="<id>"] 一一对应
 * - name/tagline  : 设置页文案(全中文)
 * - swatchClass   : 预览色块类名,色值只在 index.css 里定义
 * - metaColor     : <meta name="theme-color"> 的字面量颜色(移动端地址栏/状态栏底色),
 *                   必须与 index.css 里该主题的 --background 是同一个颜色
 */
export const THEMES = [
  {
    id: 'spotify',
    name: '暗夜绿',
    tagline: '近黑底 + Spotify 绿，圆胶囊控件。原版观感。',
    swatchClass: 'theme-swatch--spotify',
    metaColor: '#181818',
  },
  {
    id: 'fluent',
    name: 'Fluent 亚克力',
    tagline: '分层半透明表面 + 4px 小圆角控件，Windows 11 风格。',
    swatchClass: 'theme-swatch--fluent',
    metaColor: '#202020',
  },
];

export const THEME_IDS = THEMES.map((theme) => theme.id);

/** 把任意输入收敛成合法主题 id;不认识的一律回默认(绝不抛错、绝不返回空)。 */
export function normalizeThemeId(id) {
  if (typeof id !== 'string') return DEFAULT_THEME_ID;
  const value = id.trim().toLowerCase();
  return THEME_IDS.includes(value) ? value : DEFAULT_THEME_ID;
}

/** 按 id 取主题描述;找不到时给默认主题的描述(不会返回 undefined)。 */
export function getTheme(id) {
  const normalized = normalizeThemeId(id);
  return THEMES.find((theme) => theme.id === normalized) || THEMES[0];
}

/**
 * 从 Storage 读取主题 id。Storage 可能不存在(SSR/隐私模式/被策略禁用),
 * 读取也可能抛 SecurityError —— 一律回默认主题,不阻断启动。
 */
export function readStoredThemeId(storage) {
  try {
    if (!storage || typeof storage.getItem !== 'function') return DEFAULT_THEME_ID;
    return normalizeThemeId(storage.getItem(THEME_STORAGE_KEY));
  } catch {
    return DEFAULT_THEME_ID;
  }
}

/** 写入 Storage;同样不抛错(写失败只代表下次回到默认,不影响当前会话)。 */
export function writeStoredThemeId(storage, id) {
  const normalized = normalizeThemeId(id);
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
 * 把主题应用到 documentElement。只动 data-theme 与 <meta theme-color>,
 * 不写内联颜色 —— 所有色值仍由 index.css 的变量块决定。
 */
export function applyThemeToDocument(doc, id) {
  const theme = getTheme(id);
  if (!doc || !doc.documentElement) return theme.id;
  doc.documentElement.setAttribute('data-theme', theme.id);
  const meta = typeof doc.querySelector === 'function' ? doc.querySelector('meta[name="theme-color"]') : null;
  if (meta && typeof meta.setAttribute === 'function') {
    meta.setAttribute('content', theme.metaColor);
  }
  return theme.id;
}
