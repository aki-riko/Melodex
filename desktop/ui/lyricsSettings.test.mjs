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

test('歌词窗只有两行（主行 + 副行），不得出现常驻第三行', () => {
  // 主行现在是双层结构（底层未播放色 + 上层已播放色被裁剪），
  // 复刻 WordFill.qml；另有 outgoing 层，但它**只在切行动画期间可见**
  // （旧实现 DesktopLyricsWindow.qml:371-400 的 outgoingLyric 同样是临时层）。
  assert.match(overlayHtml, /id="current-line-wrap"/, '主行容器');
  assert.match(overlayHtml, /id="current-line-base"/, '底层：未播放色');
  assert.match(overlayHtml, /id="current-line"/, '上层：已播放色');
  assert.match(overlayHtml, /id="next-line"[^>]*class="[^"]*adjacent"/, '副行');

  // 常驻逻辑行只能有两个：current + adjacent
  const wraps = [...overlayHtml.matchAll(/id="current-line-wrap"/g)].length;
  const adjacents = [...overlayHtml.matchAll(/id="next-line"/g)].length;
  assert.equal(wraps, 1, '只能有一个主行容器');
  assert.equal(adjacents, 1, '只能有一个副行');

  // outgoing 层必须默认隐藏（只在动画期间显示），不能是常驻第三行
  assert.match(
    overlayHtml,
    /id="outgoing-line"[^>]*aria-hidden="true"/,
    'outgoing 层需标 aria-hidden',
  );
  assert.match(overlayJs, /outgoingWrap\.style\.visibility = 'hidden'/, 'outgoing 默认隐藏');
  assert.match(overlayJs, /visibility = 'visible'/, '仅在动画期间显示');
});

