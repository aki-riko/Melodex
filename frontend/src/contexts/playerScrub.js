// 进度条拖动仲裁:决定「用户的手指」和「播放器报时」谁说话算数。
//
// 为什么需要它(2026-11 修「拖动进度条会回弹」):
// · Web/PWA:`<audio>` 的 timeupdate 每 ~250ms 报一次 audio.currentTime。
//   手指拖到 90s 时 seek() 只改了 React state,音频真实位置还在 12s,
//   下一次 timeupdate 就把进度条拽回 12s —— 视觉上就是"拖完回弹"。
//   MSE 管线更糟:80ms 防抖里重建分块前,旧时间线一直在报。
// · Android 原生:拖动时每个 onChange 都过一次 IPC seekTo,而原生侧还有
//   500ms 的状态轮询,旧 positionMs 大概率盖掉刚拖到的新位置。
//
// 两条路径都要满足同一件事:跳转之后、播放器报到目标附近之前,一律不认它
// 报来的旧位置;拖动进行中更是只认拇指。这里只放纯逻辑,方便零依赖单测
// (scripts/playerScrub.test.mjs),React 侧的 hook 在 PlayerContext.js 里。

// 跳转后最多压住旧位置这么久。必须留余量:原生 seekTo 若赶上缓冲,
// 位置迟迟不到目标,超时后必须放行,绝不能把进度条永久冻住。
export const SEEK_SETTLE_TIMEOUT_MS = 3000;

// 报到离目标多近就算"到位"。拖动步进 0.5s,给到 1.2s 足够吸收
// timeupdate 的节流粒度,又不会把真正没跳成功的旧位置当成到位。
export const SEEK_ARRIVAL_TOLERANCE_SECONDS = 1.2;

// 拖动状态的兜底有效期。真实场景里 pointerup 可能丢失(触摸被系统手势抢走、
// WebView 切后台、元素被重渲染替换)。若不加兜底,「拖动中」会永久卡住 ——
// 进度条从此再也不跟播放器走,比原本的回弹还严重。
export const MAX_SCRUB_DURATION_MS = 30000;

export const createScrubState = () => ({
  dragging: false,
  dragStartedAt: 0,
  seekTarget: null,
  seekDeadline: 0,
});

const clearSeekTarget = (state) => {
  state.seekTarget = null;
  state.seekDeadline = 0;
};

// 换歌/重新加载时整份复位:上一首的闸门绝不能压住新歌的进度。
export const resetScrubState = (state) => {
  if (!state) return state;
  state.dragging = false;
  state.dragStartedAt = 0;
  clearSeekTarget(state);
  return state;
};

// 手指按住进度条:此刻起只认拇指,连尚未到位的闸门也一并作废
// (用户重新拖了,旧目标已经没有意义)。
export const beginScrub = (state, now = Date.now()) => {
  if (!state) return state;
  state.dragging = true;
  state.dragStartedAt = Number(now || 0);
  clearSeekTarget(state);
  return state;
};

export const endScrub = (state) => {
  if (!state) return state;
  state.dragging = false;
  state.dragStartedAt = 0;
  return state;
};

// 拖动是否仍有效。超过兜底时长说明 pointerup 丢了,视同已松手。
export const isScrubbingActive = (
  state,
  now = Date.now(),
  { maxDurationMs = MAX_SCRUB_DURATION_MS } = {},
) => {
  if (!state?.dragging) return false;
  const limit = Number(maxDurationMs);
  if (!Number.isFinite(limit) || limit <= 0) return true;
  if (!state.dragStartedAt) return true;
  if (Number(now || 0) - state.dragStartedAt > limit) {
    endScrub(state);
    return false;
  }
  return true;
};

// 提交一次跳转:从现在起压住旧位置,直到报到目标附近或超时。
export const armSeekTarget = (
  state,
  target,
  now = Date.now(),
  { timeoutMs = SEEK_SETTLE_TIMEOUT_MS } = {},
) => {
  if (!state) return state;
  const value = Number(target);
  if (!Number.isFinite(value)) return state;
  const window = Number(timeoutMs);
  state.seekTarget = Math.max(0, value);
  state.seekDeadline = Number(now || 0) + (Number.isFinite(window) && window > 0 ? window : SEEK_SETTLE_TIMEOUT_MS);
  return state;
};

// 这次「播放器报时」能不能覆盖进度条?
// 返回 false 时调用方只能保留当前界面位置(通常是用户刚拖到的目标),
// 否则进度条就会被拽回旧位置,也就是用户看到的回弹。
export const shouldApplyProgressReport = (
  state,
  reported,
  now = Date.now(),
  { arrivalTolerance = SEEK_ARRIVAL_TOLERANCE_SECONDS, maxScrubDurationMs = MAX_SCRUB_DURATION_MS } = {},
) => {
  const value = Number(reported);
  if (!Number.isFinite(value) || value < 0) return false;
  if (!state) return true;
  // 拖动期间播放器的报时一律不算数(它报的是拖动开始前的位置)。
  // 用 isScrubbingActive 而非直接看 dragging:后者在 pointerup 丢失时会永久卡住。
  if (isScrubbingActive(state, now, { maxDurationMs: maxScrubDurationMs })) return false;
  if (state.seekTarget == null) return true;

  const tolerance = Math.max(0, Number(arrivalTolerance) || 0);
  // 到位:解除闸门,之后恢复正常跟随。
  // 容差比较必须带 epsilon:60 + 1.2 - 60 在双精度里是 1.2000000000000028,
  // 直接用 <= 会把"恰好等于容差"判成没到位(单测当场抓到)。
  if (Math.abs(value - state.seekTarget) <= tolerance + 1e-9) {
    clearSeekTarget(state);
    return true;
  }
  // 超时兜底:跳转没成功也必须放行,否则进度条永远停在目标上不动。
  if (Number(now || 0) > state.seekDeadline) {
    clearSeekTarget(state);
    return true;
  }
  return false;
};
