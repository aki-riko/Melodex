import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { cn } from './cn';
import { computeMenuPosition, resolveBoundaryRect, VIEWPORT_MARGIN } from './menuPosition';

// 弹出菜单基础件(行内"更多操作"、侧栏"+"、播放模式等)。
// 历史问题:各处手写定位,出现多个真实叠层 bug:
//   · MyPlaylist 的「更多」下拉用 z-40,与播放条同层且 DOM 更早 → 被播放条盖住;
//   · Sidebar 的「+」菜单用固定坐标 + 内联背景色(#282828)绕过 token;
//   · 无条件拿 #app-main 当边界 → 侧栏菜单被推到主内容区(离按钮 300px);
//   · panelWidth 写死 240、高度估算 260 → 窄屏右侧溢出、底部误判;
//   · 只在打开那一刻算一次 → 滚动时菜单脱钩。
// 现在统一:z-popover 语义层 + 按锚点选边界 + 实测面板尺寸 + 滚动跟随 + 点外部/Esc 关闭。
// 几何计算在 ./menuPosition.js,带契约测试(scripts/menuPosition.test.mjs)。
//
// 用法:
//   <Menu trigger={({open, toggle, ref}) => <button ref={ref} onClick={toggle}>…</button>}
//         open={open} onClose={...}>
//     <MenuItem …/>
//   </Menu>
// 或直接受控使用 <MenuPopover anchorRef open onClose>{...}</MenuPopover>

const ESTIMATED_HEIGHT = 260;

export function MenuPopover({ anchorRef, open, onClose, align = 'end', width = 'w-60', className = '', children }) {
  const panelRef = useRef(null);
  const [pos, setPos] = useState({ top: 0, left: 0, placement: 'down' });

  // 定位:实测面板自身尺寸,而不是按 240/260 猜。
  // 调用方 width 从 w-48(192) 到 w-64(256) 不等 —— 写死 240 会
  // 右侧溢出 8~16px,并与按钮对不齐。
  const reposition = useCallback(() => {
    const anchor = anchorRef?.current;
    if (!anchor) return;
    const main = document.getElementById('app-main');
    const boundary = resolveBoundaryRect({
      anchorInMain: !!main && main.contains(anchor),
      viewport: {
        top: 0,
        bottom: window.innerHeight,
        left: 0,
        right: window.innerWidth,
      },
      mainRect: main
        ? (() => {
          const r = main.getBoundingClientRect();
          return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
        })()
        : null,
    });

    const panel = panelRef.current;
    const next = computeMenuPosition({
      anchorRect: anchor.getBoundingClientRect(),
      boundary,
      panelWidth: panel?.offsetWidth || 240,
      panelHeight: panel?.offsetHeight || ESTIMATED_HEIGHT,
      align,
      margin: VIEWPORT_MARGIN,
    });
    setPos(next);
  }, [anchorRef, align]);

  // 首帧先粗定位(此时还量不到面板尺寸),下一帧拿到真实尺寸后再精确定位。
  useLayoutEffect(() => {
    if (!open || !anchorRef?.current) return;
    reposition();
    const raf = window.requestAnimationFrame(reposition);
    return () => window.cancelAnimationFrame(raf);
  }, [open, anchorRef, reposition]);

  // 菜单开着时页面滚动/窗口变化,菜单必须跟着走。
  // 早先只在打开那一刻算一次,于是滚动列表时菜单会「脱钩」留在原地 ——
  // 长列表里非常容易复现。
  useEffect(() => {
    if (!open) return undefined;
    const scroller = document.getElementById('app-main');
    const onScrollOrResize = () => reposition();
    window.addEventListener('scroll', onScrollOrResize, true);
    window.addEventListener('resize', onScrollOrResize);
    if (scroller) scroller.addEventListener('scroll', onScrollOrResize, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScrollOrResize, true);
      window.removeEventListener('resize', onScrollOrResize);
      if (scroller) scroller.removeEventListener('scroll', onScrollOrResize);
    };
  }, [open, reposition]);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event) => {
      if (panelRef.current?.contains(event.target)) return;
      if (anchorRef?.current?.contains(event.target)) return;
      onClose?.();
    };
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose?.();
        anchorRef?.current?.focus?.();
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [open, onClose, anchorRef]);

  if (!open) return null;

  return (
    <div
      ref={panelRef}
      role="menu"
      style={{
        position: 'fixed',
        top: pos.top,
        left: pos.left,
        transform: pos.placement === 'up' ? 'translateY(-100%)' : undefined,
      }}
      className={cn(
        'z-popover overflow-hidden rounded-md border border-border bg-popover text-popover-foreground shadow-popover',
        width,
        'animate-pop-in',
        className,
      )}
    >
      {children}
    </div>
  );
}

export function MenuItem({ icon: Icon, label, hint, onClick, disabled, danger, busy }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'flex min-h-touch w-full items-center gap-3 px-3 py-2 text-left type-body transition-colors duration-base',
        'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[hsl(var(--ring))]',
        'disabled:cursor-not-allowed disabled:opacity-45',
        danger ? 'text-destructive hover:bg-destructive/10' : 'text-foreground hover:bg-secondary',
      )}
    >
      {Icon && (
        <Icon
          size={16}
          className={cn('flex-shrink-0', busy && 'animate-pulse')}
          aria-hidden="true"
        />
      )}
      <span className="min-w-0">
        <span className="block truncate font-medium">{label}</span>
        {hint && <span className="block truncate type-micro text-muted-foreground">{hint}</span>}
      </span>
    </button>
  );
}

export function MenuDivider() {
  return <div className="my-1 h-px bg-border" role="separator" />;
}

/**
 * 受控菜单:管理 anchorRef 与 open 状态,渲染触发器 + 面板。
 * renderTrigger 收到 ({ ref, open, toggle, aria }) —— 务必把 aria 摊到按钮上。
 */
export default function Menu({ renderTrigger, children, align = 'end', width }) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef(null);
  const close = useCallback(() => setOpen(false), []);

  return (
    <>
      {renderTrigger({
        ref: anchorRef,
        open,
        toggle: () => setOpen((v) => !v),
        close,
        aria: {
          'aria-haspopup': 'menu',
          'aria-expanded': open,
        },
      })}
      <MenuPopover anchorRef={anchorRef} open={open} onClose={close} align={align} width={width}>
        {typeof children === 'function' ? children({ close }) : children}
      </MenuPopover>
    </>
  );
}
