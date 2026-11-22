// 桌面歌词设置契约测试。
//
// 这些断言锁住的是「与旧 PrismQML 实现对齐」这件事本身：
// 8 套配色 / 6 种字体 / 字号范围 / 5 个控制按钮 / 设置项清单。
// 任何一项被悄悄改动，这里会先红，而不是等用户发现「和以前不一样了」。
//
// Rust 侧那份清单由 `cargo test` 的 lyrics_settings 单测覆盖；
// 这里覆盖 HTML/CSS 与 JS 的接线，两边都红才算真的对齐。

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const read = (name) => readFileSync(join(here, name), 'utf8');

const overlayHtml = read('overlay.html');
const overlayCss = read('overlay.css');
const overlayJs = read('overlay.js');
const settingsHtml = read('index.html');
const settingsJs = read('settings.js');

let passed = 0;
const test = (name, fn) => {
  fn();
  passed += 1;
  console.log(`  ok - ${name}`);
};

// ---------- 控制条：5 个按钮 ----------

test('控制条有且只有 5 个按钮，且顺序与旧实现一致', () => {
  const commands = [...overlayHtml.matchAll(/data-command="([a-z]+)"/g)].map((m) => m[1]);
  assert.deepEqual(
    commands,
    ['prev', 'toggle', 'next', 'lock', 'close'],
    '旧实现顺序：上一首/播放暂停/下一首/锁定/关闭',
  );
});

