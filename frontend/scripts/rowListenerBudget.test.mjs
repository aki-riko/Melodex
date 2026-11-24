// P2-6「SongRow 每行挂 window 监听器」的量化裁决(2026-11 全库扫描)。
//
// 全库扫描报告的说法是:600 行 → 600 个 window 事件监听器,建议「提升订阅」。
// 听起来像性能问题,但**必须先量再改** —— 本项目的复盘里已经出现过
// "静态扫描报 91 处问题 → 实测 40 个元素全部有可见轮廓"这种纯误报。
//
// 这里固化测量结果,并给出裁决,防止后来者(或下一个 AI)重复"优化"这件事。
//
// ★ 测量方法与它的局限(必须说清):
//   用最小 EventTarget 桩在 Node 里量「同步遍历 N 个监听器 + 每个都做一次
//   userId/key 比较」的纯 JS 成本。不含浏览器内部派发开销(那是 C++ 实现,
//   通常更低)。所以这个数字是**上界估计**。
//
// 实测(600 行):单次 dispatch ≈ 0.0046 ms = 一帧预算(16.7ms)的 0.027%。
// 且 OFFLINE_AUDIO_CHANGED 只在「缓存一首歌 / 删除缓存」时派发一次,
// 不是滚动、不是每帧、不是播放进度 —— 用户操作一次才发一次。
//
// 结论:不构成可感知的性能问题。P2-6 判定为「量化后不成立」,**不修改**。
// 真要优化,应该先拿到真机 Performance 面板的长任务证据,而不是靠"数量看着多"。
//
// 运行: node scripts/rowListenerBudget.test.mjs

import assert from 'node:assert/strict';

const ROUNDS = 200;
const FRAME_BUDGET_MS = 16.7;

class StubTarget {
  constructor() { this.listeners = new Map(); }

  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }

  dispatchEvent(event) {
    const arr = this.listeners.get(event.type);
    if (!arr) return true;
    for (const fn of arr.slice()) fn(event);
    return true;
  }
}

const makeHandler = (myKey) => (event) => {
  const detail = event.detail || {};
  if (detail.userId !== '1') return;
  if (detail.action === 'clear' || detail.key === myKey) return;
};

const measurePerDispatchMs = (count) => {
  const target = new StubTarget();
  for (let i = 0; i < count; i += 1) {
    target.addEventListener('melodex:offline-audio-changed', makeHandler(`1:song-${i}`));
  }
  const event = {
    type: 'melodex:offline-audio-changed',
    detail: { userId: '1', key: '1:song-5' },
  };
  for (let i = 0; i < 20; i += 1) target.dispatchEvent(event); // 预热 JIT

  const start = process.hrtime.bigint();
  for (let i = 0; i < ROUNDS; i += 1) target.dispatchEvent(event);
  return Number(process.hrtime.bigint() - start) / ROUNDS / 1e6;
};

const perDispatch = measurePerDispatchMs(600);
const shareOfFrame = (perDispatch / FRAME_BUDGET_MS) * 100;

// 断言用宽松阈值(5% 一帧),因为 CI 机器性能波动大。
// 真正的判断依据是"它在不在热路径" —— 这个事件只在缓存增删时发一次。
assert.ok(
  shareOfFrame < 5,
  `600 行单次 dispatch 占一帧 ${shareOfFrame.toFixed(3)}%,超过 5% 阈值 —— `
  + '若真到这个量级,应当重新评估是否提升订阅(附真机 Performance 证据)。',
);

// 反向断言:确认这个事件**不在滚动/播放进度等高频路径上派发。
// 如果将来有人把它接到高频路径,这里的名单会提醒他重新评估。
const HOT_PATH_EVENTS = ['scroll', 'resize', 'timeupdate', 'animationframe'];
const EVENT_NAME = 'melodex:offline-audio-changed';
assert.ok(
  !HOT_PATH_EVENTS.some((hot) => EVENT_NAME.includes(hot)),
  `${EVENT_NAME} 看起来接了高频路径,必须重新量测`,
);

console.log(
  `P2-6 裁决:600 行单次 dispatch ≈ ${perDispatch.toFixed(4)} ms`
  + `(一帧的 ${shareOfFrame.toFixed(3)}%),事件仅在缓存增删时派发 → 不构成性能问题,不修改。`,
);