test('已播放/未播放必须双色：底层与上层用不同颜色变量', () => {
  // 用户实测反馈「已播放和未播放应该是不同色」——旧版 WordFill.qml 用
  // 两个 Label 叠加（restingColor + activeColor 裁剪容器），不是 CSS 渐变。
  // 渐变与 -webkit-text-stroke 叠加时描边会盖住渐变，两色看不出差别。
  assert.match(overlayCss, /\.lyric-base\s*\{[^}]*color:\s*var\(--unplayed-color\)/s);
  assert.match(overlayCss, /\.lyric-active\s*\{[^}]*color:\s*var\(--played-color\)/s);
  assert.match(overlayCss, /\.lyric-clip\s*\{[^}]*width:\s*calc\(100% \* var\(--fill-ratio/s);
  // 不允许回退到 background-clip 渐变方案（注释里会解释为什么不这么做，要排除）
  const cssCode = overlayCss.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(
    cssCode,
    /background-clip:\s*text/,
    '不要再用 background-clip:text 渐变，描边会盖住它导致两色不分',
  );
});

test('整行进度按字数加权，与旧实现 lyricProgress 等价', () => {
  const js = overlayJs.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.match(js, /totalChars/, '需要按总字数归一');
  assert.match(js, /Math\.max\(1, String\(word\.s/, '每个词至少算 1 字');
  assert.match(js, /completed \/ Math\.max\(1, totalChars\)|completed\/Math\.max\(1,totalChars\)/);
});

test('行切换动画时长 300ms（旧版 duration.slower），不是 380', () => {
  assert.match(overlayJs, /TRANSITION_MS = 300/);
  assert.doesNotMatch(overlayJs, /TRANSITION_MS = 380/);
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

test('切行动画是三层共用同一 progress（复刻旧版 NumberAnimation 驱动）', () => {
  // 旧实现 DesktopLyricsWindow.qml:482-491 用 NumberAnimation 把
  // lyricTransitionProgress 0→1（300ms InOutCubic），三个元素由绑定共享它：
  //   旧行 exit = min(1, p/0.78)  → 上移 45% 行高 + 淡出
  //   新行 y 从副行位置插值到主行，scale 0.67→1，opacity 0.96→1
  //   副行 entry = max(0,(p-0.3)/0.7) → 从下方 35% 浮起 + 淡入
  // 本鱼最初用一个一次性 class + CSS transition，做不出"新行从副行位置长上来"。

  // JS：rAF 推进 + InOutCubic（缓动只在 JS 里做，CSS 只做线性插值）
  assert.match(overlayJs, /requestAnimationFrame/, '需要用 rAF 连续推进');
  assert.match(overlayJs, /TRANSITION_EASE/, '需要有缓动函数');
  assert.match(overlayJs, /applyTransitionProgress/, '需要把 progress 写入 CSS 变量');
  assert.match(overlayJs, /--transition-progress/);

  // CSS：三层都用同一个 --transition-progress 插值
  const css = overlayCss.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(css, /\.current-wrap\s*\{[^}]*--transition-progress/s, '新行用 progress');
  assert.match(css, /\.outgoing-wrap\s*\{[^}]*--transition-progress/s, '旧行用 progress');
  assert.match(css, /\.adjacent\s*\{[^}]*--transition-progress/s, '副行用 progress');

  // 旧版时间段：旧行 0.78 走完、副行 0.30 才开始
  assert.match(css, /\/ 0\.78/, '旧行应在 progress/0.78 内完成');
  assert.match(css, /- 0\.30\) \/ 0\.70/, '副行应在 (p-0.30)/0.70 后出现');
  // 旧行上移 45% 行高
  assert.match(css, /0\.45 \* var\(--active-line-height\)/);
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

test('可见性同时受「有歌曲状态」与「用户开关」约束', () => {
  // 注意：不能用 hasLyrics() 参与可见性判断——纯音乐没有 LRC，
  // 旧版仍会显示歌曲名/歌手名（DesktopLyricsWindow.qml:20-25）。
  // 本鱼最初把 hasLyrics() 写进可见性条件，结果纯音乐时窗口整个不出现。
  const js = overlayJs.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.match(js, /setOverlayVisible\(playback\.hasState && settings\.visible\)/);
  assert.doesNotMatch(
    js,
    /setOverlayVisible\([^)]*hasLyrics\(\)/,
    '可见性不得依赖 hasLyrics()，否则纯音乐会完全不显示',
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

// ---------- 防回归：改设置导致歌词消失 ----------

test('歌词窗里没有「顶层 const 被更早位置引用」（TDZ 白屏）', () => {
  // 本鱼实际踩过：把 currentLineWidthCache 的 const 放在 renderCurrentLine
  // 之后，函数体里先引用 → 抛 ReferenceError → render() 中断 → 歌词被清空。
  // 现象是「每次调设置歌词就消失」，与交接文档里的坑 2 同类。
  //
  // 检测策略（刻意窄，避免误报）：只看**模块顶层**的 const/let
  // （行首无缩进），且只在**模块顶层语句**里找引用。
  // 函数体内的同名局部变量（参数、循环变量）天然在自己的作用域里，不算违规。
  const lines = overlayJs.split('\n');

  // 收集顶层声明：行首就是 const/let（无缩进）
  const topLevelDecl = new Map();
  lines.forEach((line, i) => {
    const m = line.match(/^(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=/);
    if (m) topLevelDecl.set(m[1], i);
  });

  // 只在顶层语句里找引用：同样要求行首无缩进（顶层的调用/箭头函数定义）。
  const offenders = [];
  for (const [name, declLine] of topLevelDecl) {
    for (let i = 0; i < declLine; i += 1) {
      const line = lines[i];
      if (line.trim().startsWith('//')) continue;
      if (/^\s/.test(line)) continue; // 缩进行属于函数体，跳过
      const re = new RegExp(`(^|[^.\\w$'"])${name.replace(/\$/g, '\\$')}([^.\\w$'"]|$)`);
      if (re.test(line)) {
        offenders.push(`${name}（声明于第 ${declLine + 1} 行）在第 ${i + 1} 行的顶层语句里被提前引用`);
        break;
      }
    }
  }
  assert.deepEqual(offenders, [], `检测到 TDZ 风险：\n  ${offenders.join('\n  ')}`);
});

test('设置广播只重刷样式，不重置渲染状态', () => {
  // 设置变化走 applySettings（改 CSS 变量），不得清空 renderedLineIndex /
  // renderedActiveText，否则每次调设置都会被当成"换行"重放动画或清空文字。
  const applyFn = overlayJs.match(/const applySettings = \([\s\S]*?\n\};/);
  assert.ok(applyFn, '找不到 applySettings');
  assert.doesNotMatch(applyFn[0], /renderedLineIndex\s*=/, 'applySettings 不得重置行号');
  assert.doesNotMatch(applyFn[0], /renderedActiveText\s*=/, 'applySettings 不得清空当前文本');
  assert.doesNotMatch(applyFn[0], /replaceChildren|textContent\s*=\s*''/, 'applySettings 不得清空 DOM');
});

test('没有歌词时显示歌曲名/歌手名，而不是留空', () => {
  // 复刻 DesktopLyricsWindow.qml:20-25：
  //   activeText: activeLine ? activeLine.text : (Player.currentSong.name || "")
  //   nextText:   nextLine   ? nextLine.text   : (Player.currentSong.artist || "")
  // 本鱼最初写成"无歌词就清空"，导致纯音乐/歌词未加载时窗口一片空白，
  // 用户看到的就是"歌词没了"。
  assert.match(overlayJs, /playback\.track\?\.name/, '无歌词时应回退到歌曲名');
  assert.match(overlayJs, /playback\.track\?\.artist/, '无歌词时副行应回退到歌手名');
  // 只有连歌曲信息都没有时才清空
  assert.match(overlayJs, /if \(!playback\.track\)/);
});

test('窗口可见性只看「有状态 + 用户开关」，不被"有没有歌词"卡死', () => {
  // 纯音乐没有 LRC，但窗口仍应显示歌名——不能因为 hasLyrics()=false 就隐藏。
  const js = overlayJs.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.match(
    js,
    /setOverlayVisible\(playback\.hasState && settings\.visible\)/,
    '可见性不应依赖 hasLyrics()',
  );
});

console.log(`\ndesktop lyrics settings contract tests passed (${passed})`);
