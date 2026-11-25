// 手机端排版契约门禁 —— 锁住 2026-11 这一轮的移动端对齐规则，防止回潮。
//
// ## 为什么需要（这批缺陷都是"算出来"的，肉眼容易漏）
//
// 1. **列表右列溢出**：手机档 `grid-cols-[minmax(0,1fr)_5rem]`（80px）里
//    要放「播放 44 + gap 2 + 更多 36 = 82px」，两个按钮又都 flex-shrink-0
//    （uiConsistency 门禁强制），于是列被撑破 2px。**四种手机宽度下都溢出**。
// 2. **触控下限**：ux-redesign-plan.md 写"所有可点区域 ≥44px"，
//    而「更多」在手机上只有 36px（h-9 w-9）。
// 3. **左边缘不对齐**：行内 px-3(12px) + 页面 px-4(16px) = 封面起点 28px，
//    而页面主标题在 16px —— 同屏两种左边距。
// 4. **头图尺寸两套**：CoverMosaic 默认 128px，手写三处 112px。
// 5. **卡片宽度两套 + 内边距两套**：144/136px、p-2/p-1.5。
// 6. **帮助页双重内边距**：container p-6 套在 App 的 px-4 里 = 40px。
//
// 这些都能用静态规则判定，所以做成门禁。运行:
//   node scripts/mobileLayout.test.mjs   （已接进 npm run test:mobile）
//
// ⚠️ 本门禁只锁「能被机器判定」的部分。真实观感仍需要在真机上人眼确认。

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptDir, '..');
const readSrc = (rel) => readFileSync(join(root, rel), 'utf8');

const failures = [];
const check = (name, fn) => {
  try {
    fn();
    console.log(`  ok - ${name}`);
  } catch (error) {
    failures.push(name);
    console.log(`  NOT OK - ${name}`);
    for (const line of String(error.message).split('\n')) console.log(`      ${line}`);
  }
};

// 解析一个 Tailwind 任意值列宽表达式里所有 `Nrem` 数值，转成 px。
const remsToPx = (values) => values.map((v) => Number(v.replace('rem', '')) * 16);

const songRow = readSrc('src/components/SongRow.js');

// ---------- ① 歌曲行：手机右列必须容得下两个按钮 ----------

