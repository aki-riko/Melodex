// 桌面歌词设置页的开关必须复用应用原生开关。
//
// ## 为什么要有
//
// 本鱼手写过一版开关：用绝对定位 + 自己算 left/top/translate-x，
// 结果滑块跑到了胶囊外面（用户截图实证，浅色主题下尤其明显）。
// 而应用里 `Settings.js` 早有一个**已验证可用**的原生开关，
// 问题本质是「有现成的没去复用，自己重新发明」。
//
// 这条门禁锁两件事：
//   1. 必须用 `switch-knob` 类（滑块颜色来自 --switch-knob 主题变量，
//      手写 bg-white 在浅色主题下会"消失"）；
//   2. 不得自己用 absolute/left/top 定位滑块。
//
// 运行: node scripts/desktopLyricsSettingsToggle.test.mjs

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const frontendRoot = resolve(here, '..');

const lyricsSettings = readFileSync(
  join(frontendRoot, 'src/components/DesktopLyricsSettings.js'),
  'utf8',
);
const settingsPage = readFileSync(join(frontendRoot, 'src/components/Settings.js'), 'utf8');

// 取出 Toggle 组件的实现（从 const Toggle 到下一个顶层 const）
const toggleMatch = lyricsSettings.match(/const Toggle = [\s\S]*?\n\);/);
assert.ok(toggleMatch, '找不到 DesktopLyricsSettings 里的 Toggle 组件');
const toggleSrc = toggleMatch[0];

// ---------- 1. 必须用 switch-knob ----------

assert.match(
  toggleSrc,
  /switch-knob/,
  '滑块必须用 switch-knob 类：颜色来自 --switch-knob 主题变量，手写 bg-white 在浅色主题下会消失',
);

// ---------- 2. 不得自己绝对定位滑块 ----------

assert.doesNotMatch(
  toggleSrc,
  /absolute\s+top-/,
  '不要用 absolute + top 自己定位滑块（本鱼踩过：滑块会跑出胶囊外）',
);
assert.doesNotMatch(
  toggleSrc,
  /\bleft-\d/,
  '不要用 left-* 自己定位滑块，用 inline-flex items-center + translate-x 即可',
);

// ---------- 3. 结构必须与应用原生开关一致 ----------

// 轨道
assert.match(toggleSrc, /relative inline-flex h-6 w-11/);
assert.match(toggleSrc, /items-center/);
assert.match(toggleSrc, /rounded-full/);
assert.match(toggleSrc, /transition-colors/);

// 选中/未选中的轨道色必须走语义 token
assert.match(toggleSrc, /'bg-primary'/);
assert.match(toggleSrc, /'bg-secondary'/);

// 滑块尺寸与位移
assert.match(toggleSrc, /inline-block h-4 w-4/);
assert.match(toggleSrc, /transform rounded-full transition-transform/);
assert.match(toggleSrc, /'translate-x-6'/);
assert.match(toggleSrc, /'translate-x-1'/);

// ---------- 4. 应用里那个"原版"开关也必须保持同样的类（防两边分叉） ----------

const nativeToggle = settingsPage.match(/role="switch"[\s\S]*?<\/button>/);
assert.ok(nativeToggle, '找不到 Settings.js 里的原生开关');
assert.match(nativeToggle[0], /switch-knob/, '原生开关也依赖 switch-knob');
assert.match(nativeToggle[0], /h-6 w-11/);
assert.match(nativeToggle[0], /translate-x-6/);

// 两边位移量必须相同，否则"看着是一套控件、动起来不一样"
const lyricsTranslate = toggleSrc.match(/translate-x-(\d)/);
assert.ok(lyricsTranslate, '找不到滑块位移量');
assert.equal(
  lyricsTranslate[1],
  '6',
  '滑块位移必须与原生开关一致（translate-x-6）',
);

console.log(
  '桌面歌词设置开关契约通过：复用 switch-knob、无绝对定位、结构与 Settings.js 原生开关一致。',
);
