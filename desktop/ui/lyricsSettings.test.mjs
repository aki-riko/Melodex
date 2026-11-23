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
  assert.match(cssCode, /text-shadow:\s*0 1px 2px var\(--shadow-color\)/);
  assert.match(cssCode, /--outline-color:\s*rgba\(5, 6, 8, 0\.82\)/);
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
  const css = overlayCss.replace(/\/\*[\s\S]*?\*\//g, '');
  const adjacentType = css.match(/\.adjacent \.lyric-base[\s\S]{0,240}/);
  assert.ok(adjacentType, '找不到副行字号规则');
  assert.match(adjacentType[0], /--secondary-font-scale/, '副行需用自己的缩放系数');
  assert.doesNotMatch(
    adjacentType[0],
    /var\(--line-font-scale/,
    '副行不得复用主行的 --line-font-scale',
  );
  // JS 侧必须真的写入这个变量
  assert.match(overlayJs, /--secondary-font-scale/);
  // 副行最小字号 = max(14, 主行最小 - 4) = 16
  assert.match(overlayJs, /Math\.max\(14, FONT_SIZE_MIN - 4\)/, '副行下限需复刻旧版公式');
});

test('裁剪区宽度必须用 DOM 实测，不能用 canvas 估算', () => {
  // canvas.measureText 只算字形 advance，**不计 letter-spacing 与
  // -webkit-text-stroke 的外扩**。实测同一句：
  //   canvas 651.97px vs DOM 665.3px —— 差 13.33px（约 2%）
  // 拿 canvas 值定位 clip，clip 会比白底文字窄一圈、还右移几像素，
  // 白字从左右露出 → 同样表现为「白边」。
  //
  // canvas 仍可用于「要不要缩字号」的估算（差 2% 不影响判定），
  // 但定位裁剪区必须用 Range.getBoundingClientRect（真实排版结果）。
  const js = overlayJs.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.match(js, /measureLineBox/, '需要有基于 DOM 的行盒测量函数');
  assert.match(js, /createRange\(\)/, '需要用 Range 量真实排版宽度');
  assert.match(js, /getBoundingClientRect/, 'Range 结果要靠 getBoundingClientRect 取');
  // --text-left / --text-width 必须来自 DOM 测量结果，不能来自 measureText
  const renderFn = js.match(/const renderCurrentLine = \([\s\S]*?\n\};/);
  assert.ok(renderFn, '找不到 renderCurrentLine');
  assert.match(renderFn[0], /measureLineBox/, '裁剪区必须用 DOM 测量');
  assert.doesNotMatch(
    renderFn[0],
    /measureText\(/,
    'renderCurrentLine 不得再用 canvas 的 measureText 定位裁剪区',
  );
});

test('裁剪容器与文字层必须严格重合（否则白底会露出一圈白边）', () => {
  // ★ 实际踩到、且**靠肉眼找了两轮才定位**的 bug：
  //   .current-wrap 是 flex + align-items:center，底层 .lyric-base 因此被垂直居中（y=49）；
  //   而 .lyric-clip 是绝对定位普通块，里面的 .lyric-active 从 top:0 起排（y=44）。
  //   两层垂直差 5px → 未播放色的白字在下方整条露出 → 观感是「粉字外面一圈白边」，
  //   外加顶部看着像被切掉。水平方向本来是齐的（offsetX=0），只看横向永远找不到。
  //
  // 实测数据：修复前亮中性灰（#EEEEEE）6900 像素；给 clip 补垂直居中后归 0。
  const css = overlayCss.replace(/\/\*[\s\S]*?\*\//g, '');
  const clipRule = css.match(/\.lyric-clip\s*\{[^}]*\}/s);
  assert.ok(clipRule, '找不到 .lyric-clip 规则');
  // 必须建立纵向 flex 并垂直居中，与 .current-wrap 同构
  assert.match(clipRule[0], /display:\s*flex/, 'clip 需为 flex 才能垂直居中上层文字');
  assert.match(clipRule[0], /flex-direction:\s*column/);
  assert.match(clipRule[0], /justify-content:\s*center/, 'column 方向下垂直居中靠 justify-content');
  // 但**不能**让水平也居中：上层水平位置靠负 margin-left 精确抵消，居中会推走 ~64px
  assert.doesNotMatch(
    clipRule[0],
    /align-items:\s*center/,
    'column 方向下 align-items:center 会把上层文字水平推走，破坏 margin-left 对齐',
  );
  // 上层不能被 flex 压缩（`flex: 0 0 auto` 必须写在 .lyric-active 那条规则里）。
  // 这里直接查 CSS 文本中出现该声明即可 —— 分离规则的正则容易误匹配到
  // `.lyric-base, .lyric-active { ... }` 那条合并规则，反而是脆弱的写法。
  assert.match(
    css,
    /\.lyric-active\s*\{[^}]*flex:\s*0\s+0\s+auto[^}]*\}/s,
    'cell 内是 flex，上层禁止被压缩（flex: 0 0 auto）',
  );
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

test('可见性只由用户开关决定，不叠加「是否收到过播放状态」', () => {
  // 注意：不能用 hasLyrics() 参与可见性判断——纯音乐没有 LRC，
  // 旧版仍会显示歌曲名/歌手名（DesktopLyricsWindow.qml:20-25）。
  //
  // ★ 2026-11-23 修正（用户实测：点「锁定」后歌词整个消失）：
  //   原先这里断言的是 `setOverlayVisible(playback.hasState && settings.visible)`，
  //   而 playback.hasState 表示「本窗口收到过至少一条推送」，只在播放且桥接正常时为 true。
  //   于是暂停时点锁定 → 触发 render → hasState=false → 窗口被隐藏，看起来像歌词坏了。
  //   「有没有歌词可显示」壳侧已经管（has_lyrics_state），前端再叠一层只会打架。
  const js = overlayJs.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.match(js, /setOverlayVisible\(settings\.visible\)/, '可见性只看用户开关');
  assert.doesNotMatch(
    js,
    /setOverlayVisible\([^)]*hasState/,
    '不得再用 playback.hasState 参与可见性判断（暂停时点锁定会导致歌词消失）',
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

test('行左右内边距常量与 CSS padding 一致', () => {
  // 缩字号时可用宽度 = 行宽 - 左右 padding。两边不一致会算错。
  const paddingMatch = overlayCss.match(/\.lyrics-shell\s*\{[^}]*padding:\s*\d+px\s+(\d+)px/s);
  assert.ok(paddingMatch, '找不到 .lyrics-shell 的 padding');
  const cssHorizontal = Number(paddingMatch[1]) * 2;

  const jsMatch = overlayJs.match(/LINE_HORIZONTAL_PADDING\s*=\s*(\d+)/);
  assert.ok(jsMatch, '找不到 LINE_HORIZONTAL_PADDING');
  assert.equal(
    Number(jsMatch[1]),
    cssHorizontal,
    `JS 常量 ${jsMatch[1]} 与 CSS 左右 padding 之和 ${cssHorizontal} 不一致`,
  );
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

console.log(`\ndesktop lyrics settings contract tests passed (${passed})`);
