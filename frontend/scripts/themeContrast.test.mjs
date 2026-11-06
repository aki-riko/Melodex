// Fluent 深浅两档的对比度审计(纯计算,无浏览器依赖)。
//
// 为什么要有:主题改造最容易出的不是"跑不起来",而是**对比度不达标却没人发现** ——
// 文字压在某个面上、状态色压在淡底上,单看代码都"应该是那个色",实际读起来费劲。
// 这个脚本把常用的前景/背景配对全算一遍,低于 WCAG AA 就报错。
//
// 判据(WCAG 2.1):
//   · 正文与大号文字的常规要求 4.5:1(大号 3:1);
//   · 徽章/图标这类非文本 UI 元素 3:1。
//
// 运行: node scripts/themeContrast.test.mjs  (npm run test:contrast)
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const frontendRoot = resolve(scriptDir, '..');

// ---- hsl 三元组 → 相对亮度 ----
const parseHsl = (text) => {
  const m = String(text).trim().match(/^([\d.]+)\s+([\d.]+)%\s+([\d.]+)%$/);
  if (!m) return null;
  return { h: Number(m[1]), s: Number(m[2]) / 100, l: Number(m[3]) / 100 };
};

const hslToRgb = ({ h, s, l }) => {
  const hue = h / 360;
  const f = (p, q, t) => {
    let tt = t;
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };
  if (s === 0) return [l, l, l];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [f(p, q, hue + 1 / 3), f(p, q, hue), f(p, q, hue - 1 / 3)];
};

// WCAG 相对亮度
const luminance = (rgb) => {
  const [r, g, b] = rgb.map((v) => {
    const c = Math.max(0, Math.min(1, v));
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

const contrast = (a, b) => {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
};

// ---- 从 index.css 取变量 ----
const css = readFileSync(resolve(frontendRoot, 'src/index.css'), 'utf8');

function extractBlock(selector) {
  // 选择器可能与其他选择器共用同一个块(例如 `:root,\n  [data-theme="fluent-light"] {`),
  // 所以不能直接找 `${selector} {` —— 要先定位到以 `{` 结尾的那一段声明式。
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`${escaped}\\s*[,{]`);
  const m = re.exec(css);
  if (!m) return '';
  // 从命中位置向后找这个选择器组的 `{`
  const open = css.indexOf('{', m.index);
  if (open < 0) return '';
  let i = open;
  let depth = 0;
  for (; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    else if (css[i] === '}') {
      depth -= 1;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  return '';
}

function collectVars(block) {
  const vars = new Map();
  const re = /(--[a-z0-9-]+)\s*:\s*([^;]+);/gi;
  let m;
  while ((m = re.exec(block)) !== null) vars.set(m[1].slice(2).trim(), m[2].trim());
  return vars;
}

const themes = {
  'fluent-light': collectVars(extractBlock(':root')),
  'fluent-dark': collectVars(extractBlock('[data-theme="fluent-dark"]')),
};

// 深色块没定义的就从 :root 继承(与 CSS 级联一致)
for (const id of Object.keys(themes)) {
  if (id === 'fluent-dark') {
    for (const [k, v] of themes['fluent-light']) {
      if (!themes[id].has(k)) themes[id].set(k, v);
    }
  }
}

const failures = [];
let checks = 0;

const verify = (themeId, fgToken, bgToken, min, label) => {
  const vars = themes[themeId];
  const fg = parseHsl(vars.get(fgToken));
  const bg = parseHsl(vars.get(bgToken));
  if (!fg || !bg) {
    failures.push(`${themeId}: 取不到 ${fgToken} 或 ${bgToken}(变量缺失或不是 h s% l% 形式)`);
    return;
  }
  const ratio = contrast(hslToRgb(fg), hslToRgb(bg));
  checks += 1;
  if (ratio < min) {
    failures.push(
      `${themeId}: ${label} = ${ratio.toFixed(2)}:1,低于要求 ${min}:1` +
      `(${fgToken} 压在 ${bgToken} 上)`,
    );
  }
};

for (const id of Object.keys(themes)) {
  // 正文:主文字压在各层表面上
  verify(id, 'foreground', 'background', 4.5, '主文字 / 页面底');
  verify(id, 'foreground', 'card', 4.5, '主文字 / 卡片');
  verify(id, 'foreground', 'popover', 4.5, '主文字 / 浮层');
  verify(id, 'card-foreground', 'card', 4.5, '卡片文字 / 卡片');
  verify(id, 'popover-foreground', 'popover', 4.5, '浮层文字 / 浮层');
  verify(id, 'secondary-foreground', 'secondary', 4.5, '选中项文字 / 选中面');
  verify(id, 'accent-foreground', 'accent', 4.5, '悬停文字 / 悬停面');

  // 次要文字:实例里用于说明、时间戳,仍属正文,必须 4.5
  verify(id, 'muted-foreground', 'background', 4.5, '次要文字 / 页面底');
  verify(id, 'muted-foreground', 'card', 4.5, '次要文字 / 卡片');
  verify(id, 'muted-foreground', 'popover', 4.5, '次要文字 / 浮层');

  // 实心主按钮:主色底 + primary-foreground 文字
  verify(id, 'primary-foreground', 'primary', 4.5, '主按钮文字 / 主色');
  verify(id, 'destructive-foreground', 'destructive', 4.5, '危险按钮文字 / 危险色');
  verify(id, 'success-foreground', 'success', 4.5, '成功徽章文字 / 成功色');
  verify(id, 'warning-foreground', 'warning', 4.5, '警告徽章文字 / 警告色');
  verify(id, 'info-foreground', 'info', 4.5, '信息徽章文字 / 信息色');

  // 状态色当**文字**用在普通底上(错误提示、删除图标等)
  verify(id, 'destructive-text', 'card', 4.5, '错误文字 / 卡片');
  verify(id, 'destructive-text', 'popover', 4.5, '错误文字 / 浮层');

  // 非文本 UI 元素:焦点环、边框这类 3:1 即可
  verify(id, 'ring', 'background', 3, '焦点环 / 页面底');
  verify(id, 'primary', 'background', 3, '主色(图标/链接) / 页面底');
  verify(id, 'primary', 'card', 3, '主色(图标/链接) / 卡片');
}

if (failures.length > 0) {
  console.error(`对比度审计未通过,共 ${failures.length}/${checks} 项:\n`);
  console.error(failures.map((f) => `  · ${f}`).join('\n'));
  process.exitCode = 1;
} else {
  console.log(`对比度审计通过:${Object.keys(themes).length} 档主题 × ${checks / Object.keys(themes).length} 组配色 = ${checks} 项全部达标(WCAG AA)。`);
}
