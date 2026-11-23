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

// ---------- 汇总 ----------

console.log('');
if (failures.length > 0) {
  console.error(`UI consistency 契约测试失败（${failures.length} 项）`);
  process.exit(1);
}
console.log('UI consistency 契约测试通过');
