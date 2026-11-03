// 严格模式对比度审计:覆盖「只有 text-*、背景继承父级」的情况。
// 上一版只检查了同一元素上同时写 bg-* 和 text-* 的组合,漏掉了最常见的写法:
//   <div className="bg-card"><span className="text-muted-foreground">...
// 这里文字色和背景色不在同一个 className 里,静态扫描配不上对。
// 所以对每个 text-* 分别假设它压在 card / background / secondary / muted 这几种常见父底上,
// 取最差的那个值报告。
//
// 运行: node scripts/contrast-audit.mjs fluent | spotify

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, extname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const frontendRoot = resolve(here, '..');
const srcRoot = resolve(frontendRoot, 'src');
const cssText = readFileSync(resolve(srcRoot, 'index.css'), 'utf8');
const themeId = process.argv[2] || 'fluent';

function extractBlock(css, selector) {
  const needle = `${selector} {`;
  const start = css.indexOf(needle);
  if (start < 0) return null;
  let i = start + needle.length - 1;
  let depth = 0;
  for (; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    else if (css[i] === '}') { depth -= 1; if (depth === 0) return css.slice(start + needle.length, i); }
  }
  return null;
}
const collectVars = (block) => {
  const m = new Map();
  const re = /(--[a-z0-9-]+)\s*:\s*([^;]+);/gi;
  let x;
  while ((x = re.exec(block)) !== null) m.set(x[1].slice(2).trim(), x[2].trim());
  return m;
};
const rootVars = collectVars(extractBlock(cssText, ':root') || '');
const themeVars = themeId === 'spotify' ? new Map() : collectVars(extractBlock(cssText, `[data-theme="${themeId}"]`) || '');
const tok = (n) => themeVars.get(n) ?? rootVars.get(n) ?? null;

const parseHsl = (t) => {
  if (!t) return null;
  const m = t.match(/^([\d.]+)\s+([\d.]+)%\s+([\d.]+)%(?:\s*\/\s*([\d.]+))?$/);
  return m ? { h: +m[1], s: +m[2] / 100, l: +m[3] / 100, a: m[4] === undefined ? 1 : +m[4] } : null;
};
const hslToRgb = ({ h, s, l }) => {
  const hh = h / 360;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t) => {
    let tt = t % 1;
    if (tt < 0) tt += 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };
  return [f(hh + 1 / 3), f(hh), f(hh - 1 / 3)].map((v) => Math.round(v * 255));
};
const over = (fg, bg, a) => fg.map((c, i) => Math.round(c * a + bg[i] * (1 - a)));
const relLum = (rgb) => {
  const v = rgb.map((x) => {
    const c = x / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
};
const contrast = (a, b) => {
  const la = relLum(a), lb = relLum(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
};

const rgbOf = (name, alphaOverride) => {
  const raw = tok(name);
  if (!raw) return null;
  const p = parseHsl(raw);
  if (!p) return null;
  return { rgb: hslToRgb(p), a: alphaOverride === undefined ? p.a : alphaOverride };
};

// 常见的父级底色
const parentSurfaces = ['background', 'card', 'popover', 'secondary', 'muted', 'accent'];
// 代码里出现过的 text-* 语义色
const textColors = [
  'foreground', 'muted-foreground', 'primary', 'secondary-foreground',
  'destructive', 'success', 'warning', 'info', 'accent-foreground',
  'card-foreground', 'popover-foreground', 'primary-foreground',
];

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (extname(e.name) === '.js') out.push(p);
  }
  return out;
}
const files = walk(srcRoot);

// 统计每个 text-* 类在源码里的实际出现位置。
// 关键排除项:如果**同一个 className 里已经声明了 bg-***,说明这一处有明确的配对背景,
// 不该拿它去和"常见父级底色"逐一对撞(否则 text-primary-foreground + bg-primary 会被误报成 1:1)。
const usage = new Map();
const paired = new Map();
for (const f of files) {
  const code = readFileSync(f, 'utf8');
  const rel = relative(srcRoot, f).split('\\').join('/');
  const re = /\btext-([a-z-]+)\b/g;
  let m;
  while ((m = re.exec(code)) !== null) {
    const name = m[1];
    if (!textColors.includes(name)) continue;
    const line = code.slice(0, m.index).split('\n').length;

    // 取这条类名所在的 className 字符串(粗略:向前后各找一对引号)
    const lineStart = code.lastIndexOf('\n', m.index) + 1;
    const chunk = code.slice(lineStart, code.indexOf('\n', m.index) === -1 ? code.length : code.indexOf('\n', m.index));
    const hasPairedBg = /\bbg-[a-z-]+/.test(chunk);

    if (hasPairedBg) {
      paired.set(name, (paired.get(name) || 0) + 1);
      continue;
    }
    if (!usage.has(name)) usage.set(name, []);
    usage.get(name).push(`${rel}:${line}`);
  }
}

console.log(`\n=== 主题 ${themeId}:文字色 × 常见父级底色的最差对比度 ===`);
const rows = [];
for (const [name, places] of usage) {
  const fg = rgbOf(name);
  if (!fg) continue;
  let worst = { ratio: Infinity, on: null };
  for (const surf of parentSurfaces) {
    const bg = rgbOf(surf);
    if (!bg) continue;
    const bgFlat = over(bg.rgb, [255, 255, 255], bg.a);
    const fgFlat = over(fg.rgb, bgFlat, fg.a);
    const r = contrast(fgFlat, bgFlat);
    if (r < worst.ratio) worst = { ratio: r, on: surf };
  }
  rows.push({ name, ...worst, count: places.length, sample: places[0] });
}
rows.sort((a, b) => a.ratio - b.ratio);
for (const r of rows) {
  const flag = r.ratio < 4.5 ? 'FAIL' : (r.ratio < 7 ? 'ok  ' : 'AAA ');
  console.log(`  ${flag} ${String(r.ratio.toFixed(2)).padStart(5)}:1  text-${r.name.padEnd(20)} 最差压于 ${r.on}  (${r.count} 处, 如 ${r.sample})`);
}
const fails = rows.filter((r) => r.ratio < 4.5);
console.log(fails.length === 0
  ? '\n全部 >= 4.5:1 ✓'
  : `\n${fails.length} 个文字色在至少一种常见父底上低于 4.5:1`);
