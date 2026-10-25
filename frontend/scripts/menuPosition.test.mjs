// ui/Menu 定位算法的契约测试。
//
// 为什么需要:菜单定位是纯几何计算,写错的表现是"菜单凭空出现在页面中间"
// 或"菜单越过侧栏分割线、压在主内容区上" —— 构建与门禁都抓不到,只能靠肉眼看。
// 这两个 bug 都真实发生过,所以把几何计算抽成纯函数并锁死语义。
//
// 语义一句话:**菜单只能出现在它所属的那个面板里** ——
// 侧栏「+」菜单以侧栏右分割线为切线,行内菜单以主内容区为界。

import { pickBoundary, computeMenuPosition, VIEWPORT_MARGIN } from '../src/ui/menuPosition.js';

let failures = 0;
const check = (cond, label, extra = '') => {
  if (!cond) {
    console.error(`FAIL ${label}${extra ? `\n  ${extra}` : ''}`);
    failures += 1;
  }
};

// 一次 792x593 窗口:侧栏 0~240,主内容区 240~792
const VIEWPORT = { top: 0, bottom: 593, left: 0, right: 792 };
const SIDEBAR = { top: 0, bottom: 593, left: 0, right: 240 };
const MAIN = { top: 56, bottom: 545, left: 240, right: 792 };
// 侧栏「+」按钮贴在右边缘
const anchorInSidebar = { top: 70, bottom: 102, left: 196, right: 232 };
const anchorInMain = { top: 200, bottom: 232, left: 600, right: 636 };

// ---- 1. pickBoundary:有裁切祖先就用它(哪怕它比视口小) ----
{
  const b = pickBoundary({ clippingRect: SIDEBAR, viewport: VIEWPORT, panelWidth: 192 });
  check(b === SIDEBAR, '有裁切祖先时应以它为边界(不得退回视口)', `got ${JSON.stringify(b)}`);
}
{
  const b = pickBoundary({ clippingRect: MAIN, viewport: VIEWPORT, panelWidth: 192 });
  check(b === MAIN, '主内容区锚点应以主区为边界', `got ${JSON.stringify(b)}`);
}
// ---- 2. 没有裁切祖先 → 视口 ----
{
  const b = pickBoundary({ clippingRect: null, viewport: VIEWPORT, panelWidth: 192 });
  check(b === VIEWPORT, '无裁切祖先时应退回视口', `got ${JSON.stringify(b)}`);
}
// ---- 3. 容器比面板还窄 → 退回视口(否则会被压成 0 宽) ----
{
  const narrow = { top: 0, bottom: 593, left: 0, right: 100 };
  const b = pickBoundary({ clippingRect: narrow, viewport: VIEWPORT, panelWidth: 192 });
  check(b === VIEWPORT, '容器装不下面板时应退回视口', `got ${JSON.stringify(b)}`);
}

// ---- 4. 核心回归:默认(裁切)模式下,侧栏菜单必须以分割线为切线 ----
{
  const boundary = pickBoundary({ clippingRect: SIDEBAR, viewport: VIEWPORT, panelWidth: 192 });
  const pos = computeMenuPosition({
    anchorRect: anchorInSidebar,
    boundary,
    panelWidth: 192,
    panelHeight: 168,
    align: 'end',
  });
  const menuRight = pos.left + 192;
  check(
    menuRight <= SIDEBAR.right - VIEWPORT_MARGIN,
    '裁切模式下侧栏菜单右边缘不得越过侧栏分割线',
    `menuRight=${menuRight}, 分割线=${SIDEBAR.right}`,
  );
  check(pos.left >= SIDEBAR.left + VIEWPORT_MARGIN, '菜单不得超出左边缘', `left=${pos.left}`);
}

// ---- 4b. spillRight 模式:菜单允许越过分割线、向右展开 ----
// 这是用户明确选择的行为:侧栏 240px 放不下 192px 菜单,
// "不越分割线"与"在按钮右边"无法同时成立,故选后者(避免向左展开盖住歌单列表)。
{
  const boundary = pickBoundary({ clippingRect: null, viewport: VIEWPORT, panelWidth: 192 });
  const pos = computeMenuPosition({
    anchorRect: anchorInSidebar, // 按钮右边 232,已到侧栏边缘
    boundary,
    panelWidth: 192,
    panelHeight: 168,
    align: 'start', // 左边缘对齐按钮左边 → 向右展开
  });
  check(pos.left === anchorInSidebar.left, 'spillRight 模式:菜单左边缘应贴按钮左边', `left=${pos.left}, want ${anchorInSidebar.left}`);
  const menuRight = pos.left + 192;
  check(menuRight > SIDEBAR.right, 'spillRight 模式:菜单应越过分隔线向右展开', `menuRight=${menuRight} vs 分割线=${SIDEBAR.right}`);
  check(menuRight <= VIEWPORT.right - VIEWPORT_MARGIN, '但仍不得溢出视口', `menuRight=${menuRight}`);
}

