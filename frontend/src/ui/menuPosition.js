// 弹出菜单的几何计算(纯函数,便于单测;不依赖 DOM)。
//
// 这些计算写错的表现是"菜单凭空出现在页面中间"或"菜单越过侧栏分割线压到主内容区"
// —— 构建与门禁都抓不到,只能靠肉眼。所以把「选边界 → 算 left/top → 决定上下翻转」
// 抽出来并加契约测试。

export const VIEWPORT_MARGIN = 8;

/**
 * 选择「可摆放区域」。
 *
 * 语义:菜单应该出现在**它所属的那个面板**里,而不是整个窗口里。
 * 侧栏「我的歌单」的「+」菜单就该被侧栏的右分割线挡住,不能压到主内容区。
 *
 * 所以优先用 `clippingRect` —— 调用方传进来的「锚点最近的裁切祖先」
 * (侧栏 aside 有 overflow-y-auto、主内容区 #app-main 也是),那才是视觉上的容器边界。
 * 只有在没有裁切祖先、或容器本身比面板还窄(放不下)时才退回视口。
 *
 * 历史 bug:早先无条件用 #app-main,而侧栏按钮不在其中 → 菜单被推进主区;
 * 后来改成"不在主区就用视口" → 菜单又以视口为界,照样越过侧栏分割线。
 * 两次都错在同一件事:没把"菜单属于哪个容器"当成边界。
 */
export function pickBoundary({ clippingRect, viewport, panelWidth, margin = VIEWPORT_MARGIN }) {
  if (clippingRect) {
    const availableWidth = clippingRect.right - clippingRect.left;
    if (Number.isFinite(availableWidth) && availableWidth >= panelWidth + margin * 2) {
      return clippingRect;
    }
  }
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
  // 面板比可用区域还宽时(极窄屏/极窄容器),退化为贴左,不要算出 maxLeft < minLeft
  const maxLeft = Math.max(minLeft, bound.right - panelWidth - margin);
  left = Math.max(minLeft, Math.min(left, maxLeft));

  const top = placement === 'up' ? anchorRect.top - margin : anchorRect.bottom + margin;
  return { top, left, placement };
}
