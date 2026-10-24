import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { cn } from './cn';

// 弹出菜单基础件(行内"更多操作"、侧栏"+"、播放模式等)。
// 历史问题:各处手写定位,出现三个真实叠层 bug:
//   · MyPlaylist 的「更多」下拉用 z-40,与播放条同层且 DOM 更早 → 被播放条盖住;
//   · Sidebar 的「+」菜单用固定坐标 + 内联背景色(#282828)绕过 token;
//   · SongRow 已按滚动容器边界翻转,但别处没同步。
// 现在统一:z-popover 语义层 + 自动上下翻转(以 #app-main 为界)+ 点外部/Esc 关闭。
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

  useLayoutEffect(() => {
    if (!open || !anchorRef?.current) return;
    const rect = anchorRef.current.getBoundingClientRect();
    const scroller = document.getElementById('app-main');
    const boundary = scroller ? scroller.getBoundingClientRect() : { top: 0, bottom: window.innerHeight, left: 0, right: window.innerWidth };
    const placement = rect.bottom + ESTIMATED_HEIGHT > boundary.bottom ? 'up' : 'down';
    const panelWidth = 240;
    let left = align === 'end' ? rect.right - panelWidth : rect.left;
    left = Math.max(8 + boundary.left, Math.min(left, boundary.right - panelWidth - 8));
    const top = placement === 'up' ? rect.top - 8 : rect.bottom + 8;
    setPos({ top, left, placement });
  }, [open, anchorRef, align]);

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
