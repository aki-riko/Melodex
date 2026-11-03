import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_THEME_ID,
  REQUIRED_THEME_TOKENS,
  THEMES,
  THEME_IDS,
  THEME_STORAGE_KEY,
  applyThemeToDocument,
  getTheme,
  normalizeThemeId,
  readStoredThemeId,
  writeStoredThemeId,
} from '../src/theme/themes.js';

// 主题契约测试。
//
// 为什么需要:主题是"新增一个 CSS 变量块 + 一条注册表记录"就能生效的机制,正向零成本,
// 但反过来的失效全是**静默**的 —— 少写一个 token,组件那一处就悄悄退回继承值(常见表现是
// 文字与背景同色、圆角算不出来、浮层完全不透明),构建不报错、界面上只是"看起来怪"。
// 所以这里把三处必须一致的地方锁死:
//   1. src/theme/themes.js 的注册表
//   2. src/index.css 的变量块(:root = 默认主题,[data-theme=x] = 其余主题)
//   3. index.html 内联的首帧脚本(它决定"打开时会不会闪一下别的皮肤")
//
// 运行: node scripts/themeContract.test.mjs   (npm run test:theme)

const scriptDir = dirname(fileURLToPath(import.meta.url));
const frontendRoot = resolve(scriptDir, '..');

const failures = [];
const check = (ok, message) => {
  if (!ok) failures.push(message);
};

// ---------- 工具:从 CSS 里取一个规则块 ----------

/** 取选择器对应的块内容(按花括号配对,支持块内含嵌套括号的值如 hsl(...))。 */
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

/** 收集块里声明的自定义属性名(不含 --)与原始值。 */
function collectVars(block) {
  const vars = new Map();
  const re = /(--[a-z0-9-]+)\s*:\s*([^;]+);/gi;
  let m;
  while ((m = re.exec(block)) !== null) {
    vars.set(m[1].slice(2).trim(), m[2].trim());
  }
  return vars;
}

// ---------- 工具:hsl 三元组 → hex(用于校验 meta theme-color) ----------

function hslToHex(hslText) {
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
    r = l;
    g = l;
    b = l;
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

check(THEME_IDS.length > 0, '主题注册表为空');
check(THEME_IDS.includes(DEFAULT_THEME_ID), `默认主题 ${DEFAULT_THEME_ID} 不在注册表里`);
check(new Set(THEME_IDS).size === THEME_IDS.length, '主题 id 有重复');
check(THEME_IDS[0] === DEFAULT_THEME_ID, '默认主题应当是注册表第一项(设置页展示顺序)');

for (const theme of THEMES) {
  check(typeof theme.id === 'string' && theme.id.length > 0, `主题缺 id: ${JSON.stringify(theme)}`);
  check(/^[a-z][a-z0-9-]*$/.test(theme.id), `主题 id 必须是小写 kebab-case: ${theme.id}`);
  check(typeof theme.name === 'string' && theme.name.length > 0, `主题 ${theme.id} 缺中文名`);
  check(typeof theme.tagline === 'string' && theme.tagline.length > 0, `主题 ${theme.id} 缺说明文案`);
  check(
    /^#[0-9a-f]{6}$/i.test(theme.metaColor || ''),
    `主题 ${theme.id} 的 metaColor 必须是 6 位 hex(移动端状态栏底色)`,
  );
  check(
    typeof theme.swatchClass === 'string' && theme.swatchClass.startsWith('theme-swatch--'),
    `主题 ${theme.id} 的 swatchClass 必须是 .theme-swatch--* 类名`,
  );
}

// ---------- 2. index.css 必须为每个主题提供完整变量块 ----------

const css = readFileSync(resolve(frontendRoot, 'src', 'index.css'), 'utf8');

for (const theme of THEMES) {
  const selector = theme.id === DEFAULT_THEME_ID ? ':root' : `[data-theme="${theme.id}"]`;
  const block = extractBlock(css, selector);
  if (!block) {
    failures.push(`index.css 缺少主题 ${theme.id} 的变量块(${selector})`);
    continue;
  }
  const vars = collectVars(block);
  const missing = REQUIRED_THEME_TOKENS.filter((token) => !vars.has(token));
  if (missing.length > 0) {
    failures.push(
      `主题 ${theme.id}(${selector})缺 ${missing.length} 个 token:${missing.join(', ')} —— ` +
      '少一个都会静默退回继承值(典型表现:文字与背景同色、圆角算不出来、浮层不透明)',
    );
  }

  // 预览色块类必须存在,否则设置页会渲染成一块空白
  if (!css.includes(`.${theme.swatchClass}`)) {
    failures.push(`index.css 缺少预览色块类 .${theme.swatchClass}(设置页外观区会空白)`);
  }

  // meta theme-color 必须与该主题的背景色一致,否则移动端状态栏会出现一条异色带
  const bg = vars.get('background');
  if (bg) {
    const fromCss = hslToHex(bg.replace(/\s+/g, ' ').trim());
    const fromMeta = hexToRgb(theme.metaColor);
    if (!fromCss) {
      failures.push(`主题 ${theme.id} 的 --background 不是 \`h s% l%\` 形式,无法校验 metaColor:${bg}`);
    } else if (fromMeta) {
      const delta = Math.max(...fromCss.map((v, i) => Math.abs(v - fromMeta[i])));
      if (delta > 2) {
        failures.push(
          `主题 ${theme.id} 的 metaColor ${theme.metaColor} 与 index.css 的 --background ` +
          `(≈rgb(${fromCss.join(', ')}))不一致 —— 移动端状态栏会与页面底色断层`,
        );
      }
    }
  }
}

// 反过来:css 里出现的 data-theme 块,注册表里也必须有(防止删了主题留下死代码)
const themeBlocks = [...css.matchAll(/\[data-theme="([a-z0-9-]+)"\]/g)].map((m) => m[1]);
for (const id of new Set(themeBlocks)) {
  check(
    THEME_IDS.includes(id),
    `index.css 里的 [data-theme="${id}"] 不在注册表里 —— 这个主题永远无法被选中(死代码)`,
  );
}

// ---------- 3. index.html 的首帧脚本必须与注册表一致 ----------

const html = readFileSync(resolve(frontendRoot, 'index.html'), 'utf8');
const idsMatch = html.match(/var\s+THEME_IDS\s*=\s*\[([^\]]*)\]/);
if (!idsMatch) {
  failures.push('index.html 缺少首帧主题脚本的 THEME_IDS —— 选过非默认主题的用户开页会闪一下默认皮肤');
} else {
  const htmlIds = [...idsMatch[1].matchAll(/'([^']+)'|"([^"]+)"/g)].map((m) => m[1] ?? m[2]);
  check(
    htmlIds.join(',') === THEME_IDS.join(','),
    `index.html 的 THEME_IDS(${htmlIds.join(', ')})与注册表(${THEME_IDS.join(', ')})不一致 —— ` +
    '两处不同步时,首帧会先按一边渲染、挂载后再跳成另一边',
  );
}
const defaultMatch = html.match(/var\s+DEFAULT_THEME\s*=\s*['"]([^'"]+)['"]/);
check(
  defaultMatch && defaultMatch[1] === DEFAULT_THEME_ID,
  `index.html 的 DEFAULT_THEME 必须与注册表默认主题 ${DEFAULT_THEME_ID} 一致`,
);
check(
  html.includes(THEME_STORAGE_KEY),
  `index.html 的首帧脚本必须读 localStorage 的 ${THEME_STORAGE_KEY}(否则选择不会跨刷新保留)`,
);

