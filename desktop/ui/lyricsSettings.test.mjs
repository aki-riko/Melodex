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
// 纯逻辑核心被抽到 lyricsCore.js（有独立的 lyricsCore.test.mjs 锁死数值行为）。
// 静态断言要同时看这两处：算法搬走后仍必须存在，不能"搬着搬着就没了"。
const lyricsCoreJs = read('lyricsCore.js');
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
  //
  // ★ 悬停判定挂在 body 上而不是 .lyrics-shell：shell 已内缩（左右 12、顶部 32），
  //   指针落在窗口外圈那一条时也该出控制条 —— 旧版 HoverHandler 是**整窗**。
  assert.match(
    overlayCss,
    /body:not\(\.passthrough\):hover \.controls/,
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
  const cssCode = overlayCss.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(cssCode, /\.lyric-base\s*\{[^}]*color:\s*var\(--unplayed-color\)/s);
  assert.match(cssCode, /\.lyric-active\s*\{[^}]*color:\s*var\(--played-color\)/s);
  // 裁剪容器宽度 = 文字宽度 × 进度（细节见「填色裁剪从文字左边缘开始」那条）
  assert.match(cssCode, /\.lyric-clip\s*\{[^}]*--fill-ratio/s);
  // 不允许回退到 background-clip 渐变方案（注释里会解释为什么不这么做，要排除）
  assert.doesNotMatch(
    cssCode,
    /background-clip:\s*text/,
    '不要再用 background-clip:text 渐变，描边会盖住它导致两色不分',
  );
});