check('歌曲行手机档右列宽度容得下「播放 + 更多」两颗按钮', () => {
  // 手机档 = 第一段 grid-cols-[...]（lg: 前缀那段是桌面，不算）
  const m = songRow.match(/grid-cols-\[minmax\(0,1fr\)_([\d.]+rem)\]/);
  assert.ok(m, 'SongRow 找不到手机档 grid-cols 定义（结构变了？请同步更新本门禁）');
  const [colPx] = remsToPx([m[1]]);

  // 播放键：第一个 h-11 w-11 的按钮（手机档）
  const playMatch = songRow.match(/flex flex-shrink-0 h-11 w-11[^"']*/);
  assert.ok(playMatch, 'SongRow 找不到手机档播放按钮（应为 h-11 w-11）');

  // 更多按钮必须也是 44px（手机档），桌面 (lg:) 才回 36px
  const moreMobile = songRow.match(/h-11 w-11 items-center justify-center rounded-control transition-colors[^"']*lg:h-9 lg:w-9/);
  assert.ok(
    moreMobile,
    '「更多」按钮手机档必须是 44px（h-11 w-11），桌面才回 lg:h-9 lg:w-9 —— '
    + 'ux-redesign-plan.md 要求所有可点区域 ≥44px',
  );

  const BTN_GAP = 2;    // gap-0.5
  const need = 44 + BTN_GAP + 44;
  assert.ok(
    colPx >= need,
    `手机档右列 ${colPx}px < 需要的 ${need}px（44 + 2 + 44）—— 会溢出：`
    + '两个按钮都写了 flex-shrink-0，网格列装不下就是内容压出边界',
  );
});

// ---------- ② 歌曲行：手机档内边距不得放大左边缘偏差 ----------

check('歌曲行手机档行内边距不超过 4px（与页面 px-4 对齐用）', () => {
  const m = songRow.match(/items-center gap-3 (px-[\d.]+) lg:px-3/);
  assert.ok(
    m,
    'SongRow 的手机档行内边距应为 px-0~px-1 且带 lg:px-3（桌面保留 12px 以对齐表头）',
  );
  const pxClass = m[1];
  const allowed = ['px-0', 'px-1'];
  assert.ok(
    allowed.includes(pxClass),
    `手机档行内边距是 ${pxClass}，应为 ${allowed.join(' 或 ')}：`
    + '页面容器已有 px-4(16px)，行内再留 12px 会让列表封面起点变成 28px、'
    + '与页面主标题(16px)差 12px —— 同一屏两种左边距',
  );
});

// ---------- ③ 离线页行：按钮触控尺寸与列宽必须同步 ----------

const offline = readSrc('src/components/OfflineMusic.js');

check('离线页手机档按钮 44px 且列宽同步', () => {
  const colM = offline.match(/grid-cols-\[2rem_minmax\(0,1fr\)_([\d.]+rem)_([\d.]+rem)\]/);
  assert.ok(colM, '离线页找不到手机档 grid-cols 定义');
  const [c1, c2 = c1] = remsToPx([colM[1], colM[2]]);

  const btnM = offline.match(/flex flex-shrink-0 h-11 w-11[^"']*sm:h-10 sm:w-10/);
  assert.ok(
    btnM,
    '离线页行内按钮手机档应为 44px（h-11 w-11）、桌面 sm:h-10 sm:w-10',
  );

  assert.ok(
    c1 >= 44 && c2 >= 44,
    `离线页按钮列宽 ${c1}/${c2}px 装不下 44px 按钮 —— 列宽必须同步改`,
  );
});

// ---------- ④ 头图：手机/桌面两档尺寸必须唯一 ----------

check('CoverMosaic 头图尺寸只有一套定义（112 → 128）', () => {
  const mosaic = readSrc('src/components/CoverMosaic.js');
  assert.match(
    mosaic,
    /COVER_BOX_MOBILE\s*=\s*'w-28 h-28'/,
    'CoverMosaic 手机档头图应为 w-28 h-28(112px) —— 与手写头图保持一致',
  );
  assert.match(
    mosaic,
    /COVER_BOX_WIDE\s*=\s*'sm:w-32 sm:h-32'/,
    'CoverMosaic 桌面档头图应为 sm:w-32 sm:h-32(128px)',
  );

  // 手写头图（Download / PlaylistSongs / LocalMusic 专辑）必须同尺寸
  const handwritten = [
    'src/components/Download.js',
    'src/components/PlaylistSongs.js',
    'src/components/LocalMusic.js',
  ];
  for (const rel of handwritten) {
    const src = readSrc(rel);
    assert.match(
      src,
      /(?:h-28 w-28|w-28)[^"'`]*(?:sm:h-32 sm:w-32|sm:w-32)/,
      `${rel} 的手写头图必须与 CoverMosaic 同为 112px(手机)/128px(桌面)，`
      + '否则六个详情页翻动时头图会跳 16px',
    );
  }
});

// ---------- ⑤ 横滑卡片：宽度与内边距只有一处定义 ----------

check('横滑卡片宽度/内边距统一走 ui/mediaCard', () => {
  const card = readSrc('src/ui/mediaCard.js');
  assert.match(card, /MEDIA_CARD_ROW_WIDTH\s*=\s*'w-\[8\.5rem\] p-1\.5 sm:w-40 sm:p-2'/, 'mediaCard 的轮播宽度定义变了');
  assert.match(card, /MEDIA_CARD_GRID_WIDTH\s*=\s*'w-full p-1\.5 sm:p-2'/, 'mediaCard 的网格宽度定义变了');

  // 三个卡片组件都不得再手写宽度
  const users = [
    'src/components/HomeRecommendations.js',
    'src/components/Download.js',
    'src/components/SearchAlbumRow.js',
  ];
  for (const rel of users) {
    const src = readSrc(rel);
    assert.doesNotMatch(
      src,
      /className="[^"]*w-\[(?:8\.5|9)rem\][^"]*"/,
      `${rel} 仍有手写的卡片宽度类（应改用 ui/mediaCard）—— `
      + '两套宽度会让手指横向滑过时卡片"抖"一下',
    );
  }
});

// ---------- ⑥ 帮助页不得再有第二层内边距 ----------

check('帮助页不得在外层容器之上再叠 p-*', () => {
  const help = readSrc('src/components/HelpPage.js');
  assert.doesNotMatch(
    help,
    /className="container mx-auto p-\d/,
    '帮助页外层写了 container + p-6 —— App 的内容容器已有 px-4/px-6，'
    + '两层叠加后手机上左右内边距变成 40px，比其它页面窄一圈',
  );
});

// ---------- ⑦ 详情页头部统一走 DetailHeader ----------

check('六个详情页头部统一走 ui/DetailHeader', () => {
  const detailPages = [
    'src/components/Download.js',
    'src/components/PlaylistSongs.js',
    'src/components/MyPlaylist.js',
    'src/components/RecentlyPlayed.js',
    'src/components/LocalMusic.js',
    'src/components/OfflineMusic.js',
  ];
  const offenders = [];
  for (const rel of detailPages) {
    const src = readSrc(rel);
    assert.match(src, /import DetailHeader from '\.\.\/ui\/DetailHeader'/, `${rel} 未引入 DetailHeader`);
    // 不得再有手写的「封面 + flex-col」详情头部
    if (/<header className="mb-5 flex flex-col gap-4 sm:flex-row sm:items-end"/.test(src)) {
      offenders.push(rel);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `这些页面仍是手写的 flex-col 详情头部（手机上封面独占一整行，头部高约 342px）：\n  ${offenders.join('\n  ')}`,
  );

  // DetailHeader 的关键布局约束
  const dh = readSrc('src/ui/DetailHeader.js');
  assert.match(dh, /flex flex-wrap/, 'DetailHeader 手机档必须 flex-wrap（否则按钮挤不出整行）');
  assert.match(dh, /basis-full/, 'DetailHeader 操作区手机档必须 basis-full（否则不会换到整行）');
  assert.match(dh, /sm:grid/, 'DetailHeader 桌面档必须用 grid（保持改造前两行结构）');
  assert.match(dh, /sm:row-span-2/, 'DetailHeader 桌面档封面必须跨两行');
});

// ---------- ⑧ 安全区：底栏高度与 env() 必须走 token ----------

check('底栏高度/安全区必须走 token，不得各处硬编码', () => {
  const css = readSrc('src/index.css');

  // ① token 必须定义在主题块里（不能在 :root 之外另起，见下条）
  assert.match(css, /--mobile-tabbar-h:\s*3\.25rem;/, '缺少 --mobile-tabbar-h token');
  assert.match(css, /--mobile-miniplayer-h:\s*3\.875rem;/, '缺少 --mobile-miniplayer-h token');
  assert.match(
    css,
    /--safe-top:\s*var\(--safe-area-inset-top,\s*env\(safe-area-inset-top,\s*0px\)\)/,
    '--safe-top 必须写成 var(--safe-area-inset-*, env(..., 0px)) 两层回退 —— '
    + 'Capacitor 的 SystemBars 注入的是 --safe-area-inset-*，而浏览器原生只能读 env()，'
    + '只写一个来源在另一种形态下会取到 0',
  );

  // ② ★ 这条是本鱼第一次改红的真实教训：
  //    themeContract 用 extractBlock(css, ':root') 取**第一个** :root 块校验 44 个
  //    主题 token。若在主题块之外另起一个 `:root {`，它就会读到那个只有几个变量的块，
  //    报「缺 44 个 token」。所以断言：:root 只能出现一次（且是主题块那次）。
  const rootBlocks = [...css.matchAll(/^\s*:root\s*[,{]/gm)];
  assert.equal(
    rootBlocks.length,
    1,
    `index.css 出现了 ${rootBlocks.length} 个 \`:root\` 块。必须只有一个（且是主题变量块）—— `
    + 'themeContract 门禁用 extractBlock 取第一个 :root 校验 44 个 token，'
    + '另起一个会导致它读到残缺块并报「缺 44 个 token」',
  );

  // ③ .app-main 的移动档预留必须读 token，不能再写 3.25rem/3.875rem
  assert.match(
    css,
    /padding-bottom:\s*calc\(var\(--mobile-tabbar-h\)\s*\+\s*1\.5rem/,
    '.app-main 的移动档预留必须读 --mobile-tabbar-h（原先硬编码 3.25rem）',
  );
  assert.match(
    css,
    /padding-bottom:\s*calc\(var\(--mobile-tabbar-h\)\s*\+\s*var\(--mobile-miniplayer-h\)/,
    '.app-main--playing 的预留必须同时读两个 token（原先硬编码 3.25rem + 3.875rem）',
  );

  // ④ 源码里不得再有裸 env(safe-area-inset-*) 直接用于布局
  //    （允许出现在 token 定义那一行，因为那是唯一的来源）
  const offenders = [];
  for (const rel of ['src/components/Sidebar.js', 'src/contexts/PlayerContext.js', 'src/components/TopBar.js']) {
    const src = readSrc(rel);
    const lines = src.split(/\r?\n/);
    lines.forEach((line, i) => {
      if (!/env\(safe-area-inset-/.test(line)) return;
      if (/^\s*(\*|\/\/)/.test(line)) return;           // 注释
      offenders.push(`${rel}:${i + 1}  ${line.trim().slice(0, 70)}`);
    });
  }
  assert.deepEqual(
    offenders,
    [],
    `这些地方直接用了 env(safe-area-inset-*)，应改读 --safe-* token：\n  ${offenders.join('\n  ')}`,
  );
});

// ---------- ⑨ 顶栏必须处理顶部安全区 ----------

check('sticky 顶栏必须处理顶部安全区（Android 内容会顶到状态栏下）', () => {
  const topbar = readSrc('src/components/TopBar.js');
  assert.match(
    topbar,
    /safe-top-bar/,
    'TopBar 必须挂 .safe-top-bar 类（补 paddingTop: var(--safe-top)）—— '
    + 'Capacitor 的 SystemBars 在 WebView ≥ 140 且 viewport-fit=cover 时会把原生 padding 清零，'
    + '页面内容顶到状态栏下面，顶栏第一行会被压住',
  );
  // 不能改用内联 style 设左右 padding —— 会覆盖 md:px-6，桌面窄 8px
  assert.doesNotMatch(
    topbar,
    /style=\{\{[^}]*paddingLeft/,
    'TopBar 不得用内联 paddingLeft/Right —— 内联在所有断点生效，'
    + '会把 Tailwind 的 md:px-6(24px) 覆盖成 16px，桌面端窄 8px。用 .safe-top-bar 类里的断点',
  );

  const css = readSrc('src/index.css');
  assert.match(
    css,
    /\.safe-top-bar\s*\{[^}]*padding-top:\s*calc\(0\.75rem\s*\+\s*var\(--safe-top\)\)/,
    '.safe-top-bar 必须保留 padding-top: calc(0.75rem + var(--safe-top))'
    + '（0.75rem 是原 py-3 的上内边距，不能被吃掉）',
  );
  assert.match(
    css,
    /@media\s*\(min-width:\s*768px\)\s*\{\s*\.safe-top-bar/,
    '.safe-top-bar 必须有 md 断点，把左右内边距恢复成 1.5rem（对应 md:px-6）',
  );

  // 横屏刘海：左右安全区也要被真实使用
  assert.match(
    css,
    /--safe-left:\s*var\(--safe-area-inset-left/,
    '缺少 --safe-left：横屏时刘海会切掉内容左右边缘（本项目未锁竖屏）',
  );
  assert.match(
    css,
    /padding-left:\s*var\(--safe-left\)/,
    '.app-main 必须用 --safe-left —— 横屏刘海会切掉内容边缘',
  );
});

// ---------- 汇总 ----------

console.log('');
if (failures.length > 0) {
  console.error(`手机端排版契约测试失败（${failures.length} 项）`);
  process.exit(1);
}
console.log('手机端排版契约测试通过');
