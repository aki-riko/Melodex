// 播放器 Context 拆分契约(2026-11 全库扫描后新增)。
//
// 为什么要有:PlayerContext 原本把 progress 混在控制面 value 里,而 <audio> 的
// timeupdate 约 4Hz 触发 setProgress —— 于是**每一次进度心跳都让所有 usePlayer()
// 消费者重渲染**。实测所有页面级消费者(App / Download / LocalMusic / MyPlaylist /
// PlaylistSongs / RecentlyPlayed / OfflineMusic)一个都不读 progress,它们纯粹在白跑。
//
// 这类回归静态检查能拦住,运行时却很难发现(界面看起来完全正常,只是 CPU 白烧),
// 所以在这里锁死。运行: node scripts/playerRenderBudget.test.mjs

import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const frontendRoot = resolve(scriptDir, '..');
const srcRoot = resolve(frontendRoot, 'src');

const read = (rel) => readFileSync(resolve(frontendRoot, rel), 'utf8');
const walk = (dir, out = []) => {
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) walk(abs, out);
    else if (/\.(js|jsx)$/.test(entry)) out.push(abs);
  }
  return out;
};

const playerContextPath = 'src/contexts/PlayerContext.js';
const playerContext = read(playerContextPath);

// ---- 1. 控制面 value 必须被 useMemo 包住 ----
assert.ok(
  /const controlValue = useMemo\(/.test(playerContext),
  'PlayerContext 的控制面 value 必须用 useMemo 包:渲染期内联对象会让所有消费者每次都重渲染',
);
assert.ok(
  /PlayerContext\.Provider value=\{controlValue\}/.test(playerContext),
  'PlayerContext.Provider 必须绑定稳定化的 controlValue,不能退回内联对象字面量',
);
assert.doesNotMatch(
  playerContext,
  /PlayerContext\.Provider value=\{\{/,
  '不得退回「渲染期内联 value={{...}}」写法 —— 那正是本次修复的根因',
);

// ---- 2. progress 必须走独立的 Provider,且不得出现在控制面 value 里 ----
assert.ok(
  /const PlayerProgressContext = createContext\(null\)/.test(playerContext),
  '必须存在独立的 PlayerProgressContext',
);
assert.ok(
  /export const usePlayerProgress = \(\) =>/.test(playerContext),
  '必须导出 usePlayerProgress 供逐帧组件订阅',
);
assert.ok(
  /<PlayerProgressContext\.Provider value=\{progressValue\}>/.test(playerContext),
  '必须用 PlayerProgressContext.Provider 包住子树',
);

// 抓 controlValue 的 useMemo 调用块,断言其中不含裸 progress 字段。
const controlBlockStart = playerContext.indexOf('const controlValue = useMemo(');
assert.ok(controlBlockStart > -1, '找不到 controlValue 定义');
// 深度配平地找 useMemo(...) 的结束位置。
let depth = 0;
let controlBlockEnd = -1;
for (let i = controlBlockStart; i < playerContext.length; i += 1) {
  const ch = playerContext[i];
  if (ch === '(') depth += 1;
  else if (ch === ')') {
    depth -= 1;
    if (depth === 0) { controlBlockEnd = i; break; }
  }
}
assert.ok(controlBlockEnd > controlBlockStart, '无法解析 controlValue 的作用域');
const controlBlock = playerContext.slice(controlBlockStart, controlBlockEnd);
assert.doesNotMatch(
  controlBlock,
  /(^|[\s{,])(progress|setProgress)\s*[,:]/,
  'progress/setProgress 不得出现在控制面 value 里 —— 它们属于 PlayerProgressContext',
);
assert.match(
  controlBlock,
  /isPlaying:\s*\(/,
  'isPlaying 仍在控制面(它是稳定语义);若挪走请同步修改本门禁并说明理由',
);

// ---- 3. 进度 Provider 的 value 必须依赖 progress,且只装进度相关字段 ----
assert.match(
  playerContext,
  /const progressValue = useMemo\(\s*\(\) => \(\{ progress, setIsPaused, setProgress \}\),\s*\[progress\],?\s*\)/,
  'progressValue 必须只含 { progress, setIsPaused, setProgress } 且依赖 [progress]',
);

// ---- 4. 除 PlayerBar 外,任何组件不得从 usePlayer() 解构 progress ----
const offenders = [];
for (const file of walk(srcRoot)) {
  const rel = relative(frontendRoot, file).replace(/\\/g, '/');
  const source = readFileSync(file, 'utf8');
  // 找 usePlayer() 的解构语句(支持多行)
  const matches = source.matchAll(/=\s*usePlayer\(\)/g);
  for (const m of matches) {
    // 往前找到解构起点:const { ... } = usePlayer()
    const before = source.slice(Math.max(0, m.index - 800), m.index);
    const open = before.lastIndexOf('{');
    if (open === -1) continue;
    const destructured = before.slice(open);
    if (/(^|[\s{,])(progress|setProgress|setIsPaused)\b/.test(destructured)) {
      offenders.push(rel);
    }
  }
}
assert.deepEqual(
  offenders,
  [],
  `除 PlayerBar(在 PlayerContext.js 内、直接解构 usePlayerProgress)外,不得有组件从`
  + ` usePlayer() 解构 progress/setProgress/setIsPaused;违规文件: ${offenders.join(', ') || '(无)'}。`
  + ' 需要逐帧数据的组件请改用 usePlayerProgress()。',
);

// ---- 5. 原生 Provider 必须同样拆分(否则安卓端仍会 4Hz 全树重渲染) ----
const nativeProvider = read('src/contexts/NativePlayerProvider.js');
assert.ok(
  /const controlValue = useMemo\(/.test(nativeProvider),
  'NativePlayerProvider 的控制面 value 也必须 useMemo 稳定化',
);
assert.ok(
  /progressContext:\s*PlayerProgressContext/.test(nativeProvider),
  'NativePlayerProvider 必须接收 progressContext 并在内部提供 PlayerProgressContext',
);
assert.doesNotMatch(
  nativeProvider,
  /PlayerContext\.Provider value=\{\{/,
  'NativePlayerProvider 不得退回内联 value={{...}} 写法',
);

// ---- 6. 列表行必须被 memo 包住(否则上面的拆分收益会被行级重渲染吃掉) ----
const songRow = read('src/components/SongRow.js');
assert.match(
  songRow,
  /export default memo\(SongRow,\s*sameRowProps\)/,
  'SongRow 必须用 memo + 自定义比较导出:长列表(600+ 行)不该因父级无关状态变化而整列重绘',
);

// ---- 7. SongRow 消费的 Context value 必须稳定,否则 memo 形同虚设 ----
for (const [file, hint] of [
  ['src/contexts/CollectionsContext.js', 'collections'],
  ['src/contexts/FeedbackContext.js', 'feedback'],
]) {
  const source = read(file);
  assert.match(
    source,
    /const value = useMemo\(/,
    `${file} 的 context value 必须 useMemo 稳定化 —— SongRow 依赖 ${hint},不稳定的 value 会让 memo 完全失效`,
  );
  assert.doesNotMatch(
    source,
    /Provider value=\{\{/,
    `${file} 不得使用渲染期内联 value 对象`,
  );
}

console.log(
  '播放器渲染预算契约通过:控制面 value 已稳定化、progress 独立 Context 且仅 PlayerBar 订阅、'
  + '原生 Provider 同步拆分、SongRow 已 memo 且其依赖的 Context value 稳定。',
);
