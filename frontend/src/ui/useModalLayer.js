// 模态浮层的"行为层"——只补可访问性与交互语义,**不碰任何样式**。
//
// 为什么单独抽出来:项目里 ui/Dialog.js 已经做对了(Esc + 焦点陷阱 + 打开时
// 移焦 + useBackLayer),但 Settings.js 里"扫码登录"和"手填 Cookie"这两个
// 弹窗是后来手写的 fixed 遮罩,四件事一个都没有:
//   · 没有 role="dialog"/aria-modal → 读屏软件不知道这是个弹窗;
//   · 没有 Esc → 键盘用户进得去出不来;
//   · 没有焦点陷阱 → Tab 会跑到遮罩背后的设置页控件上;
//   · 没有 useBackLayer → 安卓/浏览器返回键直接退站,不关弹窗。
//
// 那为什么不直接改成 <Dialog>?因为用户明确要求**不改视觉**,而 Dialog 自带
// 一整套卡片样式(flyout-in 动画 / shadow-dialog / 特定圆角与边框),换过去
// 观感会变。所以这里只搬"行为",样式与 DOM 结构原样保留。
//
// 用法:
//   const panelRef = useModalLayer({ open, onClose });
//   <div onClick={onClose}>                      ← 遮罩(原样)
//     <div ref={panelRef} role="dialog" aria-modal="true" ...>  ← 面板:ref + 三属性
//
// 注意 aria-label / aria-labelledby 由调用方给(它才知道标题文本),
// 这里不猜。本 hook 负责:Esc、焦点陷阱、打开时移焦、返回键。

import { useEffect, useRef } from 'react';
import { useBackLayer } from '../contexts/backNavigation.js';

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export function useModalLayer({ open, onClose, name = 'modal-layer' }) {
  const panelRef = useRef(null);

  // Esc 关闭 + Tab 焦点陷阱(与 ui/Dialog.js 同一套实现,保持行为一致)
  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
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
  }, [open, onClose]);

  // 打开时把焦点移进面板,否则读屏会从页面顶部开始念。
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

  // 安卓返回键 / 浏览器后退:先关弹窗,而不是直接退站。
  useBackLayer({
    active: open,
    name,
    onBack: () => { onClose?.(); },
  });

  return panelRef;
}