// ---- 4c. spillRight 也不能在窄屏上溢出右侧(会被 clamp 回来) ----
{
  const narrowViewport = { top: 0, bottom: 593, left: 0, right: 300 };
  const anchorNearEdge = { top: 70, bottom: 102, left: 200, right: 236 };
  const pos = computeMenuPosition({
    anchorRect: anchorNearEdge,
    boundary: narrowViewport,
    panelWidth: 192,
    panelHeight: 168,
    align: 'start',
  });
  check(pos.left + 192 <= 300 - VIEWPORT_MARGIN, '窄屏下必须被 clamp 进视口', `right=${pos.left + 192}`);
}

// ---- 5. 旧 bug 复现:若错误地用视口作边界,菜单就会越界 ----
// 这条是"反证"—— 它说明为什么 4 是必要的:同样的锚点,用视口算就会越过分割线。
{
  const wrong = computeMenuPosition({
    anchorRect: { top: 70, bottom: 102, left: 500, right: 536 }, // 假设按钮在主区
    boundary: VIEWPORT,
    panelWidth: 256,
    panelHeight: 200,
    align: 'end',
  });
  // 用视口时 left = 536-256 = 280,已经越过侧栏分割线 240
  check(wrong.left > SIDEBAR.right, '（反证）视口边界会让菜单越过侧栏分割线', `left=${wrong.left}`);
}

// ---- 6. 行内菜单仍以主内容区为界 ----
{
  const boundary = pickBoundary({ clippingRect: MAIN, viewport: VIEWPORT, panelWidth: 256 });
  const pos = computeMenuPosition({
    anchorRect: anchorInMain, boundary, panelWidth: 256, panelHeight: 320, align: 'end',
  });
  check(pos.left === 636 - 256, '行内菜单 left 应对齐按钮右边', `got ${pos.left}`);
  check(pos.left >= MAIN.left + VIEWPORT_MARGIN, '菜单不能越过主区左边缘', `left=${pos.left}`);
  check(pos.left + 256 <= MAIN.right - VIEWPORT_MARGIN, '菜单不能超出主区右边缘', `right=${pos.left + 256}`);
}

// ---- 7. 上下翻转 ----
{
  const boundary = { top: 0, bottom: 545, left: 0, right: 792 };
  const nearBottom = { top: 480, bottom: 512, left: 100, right: 136 };
  const pos = computeMenuPosition({ anchorRect: nearBottom, boundary, panelWidth: 192, panelHeight: 260, align: 'end' });
  check(pos.placement === 'up', '底部空间不足时应向上展开', `got ${pos.placement}`);
  check(pos.top === 480 - VIEWPORT_MARGIN, '向上展开时 top = 锚点 top - 边距', `got ${pos.top}`);
}
{
  const boundary = { top: 0, bottom: 545, left: 0, right: 792 };
  const middle = { top: 200, bottom: 232, left: 100, right: 136 };
  const pos = computeMenuPosition({ anchorRect: middle, boundary, panelWidth: 192, panelHeight: 260, align: 'end' });
  check(pos.placement === 'down', '中间位置应向下展开', `got ${pos.placement}`);
  check(pos.top === 232 + VIEWPORT_MARGIN, '向下展开时 top = 锚点 bottom + 边距', `got ${pos.top}`);
}

// ---- 8. 必须用实测面板宽度 ----
{
  const boundary = { top: 0, bottom: 545, left: 0, right: 792 };
  const anchor = { top: 100, bottom: 132, left: 700, right: 736 };
  const wide = computeMenuPosition({ anchorRect: anchor, boundary, panelWidth: 256, panelHeight: 100, align: 'end' });
  const narrow = computeMenuPosition({ anchorRect: anchor, boundary, panelWidth: 192, panelHeight: 100, align: 'end' });
  check(wide.left !== narrow.left, '不同面板宽度必须得到不同 left(证明用实测宽度)', `wide=${wide.left} narrow=${narrow.left}`);
}

// ---- 9. 贴边 clamp ----
{
  const boundary = { top: 0, bottom: 545, left: 0, right: 792 };
  const edge = { top: 100, bottom: 132, left: 770, right: 790 };
  const pos = computeMenuPosition({ anchorRect: edge, boundary, panelWidth: 256, panelHeight: 100, align: 'end' });
  check(pos.left + 256 <= 792 - VIEWPORT_MARGIN, '贴右边缘必须被 clamp 进视口', `right=${pos.left + 256}`);
}
{
  const boundary = { top: 0, bottom: 545, left: 0, right: 792 };
  const edge = { top: 100, bottom: 132, left: 2, right: 30 };
  const pos = computeMenuPosition({ anchorRect: edge, boundary, panelWidth: 256, panelHeight: 100, align: 'start' });
  check(pos.left >= VIEWPORT_MARGIN, '左边缘必须留出安全边距', `left=${pos.left}`);
}

if (failures > 0) {
  console.error(`\nmenuPosition 契约测试失败 ${failures} 项`);
  process.exitCode = 1;
} else {
  console.log('menuPosition 契约测试通过：容器边界 / 侧栏分割线切线 / 主区 clamp / 上下翻转 / 实测宽度 / 贴边安全距 全部符合预期。');
}
