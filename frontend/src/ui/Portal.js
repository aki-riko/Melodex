import React from 'react';
import { createPortal } from 'react-dom';

// 浮层出口:把浮层挂到 document.body,脱离页面内容树的坐标系。
//
// ---- 为什么必须这么做(踩过的真 bug,2026-11 用户截图反馈)----
// 「歌单页点『更多』,菜单出现在右下方几百像素外,和按钮完全脱钩」。
//
// 真凶不是 menuPosition 算错,是 CSS 的一条陷阱:
//   「任何 transform / filter / backdrop-filter / will-change 不为 none 的祖先,
//     都会成为 position:fixed 后代的 containing block」(CSS Containment 规范)。
// 此时 fixed 元素不再相对**视口**定位,而是相对**那个祖先的 padding box** 定位。
//
// 本应用恰好踩中:
//   index.css 的 `.fluent-page-enter > * > *` 给页面内部每个块(含各页 <header>)
//   上了 `animation: fluent-page-rise … both`,而该 keyframe 的终态是
//   `transform: translateY(0)` —— **fill-mode:both 让它永久留在元素上**,
//   translateY(0) 不是 none,于是页面 header 变成了 fixed 参照系。
//   行内菜单更惨:列表行是 `.space-y-0.5 > *`,终态 translateX(0),同样永久生效。
//
// 而 menuPosition.js 算的 left/top 是**视口坐标**,浏览器按 header 的坐标系解释 →
// 整体偏移一个"header 原点"。表现出来就是菜单凭空飘到下面。
// Dialog 的 `fixed inset-0` 同理:遮罩只盖住 header 那一块,而不是整屏。
//
// ---- 为什么不改成「顺手删掉 CSS 里的 transform」----
// 那只是碰运气:任何新加的祖先(动画、滤镜、卡片悬浮)都会重新触发。
// 浮层挂 body 是从结构上切断继承,body 没有 transform,用户永远拿到真视口。
// 这也是 Radix / Headless UI 等库默认 Portal 的原因。
//
// 用法:
//   <Portal>{ 浮层内容 }</Portal>
export default function Portal({ children }) {
  // 本应用是纯 SPA(index.html 只有 #root,无 SSR),document.body 在渲染期一定存在。
  // 保留兜底是为了万一将来做预渲染时不会直接抛 ReferenceError。
  if (typeof document === 'undefined') return null;
  return createPortal(children, document.body);
}
