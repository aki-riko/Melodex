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

// 下载状态已有“保存成功事件”做实时增量更新。页面恢复时不再由 React Query
// 立即聚焦/联网刷新，避免长时间后台后与浏览器资源恢复争抢主线程。
export const serverDownloadsQueryOptions = ({ userId, offline }) => ({
  enabled: Number(userId) > 0 && !offline,
  staleTime: SERVER_DOWNLOADS_STALE_MS,
  refetchOnReconnect: false,
  refetchOnWindowFocus: false,
});
