// 开关滑块在选中/未选中两态下都必须与轨道有足够对比度。
//
// ## 为什么要有
//
// 用户实测反馈"这哪儿看得清啊。选中的时候你不做颜色反向吗"：
// 浅色主题下轨道选中 = --primary(#004F99，深蓝)，而滑块用 --switch-knob
// (0 0% 25%，深灰) —— 深色叠深色，几乎分不出滑块在哪。
//
// 旧版 WinUI 的 ToggleSwitch 在选中时滑块会反色。所以这里要求：
//   选中态滑块必须用 --primary-foreground（与轨道形成明确对比）
//
// 运行: node scripts/switchContrast.test.mjs

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const frontendRoot = resolve(here, '..');
const css = readFileSync(join(frontendRoot, 'src/index.css'), 'utf8');

/** 从 index.css 里取某个主题块里的 HSL 变量，转成 {h,s,l} */
const readThemeVar = (block, name) => {
  const re = new RegExp(`--${name}:\\s*([\\d.]+)\\s+([\\d.]+)%\\s+([\\d.]+)%`);
  const m = block.match(re);
  if (!m) return null;
  return { h: Number(m[1]), s: Number(m[2]), l: Number(m[3]) };
};

/** HSL → 相对亮度（WCAG 2.x） */
const hslToRgb = ({ h, s, l }) => {
  const sn = s / 100;
  const ln = l / 100;
  const c = (1 - Math.abs(2 * ln - 1)) * sn;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = ln - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return [r + m, g + m, b + m];
};

const luminance = (rgb) => {
  const [r, g, b] = rgb.map((v) => {
    const s = v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    return s;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

const contrast = (a, b) => {
  const la = luminance(hslToRgb(a));
  const lb = luminance(hslToRgb(b));
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
};

// 取两个主题块。选择器写法是 [data-theme="fluent-light"]（双引号），
// :root 与 fluent-light 共用同一块（见 index.css:34）。
const lightBlock = css.match(/\[data-theme="fluent-light"\][\s\S]*?\n  \}/);
const darkBlock = css.match(/\[data-theme="fluent-dark"\][\s\S]*?\n  \}/);

assert.ok(lightBlock, '找不到 fluent-light 主题块');
assert.ok(darkBlock, '找不到 fluent-dark 主题块');

for (const [themeName, block] of [
  ['fluent-light', lightBlock[0]],
  ['fluent-dark', darkBlock[0]],
]) {
  const primary = readThemeVar(block, 'primary');
  const primaryFg = readThemeVar(block, 'primary-foreground');
  assert.ok(primary, `${themeName} 缺 --primary`);
  assert.ok(primaryFg, `${themeName} 缺 --primary-foreground`);

  // 选中态：滑块(primary-foreground) 对 轨道(primary)
  const ratio = contrast(primary, primaryFg);
  assert.ok(
    ratio >= 3,
    `${themeName} 选中态滑块与轨道对比度 ${ratio.toFixed(2)}:1 < 3:1，滑块会看不清`,
  );
  console.log(`  ${themeName} 选中态对比度 ${ratio.toFixed(2)}:1`);
}

// CSS 必须有选中态的反色规则
const cssCode = css.replace(/\/\*[\s\S]*?\*\//g, '');
assert.match(
  cssCode,
  /\.switch-knob\[data-checked='true'\]\s*\{[^}]*--primary-foreground/s,
  '选中态必须把滑块换成 --primary-foreground（反色）',
);

// 两个开关都必须写 data-checked，否则规则不生效
const settingsPage = readFileSync(join(frontendRoot, 'src/components/Settings.js'), 'utf8');
const lyricsSettings = readFileSync(
  join(frontendRoot, 'src/components/DesktopLyricsSettings.js'),
  'utf8',
);
assert.match(settingsPage, /data-checked=\{autoDownloadOnPlay/, 'Settings.js 开关需写 data-checked');
assert.match(lyricsSettings, /data-checked=\{checked/, 'DesktopLyricsSettings 开关需写 data-checked');

console.log('开关滑块对比度门禁通过：两档主题选中态均 >= 3:1，且都做了反色。');
