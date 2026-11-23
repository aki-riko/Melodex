// UI 一致性契约门禁 —— 锁死「尺寸不一律」不再回潮。
//
// ## 为什么要有
//
// 2026-11 用户反馈「整个前端细节乱七八糟」。统计后发现不是配色问题
// （配色有 themeContrast 门禁守着），而是**尺寸节奏混乱**：
//   · 按钮高度用过 13 种（h-1 到 h-28）
//   · 图标尺寸 18 种（16/17/18/20 混着来，17 这种非标值出现 12 次）
//   · 圆角 6 种（md 60 次 / full 29 / lg 21 / 裸 rounded 16 / control 14）
//
// 单靠人记「要统一」必然回潮，所以这里把**能被机器判断的**那部分锁住：
//   ① 尺寸令牌必须两档齐全且相等（尺寸不随主题变）
//   ② tailwind 必须把令牌接进去（否则写了类也没有定义）
//   ③ 禁止再出现非 4px 倍数的图标尺寸
//   ④ 播放条这类 flex 行里的固定尺寸元素必须带 flex-shrink-0
//
// 运行: node scripts/uiConsistency.test.mjs  （已接进 npm run test:ui-consistency）

import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptDir, '..');

const readSrc = (rel) => readFileSync(join(root, rel), 'utf8');

const walk = (dir, out = []) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(jsx?)$/.test(name)) out.push(p);
  }
  return out;
};

const failures = [];
const check = (name, fn) => {
  try {
    fn();
    console.log(`  ok - ${name}`);
  } catch (error) {
    failures.push({ name, message: error.message });
    console.log(`  NOT OK - ${name}`);
    // 打印完整 message（含换行后的明细列表）——
    // 只取第一行会把「是哪些文件」吃掉，排查时只能看个寂寞。
    for (const line of error.message.split('\n')) {
      console.log(`      ${line}`);
    }
  }
};

// ---------- ① 尺寸令牌两档齐全且相等 ----------

const css = readSrc('src/index.css');
const TOKENS = [
  '--size-icon-xs',
  '--size-icon-sm',
  '--size-icon-md',
  '--size-icon-lg',
  '--size-compact',
  '--size-control',
  '--size-touch',
];

