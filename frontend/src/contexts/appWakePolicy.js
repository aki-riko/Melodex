const shallowRecordEquals = (left, right) => {
  if (left === right) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) => Object.prototype.hasOwnProperty.call(right, key)
    && Object.is(left[key], right[key]));
};

// 后台恢复/网络重连会重新校验会话。返回内容未变化时保留原 state 引用，
// 避免 AuthContext 让整棵前端树做一次无意义重渲染。
export const authSnapshotsEqual = (left, right) => {
  if (left === right) return true;
  if (!left || !right) return false;
  const { user: leftUser, ...leftState } = left;
  const { user: rightUser, ...rightState } = right;
  return shallowRecordEquals(leftState, rightState)
    && shallowRecordEquals(leftUser, rightUser);
};

export const SERVER_DOWNLOADS_STALE_MS = 60 * 1000;
export const WAKE_RECONCILIATION_IDLE_TIMEOUT_MS = 2 * 1000;

// 下载状态已有“保存成功事件”做实时增量更新。页面恢复时不再由 React Query
// 立即聚焦/联网刷新，避免长时间后台后与浏览器资源恢复争抢主线程。
export const serverDownloadsQueryOptions = ({ userId, offline }) => ({
  enabled: Number(userId) > 0 && !offline,
  staleTime: SERVER_DOWNLOADS_STALE_MS,
  refetchOnReconnect: false,
  refetchOnWindowFocus: false,
});

// 页面刚恢复时先让浏览器完成两个绘制帧，再进入空闲阶段执行服务器状态对账。
// 不支持 requestIdleCallback 的浏览器退回到下一轮任务；取消函数会清理所有待执行步骤。
export const scheduleWakeReconciliation = (callback, runtime = globalThis) => {
  let cancelled = false;
  let firstFrameID = null;
  let secondFrameID = null;
  let idleID = null;
  let timerID = null;

  const run = () => {
    if (!cancelled) callback();
  };
  const scheduleIdle = () => {
    if (cancelled) return;
    if (typeof runtime.requestIdleCallback === 'function') {
      idleID = runtime.requestIdleCallback(run, {
        timeout: WAKE_RECONCILIATION_IDLE_TIMEOUT_MS,
      });
      return;
    }
    timerID = runtime.setTimeout(run, 0);
  };

  if (typeof runtime.requestAnimationFrame === 'function') {
    firstFrameID = runtime.requestAnimationFrame(() => {
      if (cancelled) return;
      secondFrameID = runtime.requestAnimationFrame(scheduleIdle);
    });
  } else {
    scheduleIdle();
  }

  return () => {
    cancelled = true;
    if (firstFrameID !== null) runtime.cancelAnimationFrame?.(firstFrameID);
    if (secondFrameID !== null) runtime.cancelAnimationFrame?.(secondFrameID);
    if (idleID !== null) runtime.cancelIdleCallback?.(idleID);
    if (timerID !== null) runtime.clearTimeout?.(timerID);
  };
};

export const createWakeReconciler = ({
  isVisible,
  isOnline,
  reconcile,
  schedule = scheduleWakeReconciliation,
}) => {
  let cancelPending = null;

  const cancel = () => {
    cancelPending?.();
    cancelPending = null;
  };
  const request = () => {
    cancel();
    if (!isVisible() || !isOnline()) return;
    cancelPending = schedule(() => {
      cancelPending = null;
      if (isVisible() && isOnline()) reconcile();
    });
  };

  return {
    onVisibilityChange: () => {
      if (isVisible()) request();
      else cancel();
    },
    onOnline: request,
    onOffline: cancel,
    cancel,
  };
};