// ---------- 4. 运行时行为契约 ----------

check(normalizeThemeId('fluent') === 'fluent', 'normalizeThemeId 不认识合法主题');
check(normalizeThemeId('FLUENT ') === 'fluent', 'normalizeThemeId 应当大小写/空白不敏感');
check(normalizeThemeId('nope') === DEFAULT_THEME_ID, '未知主题必须收敛到默认值');
check(normalizeThemeId(null) === DEFAULT_THEME_ID, 'null 必须收敛到默认值');
check(normalizeThemeId(undefined) === DEFAULT_THEME_ID, 'undefined 必须收敛到默认值');
check(normalizeThemeId(42) === DEFAULT_THEME_ID, '非字符串必须收敛到默认值');

check(getTheme('nope').id === DEFAULT_THEME_ID, 'getTheme 对未知 id 必须回默认主题而不是 undefined');
check(getTheme('fluent').id === 'fluent', 'getTheme 取不到合法主题');

// Storage 各种异常都不能抛错、不能阻断启动
const memoryStorage = (initial) => {
  const map = new Map(initial ? [[THEME_STORAGE_KEY, initial]] : []);
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, v); },
    _map: map,
  };
};
check(readStoredThemeId(memoryStorage('fluent')) === 'fluent', 'readStoredThemeId 读不出已保存的主题');
check(readStoredThemeId(memoryStorage('garbage')) === DEFAULT_THEME_ID, '读到非法值时必须回默认主题');
check(readStoredThemeId(null) === DEFAULT_THEME_ID, 'storage 不存在时必须回默认主题');
check(
  readStoredThemeId({ getItem() { throw new Error('SecurityError'); } }) === DEFAULT_THEME_ID,
  'storage.getItem 抛错时必须回默认主题(无痕模式不能崩)',
);
check(
  writeStoredThemeId({ setItem() { throw new Error('QuotaExceeded'); } }, 'fluent') === 'fluent',
  'storage.setItem 抛错时仍应返回本次生效的主题(不能因为写不进去就切不过去)',
);

// applyThemeToDocument:只动 data-theme 与 meta,不写内联样式
const fakeMeta = {
  attrs: {},
  setAttribute(name, value) { this.attrs[name] = value; },
};
const fakeDoc = {
  documentElement: { attrs: {}, setAttribute(name, value) { this.attrs[name] = value; } },
  querySelector: (sel) => (sel === 'meta[name="theme-color"]' ? fakeMeta : null),
};
check(applyThemeToDocument(fakeDoc, 'fluent') === 'fluent', 'applyThemeToDocument 应返回生效的主题 id');
check(fakeDoc.documentElement.attrs['data-theme'] === 'fluent', 'applyThemeToDocument 没写 data-theme');
check(
  fakeMeta.attrs.content === getTheme('fluent').metaColor,
  'applyThemeToDocument 没同步 <meta theme-color>(移动端状态栏会停在旧颜色)',
);
check(
  applyThemeToDocument(fakeDoc, 'unknown-id') === DEFAULT_THEME_ID,
  'applyThemeToDocument 遇到未知 id 应回默认主题而不是写入非法属性',
);

// ---------- 结果 ----------

if (failures.length > 0) {
  console.error(`主题契约未通过,共 ${failures.length} 项:\n`);
  console.error(failures.map((f) => `  · ${f}`).join('\n'));
  process.exitCode = 1;
} else {
  console.log(
    `主题契约通过:${THEME_IDS.length} 个主题(${THEME_IDS.join(' / ')})，` +
    `每块 ${REQUIRED_THEME_TOKENS.length} 个 token 齐全，index.html 首帧脚本与注册表一致。`,
  );
}
