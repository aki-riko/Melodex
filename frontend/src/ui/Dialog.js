import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { cn } from './cn';

// 统一对话框基础件。
// 此前全站有 8 个手写 `div.fixed` 浮层,结果是:
//   · 只有 3 个支持 Esc 关闭
//   · 0 个有 role="dialog"/aria-modal(读屏完全不认识这是对话框)
//   · 0 个有焦点陷阱,打开后 Tab 会跑到背景按钮上
//   · 0 个在关闭后把焦点还给触发元素
//   · 0 个锁定背景滚动(滚轮会滚动 #app-main 里的列表)
// 这个组件一次性解决以上全部,后续所有浮层都走它。

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/**
 * @param {object} props
 * @param {boolean} props.open
 * @param {() => void} props.onClose
 * @param {string} [props.title] 可访问名称(无可见标题时也必须给)
 * @param {string} [props.labelledBy] 指向可见标题的 id
 * @param {'sm'|'md'|'lg'|'xl'} [props.size]
 * @param {boolean} [props.dismissable] 点遮罩/Esc 是否可关
 * @param {boolean} [props.showClose] 右上角关闭按钮
 * @param {string} [props.className] 面板额外 class
 * @param {React.ReactNode} props.children
 */
export default function Dialog({
  open,
  onClose,
  title,
  labelledBy,
  size = 'md',
  dismissable = true,
  showClose = true,
  className = '',
  panelClassName = '',
  children,
}) {
  const panelRef = useRef(null);
  const restoreFocusRef = useRef(null);
  const titleIdRef = useRef(`dlg-${Math.random().toString(36).slice(2, 9)}`);

  // 打开时记住触发元素,关闭时还焦点;同时锁背景滚动。
  useLayoutEffect(() => {
    if (!open) return undefined;
    restoreFocusRef.current = document.activeElement;
    return () => {
      const target = restoreFocusRef.current;
      if (target && typeof target.focus === 'function' && document.contains(target)) {
        // 延迟一帧:避免与正在卸载的节点抢焦点
        window.requestAnimationFrame(() => target.focus());
      }
    };
  }, [open]);

  // 背景滚动锁定。app-shell 的滚动容器是 #app-main,不是 body,两处都要处理。
  useEffect(() => {
    if (!open) return undefined;
    const main = document.getElementById('app-main');
    const prevMainOverflow = main ? main.style.overflow : '';
    const prevBodyOverflow = document.body.style.overflow;
    if (main) main.style.overflow = 'hidden';
    document.body.style.overflow = 'hidden';
    return () => {
      if (main) main.style.overflow = prevMainOverflow;
      document.body.style.overflow = prevBodyOverflow;
    };
  }, [open]);

  // Esc 关闭 + 焦点陷阱
  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event) => {
      if (event.key === 'Escape' && dismissable) {
        event.stopPropagation();
        onClose?.();
        return;
      }
      if (event.key !== 'Tab') return;
      const panel = panelRef.current;
      if (!panel) return;
      const nodes = Array.from(panel.querySelectorAll(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null || el === document.activeElement,
      );
      if (nodes.length === 0) {
        event.preventDefault();
        panel.focus();
        return;
      }
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !panel.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !panel.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [open, dismissable, onClose]);

  // 打开时把焦点移进面板(优先第一个带 data-autofocus 的元素)
  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    if (!panel) return;
    const preferred = panel.querySelector('[data-autofocus]');
    const nodes = Array.from(panel.querySelectorAll(FOCUSABLE)).filter(
      (el) => el.offsetParent !== null,
    );
    const target = preferred || nodes[0] || panel;
    window.requestAnimationFrame(() => target.focus());
  }, [open]);

  if (!open) return null;

  const SIZES = {
    sm: 'max-w-sm',
    md: 'max-w-md',
    lg: 'max-w-2xl',
    xl: 'max-w-4xl',
  };

  return (
    <div
      className="fixed inset-0 z-modal flex items-center justify-center bg-black/60 p-4 animate-fade-in"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && dismissable) onClose?.();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy || (title ? titleIdRef.current : undefined)}
        aria-label={!labelledBy && !title ? '对话框' : undefined}
        tabIndex={-1}
        className={cn(
          'w-full rounded-lg border border-border bg-popover text-popover-foreground shadow-dialog',
          'max-h-[85dvh] overflow-y-auto scroll-area',
          'animate-pop-in focus:outline-none',
          SIZES[size],
          className,
          panelClassName,
        )}
      >
        {(title || showClose) && (
          <div className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
            <div className="min-w-0">
              {title && (
                <h2 id={labelledBy || titleIdRef.current} className="type-section text-foreground">
                  {title}
                </h2>
              )}
            </div>
            {showClose && (
              <button
                type="button"
                onClick={onClose}
                aria-label="关闭"
                className="-mr-1 flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors duration-base hover:bg-secondary hover:text-foreground"
              >
                <X size={18} />
              </button>
            )}
          </div>
        )}
        <div className="p-4">{children}</div>
      </div>
    </div>
  );
}
