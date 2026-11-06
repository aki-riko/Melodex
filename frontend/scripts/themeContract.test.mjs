import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DARK_MEDIA_QUERY,
  DEFAULT_MODE,
  MODE_DESCRIPTIONS,
  REQUIRED_THEME_TOKENS,
  RESOLVED_THEME_IDS,
  THEME_DESCRIPTIONS,
  THEME_MODES,
  THEME_STORAGE_KEY,
  applyThemeToDocument,
  getTheme,
  normalizeThemeMode,
  readStoredThemeMode,
  resolveThemeId,
  writeStoredThemeMode,
} from '../src/theme/themes.js';

// 主题契约测试。
//
// 为什么需要:主题是"加一个 CSS 变量块 + 一条注册表记录"就能生效的机制,正向零成本,
// 但反过来的失效全是**静默**的 —— 少写一个 token,组件那一处就悄悄退回继承值
// (常见表现:文字与背景同色、圆角算不出来、浮层完全不透明),构建不报错、界面只是"看着怪"。
//
// 改造后(2026-11)多了一层:用户选的是**模式**,生效的是**解析后的 id**。
// 于是"三处必须一致"变成"四处必须一致":
//   1. themes.js 的 THEME_MODES / RESOLVED_THEME_IDS / resolveThemeId
//   2. index.css 的变量块(fluent-light / fluent-dark)
//   3. index.html 首帧脚本(它必须用同一套解析规则,否则首帧闪一下再跳变)
//   4. MODE_DESCRIPTIONS 必须覆盖全部模式(设置页不能漏一个,否则那个模式选不了)
//
// 运行: node scripts/themeContract.test.mjs   (npm run test:theme)

const scriptDir = dirname(fileURLToPath(import.meta.url));
const frontendRoot = resolve(scriptDir, '..');

const failures = [];
const check = (ok, message) => {
  if (!ok) failures.push(message);
};

// ---------- 工具 ----------

function extractBlock(css, selector) {
  const needle = `${selector} {`;
  const start = css.indexOf(needle);
  if (start < 0) return null;
  let i = start + needle.length - 1;
  let depth = 0;
  for (; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    else if (css[i] === '}') {
      depth -= 1;
      if (depth === 0) return css.slice(start + needle.length, i);
    }
  }
  return null;
}

function collectVars(block) {
  const vars = new Map();
  const re = /(--[a-z0-9-]+)\s*:\s*([^;]+);/gi;
  let m;
  while ((m = re.exec(block)) !== null) {
    vars.set(m[1].slice(2).trim(), m[2].trim());
  }
  return vars;
}

function hslToRgb(hslText) {
  const m = hslText.match(/^([\d.]+)\s+([\d.]+)%\s+([\d.]+)%$/);
  if (!m) return null;
  const h = Number(m[1]) / 360;
  const s = Number(m[2]) / 100;
  const l = Number(m[3]) / 100;
  const hue2rgb = (p, q, t) => {
    let tt = t;
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };
  let r;
  let g;
  let b;
  if (s === 0) {
    r = l; g = l; b = l;
  } else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1 / 3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1 / 3);
  }
  const to255 = (v) => Math.round(Math.max(0, Math.min(1, v)) * 255);
  return [to255(r), to255(g), to255(b)];
}

