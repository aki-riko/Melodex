import { useEffect, useRef } from 'react';

const REFRESH_DELAY_MS = 5000;

/**
 * 后端返回「缓存命中 + 正在后台刷新」时,延迟再拉一次拿最终结果。
 *
 * 依赖数组刻意**精确到具体字段**而不是整个 `query` 对象:
 * react-query 的 query 结果对象每次渲染都是新引用,把它整个放进去会让这个
 * effect 每次渲染都重跑 —— 也就是每渲染一次就重置一次 5 秒计时器,
 * 刷新永远等不到。这不是"漏了依赖",是有意的精确依赖。
 *
 * 用 ref 读 refetch:它只在定时器真正触发时被调用,届时读最新值即可,
 * 不需要因为它变化而重建定时器。
 */
export const useCachedRefresh = (query, enabled = true) => {
  const refetchRef = useRef(query?.refetch);
  refetchRef.current = query?.refetch;

  useEffect(() => {
    if (!enabled || !query?.data?.refreshing || typeof refetchRef.current !== 'function') {
      return undefined;
    }
    const timer = window.setTimeout(() => {
      refetchRef.current?.();
    }, REFRESH_DELAY_MS);
    return () => window.clearTimeout(timer);
    // 只关心"刷新标记 + 缓存戳 + 是否启用";refetch 走 ref(见文件头说明),
    // 所以它在依赖里既不需要、也不该有 —— lint 对此无异议。
  }, [enabled, query?.data?.refreshing, query?.data?.cached_at]);
};
