// ui/Menu 定位算法的契约测试。
//
// 为什么需要:菜单定位是纯几何计算,写错的表现是"菜单凭空出现在页面中间"
// —— 构建与门禁都抓不到,只能靠肉眼看。而这个 bug 已经真实发生过一次:
//
//   侧栏「+」按钮 x 区间约 [278, 310],`#app-main` 的左边缘在 332。
//   旧逻辑无条件拿 #app-main 当边界:
//     left = 310 - 240 = 70
//     clamp = max(8 + 332, 70) = 340   ← 比按钮右边还靠右 30px,看起来完全错位
//
// 所以把"选边界 + 算 left/top + 上下翻转"抽成纯函数,在这里锁死。

import { resolveBoundaryRect, computeMenuPosition } from '../src/ui/menuPosition.js';

let failures = 0;
const check = (cond, label, extra = '') => {
  if (!cond) {
    console.error(`FAIL ${label}${extra ? `\n  ${extra}` : ''}`);
    failures += 1;
  }
};

// 模拟一次 792x593 的窗口:侧栏 240px,主区从 x=332 开始(有 1px 边框视差忽略)
const VIEWPORT = { top: 0, bottom: 593, left: 0, right: 792 };
const MAIN_RECT = { top: 56, bottom: 545, left: 332, right: 792 };
const anchorInSidebar = { top: 70, bottom: 102, left: 278, right: 310 };
const anchorInMain = { top: 200, bottom: 232, left: 600, right: 636 };

// ---- 1. 选边界 ----
{
  // 锚点在侧栏 → 用视口,不能用 #app-main
  const b = resolveBoundaryRect({ anchorInMain: false, viewport: VIEWPORT, mainRect: MAIN_RECT });
  check(b.left === 0, '侧栏锚点应使用视口作为边界 left', `got left=${b.left}`);
  check(b.right === 792, '侧栏锚点边界 right 应为视口宽度', `got right=${b.right}`);
}
{
  // 锚点在主内容区 → 用 #app-main(它才是真正裁切/滚动的容器)
  const b = resolveBoundaryRect({ anchorInMain: true, viewport: VIEWPORT, mainRect: MAIN_RECT });
  check(b.left === 332, '主区锚点应用 #app-main 的 left', `got left=${b.left}`);
  check(b.bottom === 545, '主区锚点应用 #app-main 的 bottom', `got bottom=${b.bottom}`);
}

// ---- 2. 侧栏「+」菜单:必须贴着按钮左侧展开,不能被推到主区 ----
{
  const boundary = resolveBoundaryRect({ anchorInMain: false, viewport: VIEWPORT, mainRect: MAIN_RECT });
  const pos = computeMenuPosition({
    anchorRect: anchorInSidebar,
    boundary,
    panelWidth: 192,
    panelHeight: 168,
    align: 'end',
  });
  // align=end:面板右边对齐按钮右边 → left = 310 - 192 = 118
  check(pos.left === 118, '侧栏菜单 left 应对齐按钮右边', `got left=${pos.left}, want 118`);
  // 关键回归断言:不能让菜单跑到主内容区去(旧 bug 会得到 340)
  check(pos.left < anchorInSidebar.right, '菜单左边缘必须在按钮右边之内(不得被推到主区)', `left=${pos.left} vs anchor.right=${anchorInSidebar.right}`);
  check(pos.left >= 8, '菜单不能超出视口左侧安全边距', `left=${pos.left}`);
}

// ---- 3. 主内容区行内菜单:仍以 #app-main 为界 ----
{
  const boundary = resolveBoundaryRect({ anchorInMain: true, viewport: VIEWPORT, mainRect: MAIN_RECT });
  const pos = computeMenuPosition({
    anchorRect: anchorInMain,
    boundary,
    panelWidth: 256,
    panelHeight: 320,
    align: 'end',
  });
  check(pos.left === 636 - 256, '行内菜单 left 应对齐按钮右边', `got ${pos.left}`);
  check(pos.left >= 332 + 8, '菜单不能越过主区左边缘', `left=${pos.left}`);
  check(pos.left + 256 <= 792 - 8, '菜单不能超出视口右侧', `right=${pos.left + 256}`);
}

// ---- 4. 上下翻转 ----
{
  // 靠近容器底部 → 应向上展开
  const boundary = { top: 0, bottom: 545, left: 0, right: 792 };
  const nearBottom = { top: 480, bottom: 512, left: 100, right: 136 };
  const pos = computeMenuPosition({ anchorRect: nearBottom, boundary, panelWidth: 192, panelHeight: 260, align: 'end' });
  check(pos.placement === 'up', '底部空间不足时应向上展开', `got ${pos.placement}`);
  check(pos.top === 480 - 8, '向上展开时 top = 锚点 top - 边距', `got ${pos.top}`);
}
{
  // 上方空间也不足时,保持向下(总比无处可放好)
  const boundary = { top: 0, bottom: 545, left: 0, right: 792 };
  const middle = { top: 200, bottom: 232, left: 100, right: 136 };
  const pos = computeMenuPosition({ anchorRect: middle, boundary, panelWidth: 192, panelHeight: 260, align: 'end' });
  check(pos.placement === 'down', '中间位置应向下展开', `got ${pos.placement}`);
  check(pos.top === 232 + 8, '向下展开时 top = 锚点 bottom + 边距', `got ${pos.top}`);
}

// ---- 5. 必须用实测面板宽度,而不是写死值 ----
{
  const boundary = { top: 0, bottom: 545, left: 0, right: 792 };
  const anchor = { top: 100, bottom: 132, left: 700, right: 736 };
  const wide = computeMenuPosition({ anchorRect: anchor, boundary, panelWidth: 256, panelHeight: 100, align: 'end' });
  const narrow = computeMenuPosition({ anchorRect: anchor, boundary, panelWidth: 192, panelHeight: 100, align: 'end' });
  check(wide.left !== narrow.left, '不同面板宽度必须得到不同 left(证明用的是实测宽度)', `wide=${wide.left} narrow=${narrow.left}`);
  check(wide.left + 256 <= 792 - 8, '宽面板也不能溢出视口', `right=${wide.left + 256}`);
}

// ---- 6. 锚点贴近视口右边缘时的 clamp ----
{
  const boundary = { top: 0, bottom: 545, left: 0, right: 792 };
  const edge = { top: 100, bottom: 132, left: 770, right: 790 };
  const pos = computeMenuPosition({ anchorRect: edge, boundary, panelWidth: 256, panelHeight: 100, align: 'end' });
  check(pos.left + 256 <= 792 - 8, '贴右边缘时必须被 clamp 进视口', `right=${pos.left + 256}`);
}

// ---- 7. 锚点贴近视口左边缘 ----
{
  const boundary = { top: 0, bottom: 545, left: 0, right: 792 };
  const edge = { top: 100, bottom: 132, left: 2, right: 30 };
  const pos = computeMenuPosition({ anchorRect: edge, boundary, panelWidth: 256, panelHeight: 100, align: 'start' });
  check(pos.left >= 8, '左边缘时必须留出安全边距', `left=${pos.left}`);
}

if (failures > 0) {
  console.error(`\nmenuPosition 契约测试失败 ${failures} 项`);
  process.exitCode = 1;
} else {
  console.log('menuPosition 契约测试通过：边界选择 / 侧栏贴按钮 / 主区 clamp / 上下翻转 / 实测宽度 全部符合预期。');
}
