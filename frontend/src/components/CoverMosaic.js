import { useEffect, useMemo, useState } from 'react';
import { Music } from 'lucide-react';
import { coverProxyUrl } from '../services/musicdl';

// 统一头图封面:0 张占位 / 1-3 张取首张铺满 / 4 张以上自动 2x2 拼图。
//
// ★ 2026-11 尺寸收敛（手机端对齐）：
//   六个详情页（推荐歌单/专辑/自建歌单/最近播放/已下载/离线）此前有**两种**头图尺寸：
//     · 用本组件的四处 → 默认 `w-32 h-32` = **128px**
//     · 手写 div 的两处（Download.js / PlaylistSongs.js / LocalMusic.js 专辑）→ `h-28 w-28` = **112px**
//   同一产品的"详情页封面"差 16px，跨页翻动时肉眼可见地跳一下。
//   现在统一到 112px（手机段）：`w-28 h-28`，`sm:` 以上再放到 128px。
//   `size` 是正方形边长（数字，单位 px），只用于自定义；默认走下面的响应式类。
export const COVER_BOX_MOBILE = 'w-28 h-28';
export const COVER_BOX_WIDE = 'sm:w-32 sm:h-32';

export default function CoverMosaic({
  items = [],
  icon: Icon = Music,
  getUrl,
  className = `flex-shrink-0 ${COVER_BOX_MOBILE} ${COVER_BOX_WIDE}`,
  roundedClass = 'rounded-lg',
  iconSize = 36,
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
