import React, { useEffect, useMemo, useState } from 'react';
import { Music } from 'lucide-react';
import { coverProxyUrl } from '../services/musicdl';

// 统一头图封面:0 张占位 / 1-3 张取首张铺满 / 4 张以上自动 2x2 拼图。
export default function CoverMosaic({
  items = [],
  icon: Icon = Music,
  getUrl,
  className = 'w-32 h-32',
  roundedClass = 'rounded-lg',
  iconSize = 48,
}) {
  const candidates = useMemo(() => (items || [])
    .map((item) => {
      if (!item) return null;
      const url = typeof getUrl === 'function' ? getUrl(item) : (item.coverUrl || coverProxyUrl(item));
      return url ? { item, url } : null;
    })
    .filter(Boolean), [items, getUrl]);

  const urlKey = candidates.map((entry) => entry.url).join('\n');
  const [failedUrls, setFailedUrls] = useState(() => new Set());

  useEffect(() => {
    setFailedUrls(new Set());
  }, [urlKey]);

  const covered = candidates.filter((entry) => !failedUrls.has(entry.url));
  const markFailed = (url) => {
    setFailedUrls((prev) => {
      if (prev.has(url)) return prev;
      const next = new Set(prev);
      next.add(url);
      return next;
    });
  };

  const baseClass = `${className} ${roundedClass} overflow-hidden flex-shrink-0 shadow bg-secondary`;

  if (covered.length === 0) {
    return (
      <div className={`${baseClass} flex items-center justify-center`}>
        <Icon size={iconSize} className="text-muted-foreground" />
      </div>
    );
  }

  if (covered.length >= 4) {
    return (
      <div className={`${baseClass} grid grid-cols-2 grid-rows-2`}>
        {covered.slice(0, 4).map((entry, index) => (
          <img
            key={`${entry.url}-${index}`}
            src={entry.url}
            alt=""
            loading="lazy"
            className="h-full w-full object-cover"
            onError={() => markFailed(entry.url)}
          />
        ))}
      </div>
    );
  }

  return (
    <div className={baseClass}>
      <img
        src={covered[0].url}
        alt=""
        loading="lazy"
        className="h-full w-full object-cover"
        onError={() => markFailed(covered[0].url)}
      />
    </div>
  );
}
