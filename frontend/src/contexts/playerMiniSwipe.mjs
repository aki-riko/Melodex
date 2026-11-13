// 移动端迷你播放条:左右滑动切歌 + 跑马灯的纯逻辑(无 React 依赖,Node 合同测试直接导入)。
//
// 手势约定(与 QQ 音乐/网易云一致):
//   · 向左滑 = 下一首(新歌从右侧进来),向右滑 = 上一首;
//   · 竖向为主的拖动一律不接管 —— 那是用户想滚页面或误触;
//   · 拖动未达阈值松手 = 弹回,什么都不发生;
//   · 拖过一点点(> TAP_SLOP)就不再算"点击",否则松手会顺带展开播放页。

/** 手指移动超过这个距离才判定方向(px)。小于它仍可能是点击。 */
export const AXIS_LOCK_PX = 8;
/** 判定为"拖动过"、从而吞掉随后 click 的距离(px)。与轴锁定同值:锁定了就不是点击。 */
export const TAP_SLOP_PX = AXIS_LOCK_PX;
/** 距离阈值:拖过容器宽度的这个比例即切歌。 */
export const COMMIT_RATIO = 0.28;
/** 距离阈值的下限(px),防止极窄容器上轻轻一碰就切。 */
export const COMMIT_MIN_PX = 56;
/** 速度阈值(px/ms):快速一甩,距离不够也切。 */
export const FLICK_VELOCITY = 0.45;
/** 快甩也至少要有这么多位移(px),防止抖动被当成甩。 */
export const FLICK_MIN_PX = 24;
/** 切歌入场动画只认这段时间内的滑动(ms)。超时还没换歌 = 本次滑动作废,不会误给之后的切歌套方向。 */
export const SWIPE_PENDING_MS = 1500;

/**
 * 根据首段位移决定这次拖动归谁。
 * @returns {'x'|'y'|null} null = 还没动够,继续观察
 */
export const lockSwipeAxis = (dx, dy) => {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (Math.max(ax, ay) < AXIS_LOCK_PX) return null;
  // 需要横向明显占优(而不是略大于竖向):斜着划大多是想滚动
  return ax > ay * 1.2 ? 'x' : 'y';
};

/**
 * 拖动中给内容的位移:跟手,但超过阈值后加阻尼,给"再拖也没用了"的手感。
 */
export const dragOffset = (dx, width) => {
  const limit = Math.max(COMMIT_MIN_PX, (Number(width) || 0) * COMMIT_RATIO);
  const ax = Math.abs(dx);
  if (ax <= limit) return dx;
  return Math.sign(dx) * (limit + (ax - limit) * 0.35);
};

/**
 * 松手时是否切歌。
 * @returns {'next'|'prev'|null}
 */
export const resolveSwipe = ({ dx, elapsedMs, width }) => {
  const distance = Math.abs(Number(dx) || 0);
  if (distance < FLICK_MIN_PX) return null;
  const limit = Math.max(COMMIT_MIN_PX, (Number(width) || 0) * COMMIT_RATIO);
  const velocity = distance / Math.max(1, Number(elapsedMs) || 0);
  if (distance < limit && velocity < FLICK_VELOCITY) return null;
  return dx < 0 ? 'next' : 'prev';
};

/**
 * 当前曲目变化时,新内容用哪种入场动画。
 * 只有「这次换歌正是那次滑动造成的」才按方向滑入;其余换歌(自动续播、点队列、全屏页按钮)淡入。
 *
 * @param {{fromKey:string, direction:'next'|'prev', at:number}|null} pending 最近一次滑动
 * @param {string} prevKey 换歌前的曲目 key
 * @param {number} now
 * @returns {'next'|'prev'|'fade'}
 */
export const miniEnterKind = (pending, prevKey, now) => {
  if (
    pending
    && pending.fromKey === prevKey
    && Number.isFinite(pending.at)
    && now - pending.at <= SWIPE_PENDING_MS
  ) {
    return pending.direction;
  }
  return 'fade';
};

/** 跑马灯滚动速度(px/s)。固定速度而不是固定时长:原先一律 9s,长标题飞快、短标题慢吞吞。 */
export const MARQUEE_SPEED_PX_PER_S = 36;
/** 每轮开头停顿占整轮的比例(见 index.css @keyframes marquee-loop 的 0%~18%)。 */
export const MARQUEE_PAUSE_RATIO = 0.18;

/**
 * 跑马灯一整轮的时长(秒)。distance = 一份文字宽 + 两份之间的间距。
 * 停顿段也算在整轮里,所以滚动段的实际速度才等于 MARQUEE_SPEED_PX_PER_S。
 */
export const marqueeDurationSec = (distance) => {
  const d = Math.max(0, Number(distance) || 0);
  const scrollSec = d / MARQUEE_SPEED_PX_PER_S;
  const total = scrollSec / (1 - MARQUEE_PAUSE_RATIO);
  return Math.min(40, Math.max(5, Math.round(total * 10) / 10));
};
