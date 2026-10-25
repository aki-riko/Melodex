// 弹出菜单的几何计算(纯函数,便于单测;不依赖 DOM)。
//
// 这些计算写错的表现是"菜单凭空出现在页面中间"—— 构建与门禁都抓不到,
// 只能靠肉眼。所以把「选边界 → 算 left/top → 决定上下翻转」抽出来并加契约测试。

export const VIEWPORT_MARGIN = 8;

/**
 * 锚点该以哪个矩形为「可摆放区域」。
 *
 * 真实踩坑:原先无条件用 #app-main(主滚动区)当边界,但侧栏「+」按钮不在它里面 ——
 * #app-main 左边缘就在侧栏右侧(x≈332),于是
 *   left = 按钮右边(310) - 面板宽(240) = 70
 *   clamp = max(8 + 332, 70) = 340
 * 菜单被硬推到主内容区,离按钮 300px,看起来完全错位。
 */
export function resolveBoundaryRect({ anchorInMain, viewport, mainRect }) {
  if (anchorInMain && mainRect) return mainRect;
  return viewport;
}

/**
 * 计算菜单的 fixed 定位。
 * @param {object} p
 * @param {{top:number,bottom:number,left:number,right:number}} p.anchorRect 锚点矩形
 * @param {{top:number,bottom:number,left:number,right:number}} p.boundary 可摆放区域
 * @param {number} p.panelWidth  面板实测宽度(不是估算值)
 * @param {number} p.panelHeight 面板实测高度
 * @param {'start'|'end'} [p.align] 'end' 表示面板右边对齐锚点右边
 * @param {number} [p.margin] 安全边距
 * @returns {{top:number, left:number, placement:'up'|'down'}}
 */
export function computeMenuPosition({
  anchorRect,
  boundary,
  panelWidth,
  panelHeight,
  align = 'end',
  margin = VIEWPORT_MARGIN,
}) {
  const bound = boundary || {
    top: 0,
    bottom: typeof window !== 'undefined' ? window.innerHeight : 0,
    left: 0,
    right: typeof window !== 'undefined' ? window.innerWidth : 0,
  };

  // 上下翻转:下方放不下、且上方更宽裕时向上展开
  const spaceBelow = bound.bottom - anchorRect.bottom;
  const spaceAbove = anchorRect.top - bound.top;
  const placement = spaceBelow < panelHeight + margin && spaceAbove > spaceBelow
    ? 'up'
    : 'down';

  let left = align === 'end' ? anchorRect.right - panelWidth : anchorRect.left;
  const minLeft = bound.left + margin;
  // 面板比可用区域还宽时(极窄屏),退化为贴左,不要算出 maxLeft < minLeft
  const maxLeft = Math.max(minLeft, bound.right - panelWidth - margin);
  left = Math.max(minLeft, Math.min(left, maxLeft));

  const top = placement === 'up' ? anchorRect.top - margin : anchorRect.bottom + margin;
  return { top, left, placement };
}