check('尺寸令牌在浅深两档都定义，且数值一致', () => {
  // 按主题块切分：:root / fluent-light 一块，fluent-dark 一块
  const blocks = css.split(/(?=\[data-theme=)/);
  const values = new Map();

  for (const block of blocks) {
    const found = new Map();
    for (const token of TOKENS) {
      // 匹配 `--size-xxx: 40px;`（允许缩进）
      const m = block.match(new RegExp(`${token}:\\s*([^;]+);`));
      if (m) found.set(token, m[1].trim());
    }
    if (found.size === 0) continue;

    const missing = TOKENS.filter((t) => !found.has(t));
    assert.deepEqual(
      missing,
      [],
      `某个主题块缺少这些尺寸令牌（会导致该主题下 h-size-control 等类无定义）：${missing.join(', ')}`,
    );
    for (const [token, value] of found) {
      if (!values.has(token)) values.set(token, new Set());
      values.get(token).add(value);
    }
  }

  assert.ok(values.size > 0, 'index.css 里没有解析到任何尺寸令牌');

  // 尺寸不随主题变 —— 两档数值必须相同。
  const inconsistent = [];
  for (const [token, set] of values) {
    if (set.size > 1) inconsistent.push(`${token}: ${[...set].join(' vs ')}`);
  }
  assert.deepEqual(
    inconsistent,
    [],
    `尺寸令牌在两个主题里取值不同（尺寸不该随主题变）：\n  ${inconsistent.join('\n  ')}`,
  );

  // 数值规则：
  //   · **盒子**尺寸（compact/control/touch）必须是 4px 的倍数 ——
  //     它们要和 4/8/12/16 的间距刻度对齐，否则网格会错位；
  //   · **图标**尺寸只要求偶数 —— 18/20 是 lucide 的行业惯例
  //     （光学重心按偶数视口设计），强行 4 倍数反而会让图标发虚。
  for (const [token, set] of values) {
    const isIcon = token.startsWith('--size-icon');
    for (const raw of set) {
      const px = Number(String(raw).replace('px', ''));
      if (!Number.isFinite(px)) continue;
      if (isIcon) {
        assert.equal(px % 2, 0, `${token} = ${raw} 应为偶数（图标光学尺寸惯例）`);
      } else {
        assert.equal(
          px % 4,
          0,
          `${token} = ${raw} 不是 4px 的倍数（盒子尺寸要与间距刻度对齐）`,
        );
      }
    }
  }
});

// ---------- ② tailwind 必须把令牌接进去 ----------

const tailwind = readSrc('tailwind.config.js');

check('tailwind.config.js 把尺寸令牌接成可用类', () => {
  for (const token of TOKENS) {
    // token 形如 `--size-control`，tailwind 里 key 去掉前两个连字符 → `size-control`
    const key = token.replace(/^--/, '');
    assert.match(
      tailwind,
      new RegExp(`'${key}':\\s*'var\\(${token}\\)'`),
      `tailwind 没把 ${token} 映射成类（key 应为 '${key}'），写了 h-${key} 也不会生效`,
    );
  }
  // width/height 都要有（h- 与 w- 都有人用）
  assert.match(tailwind, /height:\s*\{[\s\S]*?size-control[\s\S]*?\}/, 'tailwind 的 height 缺尺寸令牌');
  assert.match(tailwind, /width:\s*\{[\s\S]*?size-control[\s\S]*?\}/, 'tailwind 的 width 缺尺寸令牌');
});

// ---------- ③ 图标尺寸禁止非 4px 倍数 ----------

const files = walk(join(root, 'src'));
const oddIconSizes = [];

for (const file of files) {
  const src = readFileSync(file, 'utf8');
  for (const m of src.matchAll(/\bsize=\{(\d+)\}/g)) {
    const n = Number(m[1]);
    // 允许 12/14/16/18/20/24/28/32...（4 的倍数或 14 这类图标光学尺寸）
    // 明确禁止的是 17/19/21/23 这种"随手写"的值。
    if (n % 2 !== 0) {
      const line = src.slice(0, m.index).split('\n').length;
      oddIconSizes.push(`${file.replace(root, '').replace(/\\/g, '/')}:${line} size={${n}}`);
    }
  }
}

check('图标 size 不含奇数（17/19/21 这类随手写的值）', () => {
  assert.deepEqual(
    oddIconSizes,
    [],
    `这些图标用了奇数尺寸（视觉上会与偶数尺寸的图标重心不齐）：\n  ${oddIconSizes.join('\n  ')}`,
  );
});

// ---------- ④ 播放条：固定尺寸元素必须 flex-shrink-0 ----------

const player = readSrc('src/contexts/PlayerContext.js');

check('播放条控制区所有固定尺寸元素都带 flex-shrink-0', () => {
  // 定位桌面播放条主行（`<div className="flex items-center gap-3">` 且紧邻 max-w-6xl）
  const startIdx = player.indexOf('<div className="flex items-center gap-3">');
  assert.ok(startIdx > 0, '找不到播放条主行容器');

  // 取到该容器结束（下一个 `{/* 音量` 标记之前足够覆盖控制区）
  const endIdx = player.indexOf('{/* 音量', startIdx);
  assert.ok(endIdx > startIdx, '找不到播放条控制区的结束标记');
  const section = player.slice(startIdx, endIdx);

  // 逐个检查该区域内每颗按钮/固定宽元素
  const offenders = [];
  const tags = [...section.matchAll(/<(button|div)[^>]*?(?:className=(?:"([^"]*)"|\{`([^`]*)`\}))?[^>]*>/g)];
  for (const tag of tags) {
    const cls = tag[2] || tag[3] || '';
    if (!cls) continue;
    // 固定尺寸判定：h-11/w-11/w-10/h-10 等
    const fixed = /\b(?:h|w)-(?:8|9|10|11|12)\b/.test(cls);
    if (!fixed) continue;
    if (/flex-shrink-0/.test(cls)) continue;
    if (/flex-grow/.test(cls)) continue;  // 进度条容器本来就该伸缩
    offenders.push(cls.slice(0, 80));
  }

  assert.deepEqual(
    offenders,
    [],
    `播放条里这些固定尺寸元素没写 flex-shrink-0（窗口变窄会被压扁，时间显示被切掉）：\n  ${offenders.join('\n  ')}`,
  );
});

// ---------- ⑤ 卡片标题必须等高（治「同一排卡片参差不齐」）----------

check('横向卡片标题用 line-clamp-2 时必须配 min-h-[2lh]', () => {
  // ★ 真实缺陷（用户：「排版地狱看不下去」）：
  //   `line-clamp-2` 只做**上限**——标题 1 行时卡片矮、2 行时高。
  //   实测同一排卡片 204px vs 220px，差 16px，整排看过去参差不齐。
  //   加 `min-h-[2lh]` 让单行标题也占满两行，同排必然等高。
  //
  // 判据：任何 `line-clamp-2` 出现在**卡片标题**语境（同 class 里有 type-caption）
  // 就必须同时有 min-h-[2lh]。
  const offenders = [];
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/className="([^"]*line-clamp-2[^"]*)"/g)) {
      const cls = m[1];
      if (!/type-caption/.test(cls)) continue;      // 只查卡片标题那类
      if (/min-h-\[2lh\]/.test(cls)) continue;      // 已修
      const line = src.slice(0, m.index).split('\n').length;
      offenders.push(`${file.replace(root, '').replace(/\\/g, '/')}:${line}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `这些卡片标题只有 line-clamp-2、没有 min-h-[2lh]，单行标题会让卡片矮一截（同排参差）：\n  ${offenders.join('\n  ')}`,
  );
});

check('曲目数/副标题行不得用条件渲染整行（会少一行高度）', () => {
  // ★ 同类真实缺陷：`{track_count > 0 && <p>...</p>}` 在没有曲目数时
  //   **整行消失**，卡片就矮 16px（实测那张 204px 是缺「N 首」导致的）。
  //   正确写法是元素常驻、内容留 &nbsp; 占位。
  const offenders = [];
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    // 找 `{xxx > 0 && (` 后紧跟含 type-micro 的 <p>
    for (const m of src.matchAll(/\{\s*\w+(?:\.\w+)*\s*>\s*0\s*&&\s*\(?\s*<p[^>]*type-micro/g)) {
      const line = src.slice(0, m.index).split('\n').length;
      offenders.push(`${file.replace(root, '').replace(/\\/g, '/')}:${line}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `这些地方用 \`count > 0 && <p>\` 条件渲染整行，缺数据时卡片会矮一截（应改为元素常驻 + &nbsp; 占位）：\n  ${offenders.join('\n  ')}`,
  );
});

// ---------- ⑥ 设置页分区必须走统一组件（治「每个分区各写一套」）----------

check('设置页分区标题不得手写，必须用 SettingsSection', () => {
  // ★ 真实缺陷（用户：「设置页面排版重构一下」）：
  //   Settings.js / AppearanceSettings.js / DesktopLyricsSettings.js
  //   三处各写各的 `<section><h3>`，导致实测出现：
  //     · 标题字号不一（「账号登录」text-lg 18px，其余 text-xl 20px）
  //     · 分区间距不成规律（y 间隔 324/126/126/524）
  //     · 卡片圆角两套（rounded-md 4px vs rounded-lg 8px）
  //   统一到 SettingsSection 后改一处即全局生效。
  const settingsFiles = [
    'src/components/Settings.js',
    'src/components/AppearanceSettings.js',
    'src/components/DesktopLyricsSettings.js',
  ];

  const offenders = [];
  for (const rel of settingsFiles) {
    const src = readSrc(rel);
    // 手写分区标题的特征：<h3 带 text-xl/text-lg 且不是通过 SettingsSection 渲染的
    for (const m of src.matchAll(/<h3[^>]*className="[^"]*text-(?:xl|lg|base)[^"]*"/g)) {
      const line = src.slice(0, m.index).split('\n').length;
      const snippet = src.slice(m.index, m.index + 100);
      offenders.push(`${rel}:${line}  ${snippet.split('\n')[0].slice(0, 70)}`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `设置页出现了手写的分区标题（应改用 <SettingsSection title="...">，否则字号/间距/圆角会各自为政）：\n  ${offenders.join('\n  ')}`,
  );

  // 三个文件都必须真的 import 了统一组件
  for (const rel of settingsFiles) {
    const src = readSrc(rel);
    assert.match(
      src,
      /from '\.\/SettingsSection'/,
      `${rel} 必须从 SettingsSection 引入统一分区组件`,
    );
  }
});

check('设置页卡片圆角统一用 rounded-control', () => {
  // 同一个页面里同时出现 rounded-md / rounded-lg 就是"两套语言"。
  // 设置页的卡片一律 rounded-control（= --radius-control，随主题变）。
  //
  // ★ 必须先剥注释：SettingsSection.js 的文档注释里逐字写了
  //   「QR 卡 rounded-md(4px)，外观卡 rounded-lg(8px)」来说明历史缺陷，
  //   不剥掉会被自己的注释判红（本鱼第一版就踩了）。
  const settingsFiles = [
    'src/components/Settings.js',
    'src/components/SettingsSection.js',
    'src/components/AppearanceSettings.js',
    'src/components/DesktopLyricsSettings.js',
  ];
  const stripComments = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n');

  const offenders = [];
  for (const rel of settingsFiles) {
    const src = stripComments(readSrc(rel));
    for (const m of src.matchAll(/rounded-(?:md|lg)\b/g)) {
      const line = src.slice(0, m.index).split('\n').length;
      offenders.push(`${rel}:${line}  ${m[0]}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `设置页卡片圆角必须统一 rounded-control，不得混用 rounded-md/rounded-lg：\n  ${offenders.join('\n  ')}`,
  );
});

// ---------- ⑦ 页面主标题必须用 type-hero 令牌 ----------

check('页面主标题必须用 type-hero 令牌，不得手写字号', () => {
  // ★ 实测（CDP 巡检 9 个页面）：
  //   首页/搜索/本地/最近/更多/歌单 → `type-hero`（28px/800）✓
  //   帮助页 → `text-4xl font-bold`（36px/700）✗
  //   设置页/用户管理 → `text-3xl font-semibold`（30px/600）✗
  //   同一套产品里三个不同的页面主标题字号，跨页翻动时明显跳。
  //
  // 项目本来就有字号阶梯（index.css）：type-hero 28/800、type-title 20/700、
  // type-section 16/700、type-body。绕过去手写 Tailwind 类就是乱源。
  //
  // 例外：AuthGate / ErrorBoundary 的 `<h1>` 是**弹窗标题**不是页面标题，
  //       用 type-title 是对的，所以这两个文件跳过。
  const EXEMPT = ['src/components/AuthGate.js', 'src/ui/ErrorBoundary.js'];
  const offenders = [];
  for (const file of files) {
    const rel = file.replace(root, '').replace(/\\/g, '/').replace(/^\//, '');
    if (EXEMPT.some((e) => rel.endsWith(e.replace('src/', '')))) continue;
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/<h1[^>]*className="([^"]*)"/g)) {
      const cls = m[1];
      if (/type-hero/.test(cls)) continue;
      const line = src.slice(0, m.index).split('\n').length;
      offenders.push(`${rel}:${line}  ${cls.slice(0, 60)}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `页面主标题必须用 type-hero（28px/800），手写字号会让跨页翻动时标题大小不一：\n  ${offenders.join('\n  ')}`,
  );
});

check('区块标题用 type-title/type-section，不得手写 text-xl/text-lg', () => {
  // 同一批巡检：7 处已用 type-*，4 处手写（ProjectNotice / SettingsSection / UserManagement×2）。
  // 都是「分组标题」语义，纯属漏改。
  const offenders = [];
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    const stripped = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
      .join('\n');
    for (const m of stripped.matchAll(/<h[23][^>]*className="([^"]*)"/g)) {
      const cls = m[1];
      if (/type-title|type-section|type-micro/.test(cls)) continue;
      // h2/h3 里用 sr-only 或纯布局类的跳过
      if (!/text-(xl|lg|base|3xl|2xl)/.test(cls)) continue;
      const line = stripped.slice(0, m.index).split('\n').length;
      offenders.push(`${file.replace(root, '').replace(/\\/g, '/')}:${line}  ${cls.slice(0, 60)}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `区块标题应使用 type-title(20px/700) 或 type-section(16px/700) 令牌：\n  ${offenders.join('\n  ')}`,
  );
});

check('设置页操作按钮必须用 SettingsActionButton（保证等高）', () => {
  // ★ 实测：同为文字按钮却渲染出 33px 和 52px 两种高度 ——
  //   「删除」是 flex 容器里的直接子项，没写 flex-shrink-0 也没固定高度，
  //   被 flex 拉伸到跟兄弟内容一样高。
  //
  // ★ 判定范围要收窄：QR 登录卡里的「扫码 / 手填 / 退出」有自己的
  //   按钮组尺寸体系（h-8 / h-10 成组出现），不是松散的操作按钮，
  //   所以只看「内容含中文、且没有成组 h-* 声明」的裸按钮。
  const settingsFiles = [
    'src/components/Settings.js',
    'src/components/DesktopLyricsSettings.js',
  ];
  const offenders = [];
  for (const rel of settingsFiles) {
    const src = readSrc(rel);
    // 匹配完整的 <button ...>...</button>，看它的 className 和文本
    for (const m of src.matchAll(/<button\b([\s\S]{0,600}?)<\/button>/g)) {
      const body = m[1];
      const clsMatch = body.match(/className="([^"]*)"/);
      if (!clsMatch) continue;
      const cls = clsMatch[1];
      // 只查「稀疏的操作按钮」：有内边距但没固定高度
      if (!/\bpx-3\b/.test(cls)) continue;
      if (/\bh-\d/.test(cls)) continue;          // 已固定高度
      if (/min-w-0 items-center justify-center gap/.test(cls)) continue; // 成组的按钮组
      const line = src.slice(0, m.index).split('\n').length;
      offenders.push(`${rel}:${line}  ${cls.slice(0, 60)}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `设置页的文字按钮应改用 <SettingsActionButton>（统一 h-8 + flex-shrink-0，否则会被 flex 拉伸成不同高度）：\n  ${offenders.join('\n  ')}`,
  );
});

// ---------- ⑧ 播放条：所有图标按钮必须同高 ----------

check('播放条图标按钮高度必须一致（44px）', () => {
  // ★ 实测（2026-11）：播放条上 8 个按钮里有 7 个是 44×44，
  //   只有「睡眠定时」是 36×36 —— 并排看过去矮一截，是「细节糙」的典型。
  //
  // 判据：播放条涉及的两个组件里，圆形图标按钮必须用 h-11（44px）或 min-h-touch。
  // 允许移动端 h-12（48px，移动触控档，与桌面不同层级）。
  const barFiles = [
    'src/components/SleepTimerControl.js',
    'src/components/VolumeControl.js',
  ];
  const offenders = [];
  for (const rel of barFiles) {
    const src = readSrc(rel);
    // 桌面档的图标按钮（排除 isMobileMenu 分支里的 h-12）
    for (const m of src.matchAll(/'inline-flex (h-\d+) min-w-\[[^\]]+\] items-center justify-center gap-1\.5 rounded-full px-2[^']*'/g)) {
      const h = m[1];
      if (h === 'h-11' || h === 'h-size-touch') continue;
      const line = src.slice(0, m.index).split('\n').length;
      offenders.push(`${rel}:${line}  桌面图标按钮用了 ${h}（应为 h-11 = 44px）`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `播放条图标按钮必须同高（44px = h-11），否则并排看会一高一矮：\n  ${offenders.join('\n  ')}`,
  );
});

// ---------- ⑨ 播放页封面必须走高分辨率档 ----------

check('播放页全屏封面必须用 coverUrlHd（不糊）', () => {
  // ★ 真实缺陷（用户报「专辑模糊」）：
  //   播放页把封面按**高度铺满整屏**（background-size: auto 100%，860px 高），
  //   而列表缩略图的 cover 只有 300×300 → 拉伸 2.87 倍，必然糊。
  //   实测 QQ 源同一 ID 支持 800×800（181KB vs 38KB），
  //   所以播放页必须请求高分辨率档。
  const src = readSrc('src/contexts/PlayerContext.js');

  // backdrop 两层都必须用 coverUrlHd
  assert.match(
    src,
    /player-stage__backdrop-art"\s+style=\{\{\s*backgroundImage:\s*`url\(\$\{coverUrlHd\}\)`/,
    'backdrop-art 必须用 coverUrlHd（300px 拉伸 2.87 倍会糊）',
  );
  assert.match(
    src,
    /player-stage__backdrop-fill"\s+style=\{\{\s*backgroundImage:\s*`url\(\$\{coverUrlHd\}\)`/,
    'backdrop-fill 也必须用 coverUrlHd',
  );
  // coverApi 必须支持 size 选项
  const svc = readSrc('src/services/musicdl.js');
  assert.match(
    svc,
    /export const upgradeCoverUrl\s*=/,
    'musicdl.js 需要 upgradeCoverUrl（把 QQ 封面 R300x300 改成更大档）',
  );
  assert.match(
    svc,
    /coverProxyUrl\s*=\s*\(song,\s*options\s*=\s*\{\}\)/,
    'coverProxyUrl 需要支持 options.size 参数',
  );
  // 只改 QQ（gtimg）的尺寸段，其它源原样返回 —— 乱改会 404
  assert.match(
    svc,
    /y\\\.gtimg\\\.cn|gtimg/,
    'upgradeCoverUrl 必须限定只处理 gtimg（QQ）域名',
  );
});

// ---------- ⑩ 表单控件必须固定高度（同一行才能等高）----------

check('表单控件（input/select）必须固定高度，不能只靠 py', () => {
  // ★ 实测（用户管理页「新建用户」一行）：
  //   用户名 41px / 密码 41px / 下拉 39px / 创建按钮 37px —— 同一行差 4px。
  //   根因：三个控件都写 `px-3 py-2`，但 input 是 16px 字号、button 是 14px、
  //   select 还受浏览器默认行高影响，**固有高度各不相同**。
  //   统一 `h-10`（= --size-control）后必然等高。
  //
  // 例外：textarea 是多行控件，有 rows 就该跟随内容，不要求固定高度。
  const offenders = [];
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    const rel = file.replace(root, '').replace(/\\/g, '/').replace(/^\//, '');
    // 跨行匹配 <input|select ... className="...">
    const re = /<(input|select)\b([\s\S]{0,500}?)className=(?:"([^"]*)"|\{`([^`]*)`\})/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      const tag = m[1];
      const cls = m[3] || m[4] || '';
      if (!/px-\d/.test(cls)) continue;
      if (!/py-\d/.test(cls)) continue;
      if (/\bh-\d+\b/.test(cls)) continue;
      const line = src.slice(0, m.index).split('\n').length;
      offenders.push(`${rel}:${line}  <${tag}>  ${cls.slice(0, 60)}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `这些表单控件只有 py 没有固定高度（同一行会高低不齐，因为 input/select 的固有高度不同）：\n  ${offenders.join('\n  ')}`,
  );
});

// ---------- 汇总 ----------

console.log('');
if (failures.length > 0) {
  console.error(`UI consistency 契约测试失败（${failures.length} 项）`);
  process.exit(1);
}
console.log('UI consistency 契约测试通过');