function hexToRgb(hex) {
  const m = hex.replace('#', '').match(/^([0-9a-f]{6})$/i);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// ---------- 1. 注册表自身 ----------

check(THEME_MODES.length === 3, `应当有 3 个模式(system/light/dark),实际 ${THEME_MODES.length}`);
check(THEME_MODES.includes(DEFAULT_MODE), `默认模式 ${DEFAULT_MODE} 不在 THEME_MODES 里`);
check(DEFAULT_MODE === 'system', '默认模式应当是 system(跟随系统)—— 音乐 App 夜间用得多');
check(new Set(THEME_MODES).size === THEME_MODES.length, '模式有重复');

// 每种模式都必须有描述,否则设置页少一个选项、用户选不到。
for (const mode of THEME_MODES) {
  const desc = MODE_DESCRIPTIONS.find((d) => d.id === mode);
  check(Boolean(desc), `模式 ${mode} 缺少 MODE_DESCRIPTIONS 条目(设置页会漏掉这个选项)`);
  if (desc) {
    check(typeof desc.name === 'string' && desc.name.length > 0, `模式 ${mode} 缺中文名`);
    check(typeof desc.tagline === 'string' && desc.tagline.length > 0, `模式 ${mode} 缺说明文案`);
  }
}

// 解析结果必须是两个,且都能在 descriptions 里查到
check(RESOLVED_THEME_IDS.length === 2, '解析后的主题应当恰好两个(light / dark)');
for (const id of RESOLVED_THEME_IDS) {
  check(/^[a-z][a-z0-9-]*$/.test(id), `主题 id 必须是小写 kebab-case: ${id}`);
  const desc = THEME_DESCRIPTIONS[id];
  check(Boolean(desc), `主题 ${id} 缺少 THEME_DESCRIPTIONS 条目`);
  if (desc) {
    check(typeof desc.name === 'string' && desc.name.length > 0, `主题 ${id} 缺中文名`);
    check(/^#[0-9a-f]{6}$/i.test(desc.metaColor || ''), `主题 ${id} 的 metaColor 必须是 6 位 hex`);
  }
}

// ---------- 2. index.css 必须为每个解析结果提供完整变量块 ----------

const css = readFileSync(resolve(frontendRoot, 'src', 'index.css'), 'utf8');

for (const id of RESOLVED_THEME_IDS) {
  // fluent-light 同时挂在 :root 上(默认),所以两处都要能查到。
  const selectors = id === 'fluent-light'
    ? [`:root`, `[data-theme="${id}"]`]
    : [`[data-theme="${id}"]`];

  let block = null;
  for (const selector of selectors) {
    const found = extractBlock(css, selector);
    if (found) { block = found; break; }
  }
  if (!block) {
    failures.push(`index.css 缺少主题 ${id} 的变量块(${selectors.join(' 或 ')})`);
    continue;
  }

  const vars = collectVars(block);
  const missing = REQUIRED_THEME_TOKENS.filter((token) => !vars.has(token));
  if (missing.length > 0) {
    failures.push(
      `主题 ${id} 缺 ${missing.length} 个 token:${missing.join(', ')} —— ` +
      '少一个都会静默退回继承值(典型表现:文字与背景同色、圆角算不出来、浮层不透明)',
    );
  }

  // meta theme-color 必须与该主题的背景色一致,否则移动端状态栏会出现异色带
  const bg = vars.get('background');
  const desc = THEME_DESCRIPTIONS[id];
  if (bg && desc) {
    const fromCss = hslToRgb(bg.replace(/\s+/g, ' ').trim());
    const fromMeta = hexToRgb(desc.metaColor);
    if (!fromCss) {
      failures.push(`主题 ${id} 的 --background 不是 \`h s% l%\` 形式:${bg}`);
    } else if (fromMeta) {
      const delta = Math.max(...fromCss.map((v, i) => Math.abs(v - fromMeta[i])));
      if (delta > 2) {
        failures.push(
          `主题 ${id} 的 metaColor ${desc.metaColor} 与 --background(≈rgb(${fromCss.join(', ')}))不一致 ` +
          '—— 移动端状态栏会与页面底色断层',
        );
      }
    }
  }
}

// 反过来:css 里出现的 data-theme 块,必须是注册表认识的(防止留下死代码)
const themeBlocks = [...css.matchAll(/\[data-theme="([a-z0-9-]+)"\]/g)].map((m) => m[1]);
for (const id of new Set(themeBlocks)) {
  check(
    RESOLVED_THEME_IDS.includes(id),
    `index.css 里的 [data-theme="${id}"] 不在 RESOLVED_THEME_IDS 里 —— 这个主题永远无法生效(死代码)`,
  );
}

// 旧的皮肤 id 不得再出现在 CSS 选择器里(彻底移除 Spotify)
check(
  !/\[data-theme="(spotify|fluent)"\]/.test(css),
  'index.css 里不应再有 [data-theme="spotify"] / [data-theme="fluent"] 这类旧皮肤选择器',
);

// ---------- 3. index.html 首帧脚本必须与注册表用同一套规则 ----------

const html = readFileSync(resolve(frontendRoot, 'index.html'), 'utf8');

check(
  html.includes(THEME_STORAGE_KEY),
  `index.html 首帧脚本必须读 localStorage 的 ${THEME_STORAGE_KEY}(否则选择不会跨刷新保留)`,
);
check(
  html.includes(DARK_MEDIA_QUERY),
  `index.html 首帧脚本必须用同一个媒体查询 ${DARK_MEDIA_QUERY} —— 与 themes.js 不一致会首帧闪一下再跳变`,
);
check(
  html.includes("'fluent-light'") && html.includes("'fluent-dark'"),
  'index.html 首帧脚本必须能解析出 fluent-light / fluent-dark 两个 id',
);
check(
  /var\s+DEFAULT_MODE\s*=\s*['"]system['"]/.test(html),
  'index.html 首帧脚本的 DEFAULT_MODE 必须是 system(与注册表一致)',
);
// 首帧脚本必须遍历三个模式值,否则手动选的模式在首帧不生效
for (const mode of THEME_MODES) {
  check(
    html.includes(`'${mode}'`) || html.includes(`"${mode}"`),
    `index.html 首帧脚本没有处理模式 ${mode} —— 选了这个模式的用户开页会闪一下`,
  );
}

// ---------- 4. 运行时行为契约 ----------

check(resolveThemeId('light', false) === 'fluent-light', 'light 模式应解析为 fluent-light');
check(resolveThemeId('light', true) === 'fluent-light', 'light 模式不应受系统偏好影响');
check(resolveThemeId('dark', false) === 'fluent-dark', 'dark 模式应解析为 fluent-dark');
check(resolveThemeId('dark', true) === 'fluent-dark', 'dark 模式不应受系统偏好影响');
check(resolveThemeId('system', true) === 'fluent-dark', 'system + 系统深色 → fluent-dark');
check(resolveThemeId('system', false) === 'fluent-light', 'system + 系统浅色 → fluent-light');

check(normalizeThemeMode('LIGHT ') === 'light', 'normalizeThemeMode 应当大小写/空白不敏感');
check(normalizeThemeMode('nope') === DEFAULT_MODE, '未知模式必须收敛到默认值');
check(normalizeThemeMode(null) === DEFAULT_MODE, 'null 必须收敛到默认值');
check(normalizeThemeMode(42) === DEFAULT_MODE, '非字符串必须收敛到默认值');

// 旧值兼容:改造前存的是皮肤 id,必须映射到明暗预期而不是被当成未知
check(normalizeThemeMode('fluent') === 'light', '旧值 fluent 应映射为 light');
check(normalizeThemeMode('fluent-light') === 'light', '旧值 fluent-light 应映射为 light');
check(normalizeThemeMode('fluent-dark') === 'dark', '旧值 fluent-dark 应映射为 dark');
check(
  normalizeThemeMode('spotify') === 'dark',
  '旧值 spotify 应映射为 dark —— 原默认皮肤是暗色,不该让老用户突然变白',
);

// getTheme 不能返回 undefined
check(getTheme('nope').id === 'fluent-light', 'getTheme 对未知 id 必须回默认而不是 undefined');
check(getTheme('fluent-dark').id === 'fluent-dark', 'getTheme 取不到合法主题');

// Storage 异常都不能抛错、不能阻断启动
const memoryStorage = (initial) => {
  const map = new Map(initial ? [[THEME_STORAGE_KEY, initial]] : []);
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, v); },
    _map: map,
  };
};
check(readStoredThemeMode(memoryStorage('dark')) === 'dark', 'readStoredThemeMode 读不出已保存的模式');
check(readStoredThemeMode(memoryStorage('garbage')) === DEFAULT_MODE, '读到非法值时必须回默认模式');
check(readStoredThemeMode(null) === DEFAULT_MODE, 'storage 不存在时必须回默认模式');
check(
  readStoredThemeMode({ getItem() { throw new Error('SecurityError'); } }) === DEFAULT_MODE,
  'storage.getItem 抛错时必须回默认模式(无痕模式不能崩)',
);
check(
  writeStoredThemeMode({ setItem() { throw new Error('QuotaExceeded'); } }, 'dark') === 'dark',
  'storage.setItem 抛错时仍应返回本次生效的模式',
);