test('整行进度按字数加权，与旧实现 lyricProgress 等价', () => {
  // 算法本体在 lyricsCore.js 的 lineProgress（逐行对照 cpp/Lyrics.cpp:140-170），
  // 数值行为由 lyricsCore.test.mjs 逐条验证；这里守的是"实现没有被悄悄换掉"。
  const code = [overlayJs, lyricsCoreJs]
    .map((source) => source.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n'))
    .join('\n');
  assert.match(code, /totalChars/, '需要按总字数归一');
  assert.match(code, /Math\.max\(1, String\(word\??\.s/, '每个词至少算 1 字');
  assert.match(
    code,
    /completed \/ Math\.max\(1, totalChars\)|completed\/Math\.max\(1,totalChars\)/,
  );
  // overlay.js 必须真的用上共享核心，而不是自己另抄一份（两份必然分叉）
  assert.match(overlayJs, /from '\.\/lyricsCore\.js'/, 'overlay.js 需从核心导入');
  assert.match(overlayJs, /coreLineProgress|lineProgress/, 'overlay.js 需使用共享实现');
});

test('行切换动画时长 300ms（旧版 duration.slower），不是 380', () => {
  assert.match(overlayJs, /TRANSITION_MS = 300/);
  assert.doesNotMatch(overlayJs, /TRANSITION_MS = 380/);
});

test('描边与阴影必须保留（白字压浅色壁纸的可见性）', () => {
  const cssCode = overlayCss.replace(/\/\*[\s\S]*?\*\//g, '');
  // 描边宽度随字号缩放（缩字号时描边也该跟着细，否则小字被描边糊住）
  assert.match(cssCode, /-webkit-text-stroke:\s*calc\(1px \* var\(--line-font-scale/);
  assert.match(cssCode, /--outline-color:\s*rgba\(5, 6, 8, 0\.82\)/);
  // ★ 阴影的 blur 必须是 **0**（硬阴影），垂直偏移 1px。
  //   QML DesktopLyricsWindow.qml:40-41 明确写 lyricShadowBlur = 0、
  //   lyricShadowVerticalOffset = 1。曾经写成 `0 1px 2px`（blur 2px），
  //   那是「字发糊」的直接原因：旧版根本不模糊，只做 1px 位移把字顶出来。
  assert.match(cssCode, /text-shadow:\s*0 1px 0 var\(--shadow-color\)/);
  assert.doesNotMatch(
    cssCode,
    /text-shadow:\s*0 1px 2px/,
    '阴影 blur 必须为 0（QML shadowBlur=0）；2px 模糊会让字发糊',
  );
  // paint-order 必须写，否则描边会盖住填充、字变细一圈
  assert.match(cssCode, /paint-order:\s*stroke fill/);
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

test('副行独立缩放，不复用主行的适配系数', () => {
  // 旧版 DesktopLyricsWindow.qml:462-464：副行有自己的 Text.Fit + minimumPixelSize，
  // 与主行各缩各的。共用 --line-font-scale 会让「主行短 / 副行长」时副行溢出。
  //
  // 结构说明：副行是纯 Fluent.Label（单层、无填色），所以字号规则直接写在
  // `.adjacent` 上，不再有内层 span。
  const css = overlayCss.replace(/\/\*[\s\S]*?\*\//g, '');
  const adjacentRule = css.match(/\.adjacent\s*\{[^}]*\}/s);
  assert.ok(adjacentRule, '找不到 .adjacent 规则');
  assert.match(adjacentRule[0], /--secondary-font-scale/, '副行需用自己的缩放系数');
  assert.doesNotMatch(
    adjacentRule[0],
    /var\(--line-font-scale/,
    '副行不得复用主行的 --line-font-scale',
  );
  // JS 侧必须真的写入这个变量
  assert.match(overlayJs, /--secondary-font-scale/);
  // 副行最小字号 = max(14, 主行最小 - 4) = 16
  assert.match(overlayJs, /Math\.max\(14, FONT_SIZE_MIN - 4\)/, '副行下限需复刻旧版公式');
});

test('裁剪区宽度必须用 DOM 实测，不能用 canvas 估算', () => {
  // canvas.measureText 只算字形 advance，**不计描边外扩**。
  // 拿 canvas 值定位 clip，clip 会比白底文字窄一圈，白字从左右露出 → 「白边」。
  //
  // canvas 仍可用于「要不要缩字号」的估算（差 1-2% 不影响判定），
  // 但定位裁剪区必须用 Range.getBoundingClientRect（真实排版结果）。
  const js = overlayJs.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.match(js, /measureLineWidth/, '需要有基于 DOM 的行宽测量函数');
  assert.match(js, /createRange\(\)/, '需要用 Range 量真实排版宽度');
  assert.match(js, /getBoundingClientRect/, 'Range 结果要靠 getBoundingClientRect 取');
  // 测量函数内部不得用 canvas
  const measureFn = js.match(/const measureLineWidth = \([\s\S]*?\n\};/);
  assert.ok(measureFn, '找不到 measureLineWidth');
  assert.doesNotMatch(measureFn[0], /measureText\(/, '裁剪区必须用 DOM 测量');
  // 每帧路径（updateFillProgress）只写 CSS 变量，不得做 DOM 测量（会触发布局）
  const fillFn = js.match(/const updateFillProgress = \([\s\S]*?\n\};/);
  assert.ok(fillFn, '找不到 updateFillProgress');
  assert.doesNotMatch(
    fillFn[0],
    /getBoundingClientRect|measureLineWidth|createRange/,
    '每帧只写一个 CSS 变量，80ms 一次不能触发排版',
  );
});

test('裁剪容器与文字层必须严格重合（否则白底会露出一圈白边）', () => {
  // ★ 实际踩到、且**靠肉眼找了两轮才定位**的 bug：
  //   当年用 `.current-wrap{display:flex;align-items:center}` 把底层文字垂直居中，
  //   而 .lyric-clip 里的上层从 top:0 起排，两层差了 5px →
  //   未播放色的白字在下方整条露出 → 观感是「粉字外面一圈白边」。
  //
  // 那次修法是"给 clip 再套一层 flex 去凑对齐"，仍然是脆弱的：
  // 只要行高/字号任一变化就可能再错位。
  //
  // 现在的做法是从几何上根除：两层都是**绝对定位 + 同一个 line-height**，
  // 不存在"两个不同布局模式各自算居中"的可能。
  const css = overlayCss.replace(/\/\*[\s\S]*?\*\//g, '');
  const shared = css.match(/\.lyric-base,\s*\n?\.lyric-active\s*\{[^}]*\}/s);
  assert.ok(shared, '找不到 .lyric-base/.lyric-active 合并规则');
  assert.match(shared[0], /position:\s*absolute/, '两层必须都是绝对定位');
  assert.match(shared[0], /line-height:\s*var\(--active-line-height\)/, '两层必须共用行高');

  const clipRule = css.match(/\.lyric-clip\s*\{[^}]*\}/s);
  assert.ok(clipRule, '找不到 .lyric-clip 规则');
  // clip 必须绝对定位并铺满行高，不能再靠 flex 拼垂直居中
  assert.match(clipRule[0], /position:\s*absolute/);
  assert.match(clipRule[0], /height:\s*100%/);
  assert.doesNotMatch(
    clipRule[0],
    /justify-content:\s*center/,
    '不要再用 flex 居中拼对齐：两层共用 line-height 即可，flex 方案曾错位 5px',
  );
  // 上层宽度由 --line-width 给出，并用负 margin 抵消 clip 偏移
  // （.lyric-active 有两条规则：与 .lyric-base 合并的公共几何 + 自己的特化，
  //   所以要扫全部匹配，不能只取第一条）
  const activeRules = [...css.matchAll(/\.lyric-active[^{]*\{[^}]*\}/gs)].map((m) => m[0]);
  assert.ok(activeRules.length > 0, '找不到 .lyric-active 规则');
  const activeAll = activeRules.join('\n');
  assert.match(activeAll, /width:\s*var\(--line-width/);
  assert.match(activeAll, /margin-left:\s*calc\(-1\s*\*\s*var\(--text-left/);
  assert.match(activeAll, /color:\s*var\(--played-color\)/);
});

test('三层歌词必须真的被绝对定位（类名与 HTML 一致）', () => {
  // ★ 实际踩到的血案：CSS 里写的是 `.lyric-row`，HTML 用的是 `class="lyric-line"`，
  //   两者对不上 → 整条定位规则**从未生效** → 三层退化成 flex 流里的普通块，
  //   `top`/`transform` 全部失去参照，歌词叠在一起、切行动画完全看不出来。
  //   这类"选择器写错一个字"的 bug 构建、类型检查、其它测试全都不会报。
  const css = overlayCss.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(css, /\.lyric-line\s*\{[^}]*position:\s*absolute/s, '三层容器需绝对定位');
  assert.doesNotMatch(
    css,
    /\.lyric-row\s*\{/,
    'HTML 里没有 lyric-row 这个类名，写它等于整条规则失效',
  );
  // HTML 里三个元素确实都用 lyric-line
  const lines = [...overlayHtml.matchAll(/class="lyric-line/g)].length;
  assert.equal(lines, 3, '主行/旧行/副行三层都要带 lyric-line');
});

test('主行顶部偏移=44（lyricSurface 32 + 边距 12），否则控制条压住歌词', () => {
  // 旧版 DesktopLyricsWindow.qml:280 + 44-45：
  //   lyricSurface.topMargin = 32，activeLineTopMargin = 12 → activeLineY = 44
  // 曾经写成 12px，整块歌词上移 32px，悬停控制条（top:0、高 38）直接盖在歌词上。
  const css = overlayCss.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(css, /--active-line-top:\s*44px/, '主行顶部偏移必须是 44px');
  // 三层都必须用这个变量，不能各自写死
  for (const block of ['.current-wrap', '.outgoing-wrap', '.adjacent']) {
    const re = new RegExp(`\\${block}\\s*\\{[^}]*--active-line-top`, 's');
    assert.match(css, re, `${block} 需使用 --active-line-top`);
  }
});

test('新行入场偏移 = (主行高+副行高)/2，方向必须朝下', () => {
  // 旧版 DesktopLyricsWindow.qml:42-50 推导：
  //   incomingActiveY - activeLineY = (activeLineHeight + secondaryLineHeight) / 2
  // 字号 36 → 主行 56 + 副行 38 → +47px（从副行位置**升上来**）。
  // ★ 曾经写成 `secondaryLineHeight - activeLineHeight`（-18px）：
  //   符号与数值双错，新行变成从上方掉下来，切行方向与旧版完全相反。
  const css = overlayCss.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(
    css,
    /--incoming-offset:\s*calc\(\s*\(var\(--active-line-height\)\s*\+\s*var\(--secondary-line-height\)\)\s*\/\s*2\s*\)/,
    '入场偏移必须是两行高的平均值',
  );
  assert.doesNotMatch(
    css,
    /--incoming-offset:\s*calc\(var\(--secondary-line-height\)\s*-\s*var\(--active-line-height\)\)/,
    '不要再用「副行高 - 主行高」：这是负数，方向反了',
  );
});

test('双击空白处关闭歌词（复刻旧版 WindowDragHandle.onDoubleClicked）', () => {
  // 旧版 DesktopLyricsWindow.qml:493-499：
  //   WindowDragHandle { onDoubleClicked: UserSettings.setLyricsVisible(false) }
  // 必须排除控制条：双击「上一首」不该关歌词（旧版控制条 z=10 盖在拖拽层 z=9 之上）。
  assert.match(overlayJs, /addEventListener\('dblclick'/, '缺少双击关闭');
  assert.match(overlayJs, /dblclick[\s\S]{0,200}visible: false/, '双击应关闭歌词');
  assert.match(
    overlayJs,
    /dblclick[\s\S]{0,200}closest\('\.controls'\)/,
    '双击控制条按钮不得关闭歌词',
  );
});

test('位置保存前先夹回可视区（旧版 clampToVisibleArea）', () => {
  // 旧版 DesktopLyricsWindow.qml:97-104 + 180-185：
  //   每次坐标变化都 clampToVisibleArea，落盘的一定是可显示位置。
  // 否则把窗口拖到屏幕外后存下的坐标会让歌词"重启后消失"。
  const saveFn = overlayJs.match(/const savePosition = async \([\s\S]*?\n\};/);
  assert.ok(saveFn, '找不到 savePosition');
  assert.match(saveFn[0], /overlay_clamp_position/, '保存前必须先回拉');

  // 恢复位置后同样要夹（旧版 restorePosition 里紧跟 Qt.callLater(clampToVisibleArea)）：
  // 显示器变化或字号变大后，旧坐标可能已在屏幕外。
  const restoreFn = overlayJs.match(/const restorePosition = async \([\s\S]*?\n\};/);
  assert.ok(restoreFn, '找不到 restorePosition');
  assert.match(
    restoreFn[0],
    /overlay_clamp_position/,
    '恢复位置后必须回拉，否则歌词可能整块落在屏幕外',
  );
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

test('可见性 = 用户开关 且 有歌可显示（无歌时不得留空窗挡鼠标）', () => {
  // ★ 2026-11-23 实测确认的缺陷（用户报「桌面歌词一坨屎」时抓到）：
  //   曾经只判 `settings.visible`，于是「没在放歌」时窗口照样显示 ——
  //   但它是一片全透明、默认又不穿透的**置顶矩形**（实测 535×158、
  //   WS_EX_TRANSPARENT=0），屏幕上什么都看不见，却实实在在挡住下面的窗口，
  //   用户点不到被盖住的地方，也完全不知道是什么在挡。
  //
  // 正确判据来自旧实现 desktop_state.py:40-48：
  //     should_show = settings.lyricsVisible and bool(current_song.get("id"))
  // 即**有歌才显示**。
  //
  // 判据必须是 playback.track（收到过歌曲信息就一直有），
  // **不能**是 hasState / hasLyrics：
  //   · hasState 只在播放且桥接正常时为 true → 暂停时点「锁定」会让歌词整个消失；
  //   · 纯音乐没有 LRC → 旧版仍显示歌曲名/歌手名，也不该消失。
  const js = overlayJs.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.match(
    js,
    /setOverlayVisible\(Boolean\(settings\.visible && playback\.track\)\)/,
    '可见性必须是「用户开关 且 有歌」，无歌时不留空窗',
  );
  assert.doesNotMatch(
    js,
    /setOverlayVisible\([^)]*hasState/,
    '不得用 playback.hasState 参与可见性判断（暂停时点锁定会导致歌词消失）',
  );
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
      // import 语句天然安全：它是模块依赖声明，且被提升到模块求值之前执行，
      // 不可能构成 TDZ。而且导入名与被导入模块的导出名常常同名
      // （`import { lineProgress } ...`），把它算进来只会产生误报。
      if (/^import\s/.test(line)) continue;
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

test('长歌词必须缩字号，不能溢出窗口', () => {
  // 旧实现 WordFill.qml:37-41 有 Text.Fit + minimumPixelSize + elide：
  // 放不下就等比缩字号，缩到最小仍放不下才省略号。
  // 本鱼最初只写 text-overflow:ellipsis + 固定字号，长句直接冲出窗口被硬切，
  // 且因 -webkit-text-stroke 的关系边缘糊成一片（用户截图实证）。
  const css = overlayCss.replace(/\/\*[\s\S]*?\*\//g, '');
  const js = overlayJs.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

  // CSS：字号必须乘一个缩放系数
  assert.match(css, /font-size:\s*calc\(var\(--lyric-font-size\) \* var\(--line-font-scale/);
  // JS：必须用 canvas 或等价手段量文字宽度，并按比例算缩放
  assert.match(js, /measureText/, '需要用测量结果判断是否超宽');
  assert.match(js, /--line-font-scale/, '需要把缩放系数写进 CSS');
  assert.match(js, /fitScale/, '需要有适配函数');
  // 必须有下限，不能无限缩小（对应旧实现 minimumPixelSize）。
  // 现在下限是参数化的：主行传 FONT_SIZE_MIN(20)，副行传 max(14, 20-4)=16。
  assert.match(
    js,
    /minimumPixelSize \/ Math\.max\(1, baseSize\)/,
    '缩字号需要下限',
  );
  assert.match(js, /minimumPixelSize = FONT_SIZE_MIN/, '主行下限默认 FONT_SIZE_MIN');
});

test('填色裁剪从文字左边缘开始，不是行左边缘', () => {
  // WordFill.qml:24-25：
  //   textPaintedWidth = min(width, paintedWidth)
  //   textLeft         = (width - textPaintedWidth) / 2
  // 裁剪容器 x = textLeft，所以短句的填色从文字左端开始。
  const css = overlayCss.replace(/\/\*[\s\S]*?\*\//g, '');
  const clipRule = css.match(/\.lyric-clip\s*\{[^}]*\}/s);
  assert.ok(clipRule, '找不到 .lyric-clip 规则');
  assert.match(clipRule[0], /left:\s*var\(--text-left/, '裁剪容器需从文字左边缘开始');
  assert.match(
    clipRule[0],
    /width:\s*calc\(var\(--text-width[^)]*\)\s*\*\s*var\(--fill-ratio/,
    '裁剪宽度 = 文字宽度 × 进度',
  );

  // JS 需要写入这两个量
  assert.match(overlayJs, /--text-left/);
  assert.match(overlayJs, /--text-width/);
});

test('行内缩常量与 CSS 完全一致（主行 34、副行 42、表面 12）', () => {
  // 缩字号时可用宽度 = 行宽 - 左右内缩。两边不一致会算错，长句仍溢出。
  //
  // 旧版几何（DesktopLyricsWindow.qml）：
  //   lyricSurface 左右内缩 12（`width - 24` 的一半）        :62
  //   主行 anchors.left/rightMargin = 34                     :378-379
  //   副行 anchors.left/rightMargin = 42                     :444-445
  // 所以主行可用宽 = 窗口宽 - (12+34)*2 = 窗口宽 - 92，
  //     副行可用宽 = 窗口宽 - (12+42)*2 = 窗口宽 - 108。
  const cssVar = (name) => {
    const m = overlayCss.match(new RegExp(`--${name}:\\s*(\\d+)px`));
    assert.ok(m, `CSS 里找不到 --${name}`);
    return Number(m[1]);
  };
  const jsNum = (name) => {
    const m = overlayJs.match(new RegExp(`const ${name} = (\\d+)`));
    assert.ok(m, `overlay.js 里找不到 ${name}`);
    return Number(m[1]);
  };

  assert.equal(jsNum('SURFACE_INSET'), cssVar('surface-inset'), '表面内缩必须一致');
  assert.equal(jsNum('LINE_INSET'), cssVar('line-inset'), '主行内缩必须一致');
  assert.equal(jsNum('SECONDARY_INSET'), cssVar('secondary-inset'), '副行内缩必须一致');

  // 派生常量必须是这两个公式算出来的，而不是另写一个魔数
  const surface = jsNum('SURFACE_INSET');
  const line = jsNum('LINE_INSET');
  const secondary = jsNum('SECONDARY_INSET');
  const derived = (name) => {
    const m = overlayJs.match(new RegExp(`const ${name} = \\(SURFACE_INSET \\+ \\w+\\) \\* 2`));
    assert.ok(m, `${name} 必须由 (SURFACE_INSET + ...) * 2 推导，不要另写魔数`);
  };
  derived('LINE_HORIZONTAL_PADDING');
  derived('SECONDARY_HORIZONTAL_PADDING');
  assert.equal((surface + line) * 2, 92, '主行左右合计应为 92（窗口宽 - 92）');
  assert.equal((surface + secondary) * 2, 108, '副行左右合计应为 108（窗口宽 - 108）');

  // 主行顶部偏移 = 表面 32 + 行边距 12 = 44（否则悬停控制条压住歌词）
  assert.equal(cssVar('surface-top') + cssVar('active-line-top-margin'), cssVar('active-line-top'));
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

// ---------- 2026-11-23 重做后新增的门禁：锁住这次修的四个根因 ----------

test('填色进度必须拿到真实歌词行对象，不能只传 { text }', () => {
  // ★★ 这是「整行一次性亮、逐字填色完全看不出来」的根因，最难发现：
  //   旧代码 render() 里写的是
  //       renderCurrentLine({ text: mainText }, position)
  //   renderCurrentLine 内部又调 lineProgress(line, position) ——
  //   而这个 `line` 只有 text、没有 t/end/words，于是 lineProgress 走无 words 分支：
  //       start = Number(undefined) || 0 = 0
  //       end   = start + 5 = 5
  //       progress = clamp((pos - 0) / 5) → 播放 5 秒后恒为 1
  //   → 无论唱到哪儿整行都是已播放色，进度条逻辑等于不存在。
  //
  //   判据：进度更新必须用 playback.lyrics[renderedLineIndex] 这个**真实行**。
  const js = overlayJs.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.match(
    js,
    /playback\.lyrics\[renderedLineIndex\]/,
    '必须按已渲染行索引取真实歌词行对象（带 t/end/words）',
  );
  // 禁止再把"只有 text 的字面量对象"喂给进度函数
  assert.doesNotMatch(
    js,
    /coreLineProgress\(\s*\{\s*text:/,
    '不得用 { text } 当歌词行：它没有 t/end/words，进度会恒为 1',
  );
  assert.doesNotMatch(
    js,
    /renderCurrentLine\(\s*\{\s*text:/,
    '不得只把 { text } 传给渲染函数',
  );
  // updateFillProgress 必须真的调用共享核心算进度
  const fillFn = js.match(/const updateFillProgress = \([\s\S]*?\n\};/);
  assert.ok(fillFn, '找不到 updateFillProgress');
  assert.match(fillFn[0], /coreLineProgress\(line, position\)/);
});

test('窗口隐藏时量不到宽度，显示后必须自动补算几何', () => {
  // ★ 重做时实际踩到的坑：窗口隐藏状态下 `clientWidth` 是 0，
  //   几何（--text-width）算不出来；等窗口显示、宽度到位后，
  //   若只按「文字+缩放系数」判断是否需要重算，就会判定"没变、不用算"，
  //   --text-width 永远停在 0 → 裁剪区宽 0 → 整行填色完全不可见。
  //
  //   判据：几何去重签名里必须包含可用宽度。
  const js = overlayJs.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  const geomFn = js.match(/const applyLineGeometry = \([\s\S]*?\n\};/);
  assert.ok(geomFn, '找不到 applyLineGeometry');
  assert.match(geomFn[0], /availableWidth <= 0\) return false/, '宽度为 0 时不得写入几何');
  const signature = geomFn[0].match(/const signature = ([^;]+);/);
  assert.ok(signature, '找不到几何去重签名');
  assert.match(
    signature[1],
    /availableWidth/,
    '几何签名必须含可用宽度，否则窗口从隐藏变可见后不会补算',
  );
});

test('几何变量必须写在各自行容器上，不能共用一套', () => {
  // 旧行与主行的文字不同宽，而且旧行的 --fill-ratio 恒为 1、主行是动态值。
  // 共用一套（写 .lyrics-shell 或 :root）会让旧行裁剪区按主行宽度算、整个错位，
  // 甚至让旧行整条不可见。
  const js = overlayJs.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  const geomFn = js.match(/const applyLineGeometry = \([\s\S]*?\n\};/);
  assert.ok(geomFn, '找不到 applyLineGeometry');
  // 三个变量都必须写到传入的 wrap 上
  for (const name of ['--line-font-scale', '--text-left', '--text-width']) {
    assert.match(
      geomFn[0],
      new RegExp(`wrap\\.style\\.setProperty\\('${name}'`),
      `${name} 必须写到各行自己的 wrap 上`,
    );
  }
  // 旧行的 fill-ratio 必须钉成 1（QML :387 progress: 1）
  assert.match(js, /outgoingWrap\.style\.setProperty\('--fill-ratio', '1'\)/);
});

test('新行入场缩放按字号实时算，不是硬编码 0.67', () => {
  // QML :49-50：incomingActiveScale = secondaryFontSize / max(1, lyricsFontSize)
  // 字号 20 → 16/20 = 0.8；字号 64 → 43/64 ≈ 0.672。
  // 硬编码 0.67 会让小字号下入场尺寸与实际副行对不上（凭空大一圈再缩回去）。
  assert.match(overlayJs, /--incoming-scale/, '需要写入入场缩放变量');
  const fn = overlayJs.match(/const applyFontSize = \([\s\S]*?\n\};/);
  assert.ok(fn, '找不到 applyFontSize');
  assert.match(
    fn[0],
    /secondary \/ Math\.max\(1, size\)/,
    '入场缩放必须是 副行字号 / 主行字号',
  );
  // CSS 里必须用这个变量，不能写死 0.67
  const css = overlayCss.replace(/\/\*[\s\S]*?\*\//g, '');
  const currentRule = css.match(/\.current-wrap\s*\{[^}]*\}/s);
  assert.ok(currentRule, '找不到 .current-wrap 规则');
  assert.match(currentRule[0], /var\(--incoming-scale/, '入场缩放需读变量');
  assert.doesNotMatch(
    currentRule[0],
    /scale\(0\.67\)/,
    '不要硬编码 0.67',
  );
});

test('旧行只在动画期间显示，结束后必须隐藏', () => {
  // QML :374 visible: lyricLineAdvance.running && outgoingActiveText.length > 0
  // 若结束后不隐藏，旧行会一直压在新行上面（z=3），表现为"歌词定格不动"。
  const js = overlayJs.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  const finishFn = js.match(/const finishTransition = \([\s\S]*?\n\};/);
  assert.ok(finishFn, '找不到 finishTransition');
  assert.match(finishFn[0], /outgoingWrap\.style\.visibility = 'hidden'/, '结束后必须隐藏旧行');
  assert.match(finishFn[0], /outgoingBase\.textContent = ''/, '结束后必须清空旧行文字');
});

test('切行动画只在该动画时播（同时间戳分组也要算向前）', () => {
  // QML :129-148 canAnimateForward 的两个分支：
  //   ① 正好下一行；② 跳过的行与上一行**时间戳完全相同**（合唱/翻译同戳）。
  // 漏掉 ② 会让同一句的第二行"突然跳出来"，没有过渡。
  const js = overlayJs.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  const fn = js.match(/const canAnimateForward = \([\s\S]*?\n\};/);
  assert.ok(fn, '找不到 canAnimateForward');
  assert.match(fn[0], /nextIndex === previousIndex \+ 1/, '必须支持"正好下一行"');
  assert.match(fn[0], /previousTimestamp/, '必须处理同时间戳分组');
});

test('量文字宽度必须剔除祖先 transform 缩放', () => {
  // ★★ 用户实测：「歌词向上滚动的时候…分离了，妈的这玩意就几帧」。
  //
  // 根因：`Range.getBoundingClientRect()` 返回的是**被祖先 transform 缩放后**的尺寸。
  // 切行动画期间主行正在 `scale(incomingScale → 1)`，实测（CDP 现场量）：
  //   progress=0   transform=matrix(0.667,...)  measuredW=96px
  //   progress=0.5 transform=matrix(0.833,...)  measuredW=120px
  //   progress=1   transform=matrix(1,...)      measuredW=144px
  // 动画期间只量到真实宽度的 2/3 → --text-width 偏小 → 粉色裁剪区提前截断、
  // 右边露出白字；--text-left 也偏 → 两层横向错开。
  // 因为动画只有 300ms，用户看到的就是「就几帧」的分离。
  const js = overlayJs.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  const fn = js.match(/const measureLineWidth = \([\s\S]*?\n\};/);
  assert.ok(fn, '找不到 measureLineWidth');
  assert.match(fn[0], /accumulatedScale/, '必须剔除祖先 transform 缩放');
  assert.match(
    fn[0],
    /\/ *scale|rect\.width \/ scale/,
    '量到的宽度必须除以累计缩放',
  );
  // 累计缩放函数本身要存在且遍历祖先
  assert.match(js, /const accumulatedScale = \([\s\S]*?parentElement/, '需要向上遍历祖先累乘缩放');
});

test('切行动画开始前不得使用缩放状态下的旧宽度', () => {
  // 几何签名去重的副作用：动画期间 --transition-progress 每帧在变，
  // 但文字/字号/行宽都没变 → 签名相同 → 不会重新测量。
  // 只要 measureLineWidth 已经是"缩放无关"的，这一点就安全（量一次即可）。
  // 这条门禁守的是"不要又改回直接读 rect.width"。
  const js = overlayJs.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  const geomFn = js.match(/const applyLineGeometry = \([\s\S]*?\n\};/);
  assert.ok(geomFn, '找不到 applyLineGeometry');
  assert.doesNotMatch(
    geomFn[0],
    /getBoundingClientRect\(\)\.width(?! *\/)/,
    '不得直接用 getBoundingClientRect().width 当文字宽（会被 transform 缩放污染）',
  );
});

console.log(`\ndesktop lyrics settings contract tests passed (${passed})`);