test('播放按钮有播放与暂停两个图标，靠 class 切换', () => {
  assert.match(overlayHtml, /class="icon-play"/);
  assert.match(overlayHtml, /class="icon-pause"/);
  assert.match(overlayCss, /\.is-playing \.icon-play\s*\{\s*display:\s*none/);
  assert.match(overlayCss, /\.is-playing \.icon-pause\s*\{\s*display:\s*block/);
  assert.match(overlayJs, /classList\.toggle\('is-playing'/);
});

test('控制条默认隐藏、passthrough 时不显示、悬停才淡入', () => {
  // 默认态
  assert.match(overlayCss, /\.controls\s*\{[^}]*opacity:\s*0/s);
  assert.match(overlayCss, /\.controls\s*\{[^}]*pointer-events:\s*none/s);
  // 悬停态必须排除 passthrough（锁定时整条不响应）
  assert.match(
    overlayCss,
    /body:not\(\.passthrough\) \.lyrics-shell:hover \.controls/,
    '锁定时不得显示控制条',
  );
});

test('控制条高度 38、宽度贴合内容（不再有大块空白）', () => {
  assert.match(overlayCss, /--control-bar-height:\s*38px/);
  assert.match(
    overlayCss,
    /border-radius:\s*calc\(var\(--control-bar-height\) \/ 2\)/,
    '胶囊需要圆角=高度一半',
  );
  // 用户实测反馈「padding 太大」：旧版写死 212 宽但内容只有 176，
  // 两侧各空 18px。改为宽度由内容决定，并断言 padding 是小的固定值，
  // 防止有人把 width 改回 212 或把 padding 加回去。
  const block = overlayCss.match(/\.controls\s*\{[^}]*\}/s);
  assert.ok(block, '找不到 .controls 规则');
  assert.match(block[0], /width:\s*max-content/, '控制条宽度应由内容决定');
  assert.doesNotMatch(
    block[0],
    /width:\s*var\(--control-bar-width\)/,
    '不要再用写死的 212，内容撑不满会显得两侧空旷',
  );
  const padding = block[0].match(/padding:\s*0\s+(\d+)px/);
  assert.ok(padding, '应显式声明水平 padding');
  assert.ok(
    Number(padding[1]) <= 12,
    `水平 padding 应 <=12px（实际 ${padding[1]}px），否则两侧又会显得空`,
  );
});

test('每个按钮 32×30（旧 Fluent.Button）', () => {
  assert.match(overlayCss, /\.controls button\s*\{[^}]*width:\s*32px/s);
  assert.match(overlayCss, /\.controls button\s*\{[^}]*height:\s*30px/s);
});

test('播放按钮是 pill 形状', () => {
  assert.match(overlayCss, /\.controls button\.primary\s*\{[^}]*border-radius:\s*calc\(30px \/ 2\)/s);
});

// ---------- 双行布局不能被改坏 ----------

test('歌词窗只有两行（主行 + 副行），不得出现第三行', () => {
  const lines = [...overlayHtml.matchAll(/class="lyric-line ([a-z]+)"/g)].map((m) => m[1]);
  assert.deepEqual(lines, ['current', 'adjacent'], '旧实现是双行：当前 + 下一行');
  // 只看真正的元素，不看注释（注释里会解释"为什么没有第三行"）。
  const body = overlayHtml.replace(/<!--[\s\S]*?-->/g, '');
  assert.doesNotMatch(body, /id="previous-line"|id="outgoing/i, '不得引入常驻第三行元素');
});

test('描边与阴影必须保留（白字压浅色壁纸的可见性）', () => {
  assert.match(overlayCss, /-webkit-text-stroke:\s*1px var\(--outline-color\)/);
  assert.match(overlayCss, /text-shadow:\s*0 1px 2px var\(--shadow-color\)/);
  assert.match(overlayCss, /--outline-color:\s*rgba\(5, 6, 8, 0\.82\)/);
});

test('副行字号是主行 × 0.67 且最小 16px', () => {
  assert.match(overlayCss, /--secondary-scale:\s*0\.67/);
  assert.match(overlayJs, /SECONDARY_SCALE = 0\.67/);
  assert.match(overlayJs, /SECONDARY_MIN_PX = 16/);
});

test('行切换 380ms 且用 InOutCubic 缓动', () => {
  assert.match(overlayCss, /--transition-ms:\s*380ms/);
  assert.match(overlayCss, /cubic-bezier\(0\.65, 0, 0\.35, 1\)/);
});

// ---------- 设置来源：必须是壳侧，不许回退 localStorage ----------

test('歌词窗不再读写 localStorage 保存字号/位置', () => {
  // 只看代码体，注释里会解释"为什么不再用 localStorage"。
  const code = overlayJs
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
  assert.doesNotMatch(code, /localStorage/, '设置的唯一真相源在 Rust 侧');
  assert.match(code, /invoke\('lyrics_settings_get'\)/);
  assert.match(code, /invoke\('lyrics_settings_update'/);
});

test('歌词窗消费设置事件，能跟随设置页/托盘的改动', () => {
  assert.match(overlayJs, /SETTINGS_EVENT = 'melodex:lyrics-settings'/);
  assert.match(overlayJs, /listen\(SETTINGS_EVENT/);
});

test('可见性同时受「有歌词」与「用户开关」约束', () => {
  assert.match(
    overlayJs,
    /setOverlayVisible\(playback\.hasState && hasLyrics\(\) && settings\.visible\)/,
    '用户关掉歌词后不得再自动弹出',
  );
});

test('锁定时不触发拖动、不保存位置', () => {
  assert.match(overlayJs, /if \(settings\.click_through\) return;/);
});

test('锁定/关闭按钮走本机设置，不发给主窗口页面', () => {
  assert.match(overlayJs, /if \(command === 'lock'\)[\s\S]*?click_through: true/);
  assert.match(overlayJs, /if \(command === 'close'\)[\s\S]*?visible: false/);
  // 发往页面的白名单只应三个播放命令
  assert.match(overlayJs, /\['prev', 'toggle', 'next'\]\.includes\(command\)/);
});

// ---------- 设置页：6 项必须齐全 ----------

test('设置页 6 项齐全且顺序对齐旧实现', () => {
  const ids = [...settingsHtml.matchAll(/id="(setting-[a-z]+|reset-position)"/g)].map((m) => m[1]);
  assert.deepEqual(ids, [
    'setting-visible',
    'setting-locked',
    'setting-font',
    'setting-size',
    'setting-color',
    'reset-position',
  ]);
});

test('设置页订阅设置事件，跟随其它窗口改动', () => {
  assert.match(settingsJs, /listen\(SETTINGS_EVENT, \(event\) => render\(event\.payload\)\)/);
});

test('字号滑块范围与步长来自壳侧，不在这里硬编码 20/64', () => {
  assert.match(settingsJs, /sizeRange\.min = String\(settings\.font_size_min/);
  assert.match(settingsJs, /sizeRange\.max = String\(settings\.font_size_max/);
  // 步长写在 HTML 上（1px 一档，与旧实现 stepSize: 1 一致）
  assert.match(settingsHtml, /id="setting-size"[^>]*step="1"/, '滑块必须是 1px 步长');
});

test('设置页每次只提交改动的字段（补丁语义）', () => {
  // 每个 commit 调用都只带一个键
  const calls = [...settingsJs.matchAll(/commit\(\s*\{([^}]+)\}/g)].map((m) => m[1].trim());
  assert.ok(calls.length >= 4, `应至少 4 处局部提交，实际 ${calls.length}`);
  for (const body of calls) {
    const keys = body.split(',').filter((part) => part.includes(':'));
    assert.equal(keys.length, 1, `每次只提交一个字段，实际提交了：${body}`);
  }
});

test('设置页保存失败时如实回读壳侧真实状态', () => {
  assert.match(settingsJs, /保存失败/);
  assert.match(settingsJs, /render\(await invoke\('lyrics_settings_get'\)\)/);
});

console.log(`\ndesktop lyrics settings contract tests passed (${passed})`);