// applyThemeToDocument:只动 data-theme 与 meta,不写内联样式
const fakeMeta = { attrs: {}, setAttribute(name, value) { this.attrs[name] = value; } };
const fakeDoc = {
  documentElement: { attrs: {}, setAttribute(name, value) { this.attrs[name] = value; } },
  querySelector: (sel) => (sel === 'meta[name="theme-color"]' ? fakeMeta : null),
};
check(
  applyThemeToDocument(fakeDoc, 'fluent-dark') === 'fluent-dark',
  'applyThemeToDocument 应返回生效的主题 id',
);
check(fakeDoc.documentElement.attrs['data-theme'] === 'fluent-dark', 'applyThemeToDocument 没写 data-theme');
check(
  fakeMeta.attrs.content === getTheme('fluent-dark').metaColor,
  'applyThemeToDocument 没同步 <meta theme-color>(移动端状态栏会停在旧颜色)',
);
check(
  applyThemeToDocument(fakeDoc, 'unknown-id') === 'fluent-light',
  'applyThemeToDocument 遇到未知 id 应回默认而不是写入非法属性',
);

// ---------- 结果 ----------

if (failures.length > 0) {
  console.error(`主题契约未通过,共 ${failures.length} 项:\n`);
  console.error(failures.map((f) => `  · ${f}`).join('\n'));
  process.exitCode = 1;
} else {
  console.log(
    `主题契约通过:${THEME_MODES.length} 个模式(${THEME_MODES.join(' / ')}) → ` +
    `${RESOLVED_THEME_IDS.length} 个主题(${RESOLVED_THEME_IDS.join(' / ')}),` +
    `每块 ${REQUIRED_THEME_TOKENS.length} 个 token 齐全,index.html 首帧脚本与注册表一致。`,
  );
}
