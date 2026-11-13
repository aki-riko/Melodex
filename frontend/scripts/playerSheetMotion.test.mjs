import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SHEET_EXIT_MS,
  karaokeFillPercent,
  lyricScrollBehavior,
  prefersReducedMotion,
  sheetExitDelay,
} from '../src/contexts/playerSheetMotion.mjs';

const srcRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const css = readFileSync(resolve(srcRoot, 'index.css'), 'utf8');
const player = readFileSync(resolve(srcRoot, 'contexts', 'PlayerContext.js'), 'utf8');

// ---- 1. 歌词滚动:只有同一首歌里逐行推进才平滑 ----
const songA = { songKey: 'qq-1#36', visible: true };
assert.equal(lyricScrollBehavior(null, { songKey: 'qq-1#36', visible: false }), null, '歌词不可见时不滚动');
assert.equal(lyricScrollBehavior(null, songA), 'auto', '首次出现必须瞬移 —— 否则从第一行一路滑到当前行');
assert.equal(lyricScrollBehavior({ ...songA, visible: false }, songA), 'auto', '封面切回歌词 / 重新展开必须瞬移');
assert.equal(lyricScrollBehavior(songA, songA), 'smooth', '同一首里逐行推进应平滑');
assert.equal(lyricScrollBehavior(songA, { songKey: 'qq-2#40', visible: true }), 'auto', '换歌必须瞬移');
// 换歌时歌词先清空再异步填上:key 带行数,"填上"那一刻也要瞬移
assert.equal(
  lyricScrollBehavior({ songKey: 'qq-2#0', visible: true }, { songKey: 'qq-2#40', visible: true }),
  'auto',
  '歌词异步加载完成时必须瞬移,不能当成逐行推进',
);
// 组件里的快照 key 必须真的带上歌词行数,否则上面那条规则拿不到区分依据
assert.match(player, /lyricSnapshotKey = `\$\{curKey\}#\$\{lrc\.length\}`/, '歌词快照 key 必须包含歌词行数');
assert.ok(!/scrollIntoView\(\{\s*behavior:\s*'smooth'/.test(player), '歌词滚动不得再写死 smooth');

// ---- 2. 逐字填色进度 ----
const word = { t: 10, end: 12, s: '晴' };
assert.equal(karaokeFillPercent(word, 9), 0, '未开始 = 0');
assert.equal(karaokeFillPercent(word, 10), 0, '刚好开始 = 0');
assert.equal(karaokeFillPercent(word, 11), 50, '唱到一半 = 50');
assert.equal(karaokeFillPercent(word, 12), 100, '唱完 = 100');
assert.equal(karaokeFillPercent(word, 99), 100, '之后一直是 100');
assert.equal(karaokeFillPercent({ t: 10, end: 10 }, 11), 100, '零时长字:过了就是唱完');
assert.equal(karaokeFillPercent({ t: 10, end: 10 }, 9), 0, '零时长字:没到就是未唱');
assert.equal(karaokeFillPercent(null, 5), 0, '异常输入不抛异常');
assert.equal(karaokeFillPercent(word, NaN), 0, '进度未知按未唱处理');

// 填色走 background-position(可过渡),组件与样式两边必须对上
assert.match(css, /\.karaoke-word\s*\{[^}]*background-size:\s*200% 100%/, '.karaoke-word 需要 200% 宽的双色渐变');
assert.match(css, /\.karaoke-word\s*\{[^}]*transition:\s*background-position/, '.karaoke-word 必须过渡 background-position,否则 4Hz 上报下填色会一格一格跳');
assert.match(player, /backgroundPosition: `\$\{100 - karaokeFillPercent\(w, cur\)\}% 0`/, 'KaraokeLine 必须用 100-进度 作为背景位置(100%=未唱,0%=唱完)');

// ---- 3. 收起时长:JS 定时器与 CSS 动画必须一致 ----
const exitCss = css.match(/\.player-sheet-exit\s*\{\s*animation:\s*player-slide-down\s+([\d.]+)(ms|s)/);
assert.ok(exitCss, '找不到 .player-sheet-exit 的动画时长');
const exitCssMs = exitCss[2] === 's' ? Math.round(Number(exitCss[1]) * 1000) : Number(exitCss[1]);
assert.equal(exitCssMs, SHEET_EXIT_MS, `CSS 收起动画 ${exitCssMs}ms 与 SHEET_EXIT_MS ${SHEET_EXIT_MS}ms 不一致`);
assert.ok(!/setTimeout\([^)]*,\s*260\)/.test(player), 'PlayerContext 里不得再写死 260,统一用 sheetExitDelay');
assert.equal(sheetExitDelay(false), SHEET_EXIT_MS);
assert.equal(sheetExitDelay(true), 0, 'reduced-motion 下应立即卸载');
assert.equal(prefersReducedMotion(), false, '非浏览器环境视为未开启');

// ---- 4. 歌词行:当前行不得靠换字号放大(会重排、行高跳动、居中位置偏移) ----
const lyricLines = [...player.matchAll(/className="(player-lyric-line[^"]*)"/g)].map((m) => m[1]);
assert.equal(lyricLines.length, 2, '移动端与桌面端各一处歌词行');
for (const cls of lyricLines) {
  assert.ok(!/\$\{/.test(cls), `歌词行 className 不得按当前行切换(${cls}),当前行由 data-active 驱动`);
}
assert.ok(!/i === lyricIdx \? 'text-(xl|base)/.test(player), '当前行不得切换字号类');
assert.match(css, /\.player-lyric-line\[data-active="true"\]\s*\{[^}]*transform:\s*scale\(1\)/, '当前行应通过 transform 放大');
{
  const block = css.match(/\.player-lyric-line\s*\{([^}]*)\}/);
  assert.ok(block, '缺少 .player-lyric-line');
  assert.ok(!/transition:[^;]*\b(all|font-size|height)\b/.test(block[1]), '歌词行不得过渡 all/font-size/height');
}

// ---- 5. 心形弹跳只在用户点亮时播放 ----
assert.match(player, /if \(!prev\) setFavPulse\(\(n\) => n \+ 1\)/, '只有"未收藏→收藏"才累加弹跳计数');
assert.match(player, /favPulse \? 'fluent-heart-pop' : ''/, '计数为 0(换歌/刚打开)时不得挂弹跳类');

console.log('player sheet motion tests passed');
