import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from './cn';

// 横向滚动行(专辑条等)。
// 历史问题:直接用 `overflow-x-auto`,于是出现一条浏览器默认滚动条白槽,
// 与全站的暗色细滚动条完全不搭 —— 就是"滚动条乱七八糟"的主要来源之一。
// 现在:.scroll-x 隐藏滚动槽 + 两侧渐隐 + 悬停显示左右箭头(桌面鼠标可发现可操作),
//       移动端保持原生手势与惯性。
//
// ★ 2026-11 重做可发现性（用户：「现在的地狱排版看不下去了」）：
//   旧方案的致命问题是**箭头只在 hover 时出现**（`opacity-0 group-hover:opacity-100`），
//   而边缘渐隐只有 2rem —— 首屏看到的就是"右边第 6 张卡片被硬切掉一刀"，
//   既没有箭头也没有足够宽的渐隐，用户根本不知道这里能滑。
//   实测：主区右边界 1280px，卡片一路排到 2496px（scrollWidth 24084px），
//   被切掉的卡片右半截完全裸露。
//
//   新行为：
//     · **箭头常显但低对比**（opacity 默认 55%），hover 容器时提到 100% ——
//       平时能看见"这里可以滑"，但不喧宾夺主；
//     · 不可滑的那一侧仍隐藏（disabled 时 opacity-0 + pointer-events-none）；
//     · 箭头位置从 `left-0/right-0` 外移到 `-left-3/-right-3` 并加白底描边，
//       不再压住卡片内容；
//     · 边缘渐隐宽度从 2rem 提到 4rem（见 index.css），足够盖住被切的卡片。
//
// 用法:
//   <ScrollRow label="专辑">
//     {albums.map(a => <AlbumCard key=... />)}
//   </ScrollRow>

const Arrow = ({ direction, onClick, disabled }) => {
  const Icon = direction === 'left' ? ChevronLeft : ChevronRight;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={direction === 'left' ? '向左滚动' : '向右滚动'}
      tabIndex={disabled ? -1 : 0}
      className={cn(
        // lg:flex 才有（窄屏靠手势，不需要箭头占位）
        'absolute top-1/2 z-popover hidden h-9 w-9 -translate-y-1/2 items-center justify-center lg:flex',
        'rounded-full border border-border bg-popover text-foreground shadow-popover backdrop-blur',
        'transition-opacity duration-base ease-standard',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[hsl(var(--ring))]',
        // 外移一点点，避免压住卡片内容
        direction === 'left' ? '-left-3' : '-right-3',
        // ★ 常显低对比 → hover 容器提亮；不可滑则彻底隐藏
        disabled
          ? 'pointer-events-none opacity-0'
          : 'opacity-55 group-hover/scroll:opacity-100',
      )}
    >
      <Icon size={18} />
    </button>
  );
};

export default function ScrollRow({
  children,
  label,
  className = '',
  itemClassName = '',
  arrowInset = '0.5rem',
}) {
  const scrollerRef = useRef(null);
  const [canLeft, setCanLeft] = useState(false);
  const [canRight, setCanRight] = useState(false);

  const sync = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    setCanLeft(el.scrollLeft > 4);
    setCanRight(max > 4 && el.scrollLeft < max - 4);
  }, []);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return undefined;
    sync();
    el.addEventListener('scroll', sync, { passive: true });
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(sync) : null;
    if (ro) ro.observe(el);
    window.addEventListener('resize', sync);
    return () => {
      el.removeEventListener('scroll', sync);
      if (ro) ro.disconnect();
      window.removeEventListener('resize', sync);
    };
  }, [sync]);

  const scrollBy = (dir) => {
    const el = scrollerRef.current;
    if (!el) return;
    const amount = Math.max(el.clientWidth * 0.8, 240);
    el.scrollBy({ left: dir * amount, behavior: 'smooth' });
  };

  return (
    <div className="group/scroll scroll-x-wrap" data-can-left={canLeft} data-can-right={canRight}>
      <Arrow direction="left" onClick={() => scrollBy(-1)} disabled={!canLeft} />
      <Arrow direction="right" onClick={() => scrollBy(1)} disabled={!canRight} />
      <div
        ref={scrollerRef}
        className={cn('scroll-x flex gap-3 pb-1', className)}
        role="list"
        aria-label={label}
        style={{ paddingInline: arrowInset }}
      >
        {React.Children.map(children, (child, i) => (
          <div role="listitem" className={cn('flex-none', itemClassName)} key={child?.key ?? i}>
            {child}
          </div>
        ))}
      </div>
    </div>
  );
}
