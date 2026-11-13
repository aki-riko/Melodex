import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AXIS_LOCK_PX,
  COMMIT_MIN_PX,
  MARQUEE_PAUSE_RATIO,
  MARQUEE_SPEED_PX_PER_S,
  SWIPE_PENDING_MS,
  TAP_SLOP_PX,
  dragOffset,
  lockSwipeAxis,
  marqueeDurationSec,
  miniEnterKind,
  resolveSwipe,
} from '../src/contexts/playerMiniSwipe.mjs';

const srcRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const css = readFileSync(resolve(srcRoot, 'index.css'), 'utf8');
const player = readFileSync(resolve(srcRoot, 'contexts', 'PlayerContext.js'), 'utf8');

// ---- 1. 轴锁定:竖向为主的拖动绝不接管 ----
assert.equal(lockSwipeAxis(3, 2), null, '没动够时继续观察(仍可能是点击)');
assert.equal(lockSwipeAxis(20, 4), 'x', '明显横向 → 接管');
assert.equal(lockSwipeAxis(-20, 4), 'x', '向左同样接管');
assert.equal(lockSwipeAxis(4, 20), 'y', '明显竖向 → 放给浏览器');
assert.equal(lockSwipeAxis(12, 11), 'y', '斜着划(横向不占明显优势)按竖向处理,免得滚动时误切歌');
assert.equal(TAP_SLOP_PX, AXIS_LOCK_PX, '锁定成横向的那一刻起就不能再算点击');

// ---- 2. 切歌判定:方向、距离阈值、快甩 ----
const W = 260; // 真机迷你条封面+歌名区域的典型宽度
assert.equal(resolveSwipe({ dx: -120, elapsedMs: 400, width: W }), 'next', '左滑过阈值 = 下一首');
assert.equal(resolveSwipe({ dx: 120, elapsedMs: 400, width: W }), 'prev', '右滑过阈值 = 上一首');
assert.equal(resolveSwipe({ dx: -40, elapsedMs: 500, width: W }), null, '慢慢拖一小段 = 弹回');
assert.equal(resolveSwipe({ dx: -40, elapsedMs: 60, width: W }), 'next', '快速一甩,距离不够也切');
assert.equal(resolveSwipe({ dx: -10, elapsedMs: 5, width: W }), null, '抖动级别的位移再快也不算甩');
assert.equal(resolveSwipe({ dx: -60, elapsedMs: 500, width: 100 }), 'next', '窄容器上按下限 56px 判定');
assert.equal(resolveSwipe({ dx: -50, elapsedMs: 500, width: 100 }), null, `低于下限 ${COMMIT_MIN_PX}px 不切`);

// ---- 3. 拖动阻尼:阈值内跟手,之后变"沉" ----
assert.equal(dragOffset(-30, W), -30, '阈值内完全跟手');
const limit = Math.max(COMMIT_MIN_PX, W * 0.28);
const far = dragOffset(-(limit + 100), W);
assert.ok(far < 0 && Math.abs(far) < limit + 100 && Math.abs(far) > limit, '超出阈值后有阻尼,但仍随手指前进');

// ---- 4. 入场方向:只有"这次换歌正是那次滑动造成的"才按方向滑入 ----
const now = 10_000;
assert.equal(miniEnterKind({ fromKey: 'qq-1', direction: 'next', at: now - 50 }, 'qq-1', now), 'next');
assert.equal(miniEnterKind({ fromKey: 'qq-1', direction: 'prev', at: now - 50 }, 'qq-1', now), 'prev');
assert.equal(miniEnterKind(null, 'qq-1', now), 'fade', '自动续播 / 点队列 / 全屏页按钮换歌 = 淡入');
assert.equal(
  miniEnterKind({ fromKey: 'qq-0', direction: 'next', at: now - 50 }, 'qq-1', now),
  'fade',
  '滑动发生在别的歌上,不能把方向套给这次换歌',
);
assert.equal(
  miniEnterKind({ fromKey: 'qq-1', direction: 'next', at: now - SWIPE_PENDING_MS - 1 }, 'qq-1', now),
  'fade',
  '过期的滑动作废',
);

