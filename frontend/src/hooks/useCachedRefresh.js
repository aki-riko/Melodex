import { useEffect } from 'react';

const REFRESH_DELAY_MS = 5000;

export const useCachedRefresh = (query, enabled = true) => {
  useEffect(() => {
    if (!enabled || !query?.data?.refreshing || typeof query.refetch !== 'function') return undefined;
    const timer = window.setTimeout(() => {
      query.refetch();
    }, REFRESH_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [enabled, query?.data?.refreshing, query?.data?.cached_at, query?.refetch]);
};