// ---- 5. 跑马灯时长:固定速度,而不是固定时长 ----
const shortD = 180;
const longD = 600;
assert.ok(marqueeDurationSec(longD) > marqueeDurationSec(shortD), '越长的标题一轮越久(旧版一律 9s,长标题飞快)');
{
  // 滚动段(去掉开头停顿)的实际速度应等于设定速度
  const d = 400;
  const total = marqueeDurationSec(d);
  const speed = d / (total * (1 - MARQUEE_PAUSE_RATIO));
  assert.ok(Math.abs(speed - MARQUEE_SPEED_PX_PER_S) < 1, `滚动段速度 ${speed.toFixed(1)}px/s 应约为 ${MARQUEE_SPEED_PX_PER_S}`);
}
assert.equal(marqueeDurationSec(0), 5, '下限 5s');
assert.equal(marqueeDurationSec(100000), 40, '上限 40s');
// CSS 关键帧的停顿段必须与 MARQUEE_PAUSE_RATIO 一致,否则上面的速度计算就失真了
{
  const kf = css.match(/@keyframes marquee-loop\s*\{\s*0%,\s*(\d+)%/);
  assert.ok(kf, '找不到 @keyframes marquee-loop 的停顿段');
  assert.equal(Number(kf[1]) / 100, MARQUEE_PAUSE_RATIO, 'marquee-loop 停顿比例与 MARQUEE_PAUSE_RATIO 不一致');
}
assert.ok(!/padding-left:\s*100%/.test(css), '跑马灯不得再从容器外(padding-left:100%)滑入 —— 每轮开头都是空白');
assert.match(player, /new ResizeObserver\(measure\)/, '跑马灯要跟随容器尺寸重新判断是否滚动');
assert.match(player, /t\.offsetWidth/, '测文字宽度必须用 inline-block 的 offsetWidth(inline 元素的 scrollWidth 恒为 0)');

// ---- 6. 组件接线 ----
assert.match(player, /touchAction: 'pan-y'/, '迷你条要放行竖向滑动,只接管横向');
assert.match(player, /onClickCapture:/, '拖动后必须吞掉补发的 click,否则松手会顺带展开播放页');
assert.match(player, /queue\.length <= 1/, '队列只有一首时滑动应弹回,不要重播本曲');
assert.match(player, /miniDrag\.key === curKey \? miniDrag\.phase : 'idle'/, '拖动状态必须绑定曲目,换歌首帧不能沿用上一首的 hold');
assert.match(player, /<span key=\{curKey\} className=\{`\$\{miniTrackClass\}/, '内容按曲目 key 重新挂载,入场动画才会播放');
assert.match(css, /\.mini-track-hitbox:not\(:disabled\):active\s*\{\s*transform:\s*none/, '迷你条不能叠加全局按下缩放');

// 细进度条:transform 而非 width
assert.ok(
  !/style=\{\{ width: progress\.dur \?/.test(player),
  '迷你条进度不得再改 width(4Hz 重排 + 一格一格跳)',
);
assert.match(player, /mini-progress-fill[\s\S]{0,200}scaleX\(/, '迷你条进度应使用 scaleX');
assert.match(css, /\.mini-progress-fill\s*\{[^}]*transform-origin:\s*left/, 'scaleX 必须以左端为原点');

// reduced-motion 覆盖
const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
for (const cls of ['.marquee__track', '.player-mini-enter', '.mini-track-enter-next', '.mini-track-enter-prev', '.mini-track-enter-fade', '.mini-progress-fill', '.mini-track--settle']) {
  assert.ok(reduced.includes(cls), `reduced-motion 未覆盖 ${cls}`);
}

console.log('player mini swipe tests passed');
