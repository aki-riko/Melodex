import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const frontendRoot = resolve(scriptDir, '..');
const srcRoot = resolve(frontendRoot, 'src');

// 浮层坐标系契约。
//
// ---- 为什么要有这条门禁(2026-11 用户截图反馈的真 bug)----
// 用户报:「歌单页点『更多』,菜单出现在按钮右下方几百像素外,完全脱钩」。
//
// 真凶是 CSS 的一条陷阱,不是几何计算写错:
//   任何 transform / filter / backdrop-filter / will-change 不为 none 的祖先,
//   都会成为 position:fixed 后代的 **containing block**(CSS Containment 规范)。
//   此时 fixed 元素不再相对视口,而是相对那个祖先的 padding box。
//
// 本应用恰好踩中:index.css 的
//   `.fluent-page-enter > * > *  { animation: fluent-page-rise … both }`
// 给页面内部每个块(含各页 <header>)上了动画,而 keyframe 终态是
//   `transform: translateY(0)`,**fill-mode:both 让它永久留在元素上**。
// translateY(0) 不是 none,于是页面 header 成了 fixed 参照系;而
// menuPosition.js 算的是视口坐标 → 被按 header 的坐标系解释 → 整体偏移。
//
// 结论(本门禁锁住的规则):
//   **凡是在页面内容树里的浮层,必须 Portal 到 document.body。**
//   挂在 body 下没有任何祖先能改坐标系,fixed 才真的是视口坐标。
//   只改 CSS 的 fill-mode 治不干净 —— 动画播放期间 transform 仍在(仍然劫持),
//   而且任何新加的动画/滤镜都会重新引入这个坑。
//
// 允许不在页面树里的浮层不 Portal:它们本来就挂在 AppShell 页面容器之外
// (播放条 / 反馈 Provider),没有 transform 祖先。逐个列出来,新增必须显式登记。

const OVERLAY_PORTAL_ALLOWLIST = new Map([
  [
    'contexts/PlayerContext.js',
    '播放条/播放页挂在 AppShell 的页面容器之外(App.js 里与页面 div 同级),无 transform 祖先',
  ],
  [
    'contexts/FeedbackContext.js',
    'FeedbackProvider 包住 AuthedApp,弹出层与 AppShell 同级,无 transform 祖先',
  ],
  [
    'components/Settings.js',
    '已知债务:扫码/手填 Cookie 两个遮罩渲染在页面树内,同源 bug(fixed inset-0 当前只盖住 header),待单独修复',
  ],
]);

const walk = (dir, out = []) => {
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) walk(abs, out);
    else if (/\.(js|jsx)$/.test(entry)) out.push(abs);
  }
  return out;
};

// ---- 1. Portal 基元必须存在,且只能挂 document.body ----
const portalPath = resolve(srcRoot, 'ui', 'Portal.js');
let portalSource = '';
try {
  portalSource = readFileSync(portalPath, 'utf8');
} catch {
  assert.fail('缺少 src/ui/Portal.js —— 浮层没有统一的 body 出口');
}

assert.ok(
  /createPortal\s*\(\s*children\s*,\s*document\.body\s*\)/.test(portalSource),
  'Portal 必须 createPortal(children, document.body) —— 挂到别的容器仍可能落在 transform 祖先下',
);

// ---- 2. 菜单浮层必须走 Portal,且 fixed 面板在 Portal 之内 ----
const menuSource = readFileSync(resolve(srcRoot, 'ui', 'Menu.js'), 'utf8');
assert.ok(
  /import Portal from '\.\/Portal'/.test(menuSource),
  'Menu.js 必须引入 Portal —— 行内「更多」菜单与歌曲行菜单都在页面树里,会被动画 transform 劫持',
);
{
  const portalOpen = menuSource.indexOf('<Portal>');
  const portalClose = menuSource.indexOf('</Portal>');
  const fixedPanel = menuSource.indexOf("position: 'fixed'");
  assert.ok(portalOpen >= 0 && portalClose > portalOpen, 'Menu.js 的 fixed 面板没有被 <Portal> 包住');
  assert.ok(
    fixedPanel > portalOpen && fixedPanel < portalClose,
    'Menu.js 的 position:fixed 面板必须在 <Portal> 内部 —— 否则它仍以页面祖先为参照系',
  );
}

// ---- 3. 对话框必须走 Portal(遮罩的 fixed inset-0 要真盖满视口)----
const dialogSource = readFileSync(resolve(srcRoot, 'ui', 'Dialog.js'), 'utf8');
assert.ok(
  /import Portal from '\.\/Portal'/.test(dialogSource),
  'Dialog.js 必须引入 Portal —— 遮罩 fixed inset-0 在页面树里只会盖住 header 那一块',
);
{
  const portalOpen = dialogSource.indexOf('<Portal>');
  // 从 <Portal> 之后开始找 —— 注释里也会提到 "fixed inset-0"(解释 bug 原因时写的),不能误判。
  const overlay = dialogSource.indexOf('fixed inset-0', portalOpen);
  assert.ok(portalOpen >= 0, 'Dialog.js 没有使用 <Portal>');
  assert.ok(
    overlay > portalOpen,
    'Dialog.js 的全屏遮罩必须在 <Portal> 内部',
  );
}

// ---- 4. 新增的页面内全屏浮层必须显式登记 ----
// 扫描所有「整屏 fixed 浮层」(fixed inset-0) 与「inline position:fixed」,
// 位于页面树内却没 Portal 的,只有在白名单里才放过 —— 逼后来者做一次明确决定,
// 而不是悄悄再引入一个同样的错位 bug。
//
// 必须剥注释再扫:这些文件与 Portal.js 的注释里大量出现 `fixed inset-0` /
// `position: fixed` 用来解释 bug 成因(本门禁第一版就被自己的说明文字绊倒)。
const stripComments = (text) => text
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:\\])\/\/[^\n]*/g, '$1 ');

const overlayPattern = /fixed inset-0|position:\s*'fixed'/;
const violations = [];
for (const file of walk(srcRoot)) {
  const rel = relative(srcRoot, file).split('\\').join('/');
  const code = stripComments(readFileSync(file, 'utf8'));
  if (!overlayPattern.test(code)) continue;
  const hasPortal = /import Portal from /.test(code) && /<Portal>/.test(code);
  if (hasPortal) continue;
  if (OVERLAY_PORTAL_ALLOWLIST.has(rel)) continue;
  violations.push(rel);
}
assert.deepEqual(
  violations,
  [],
  '这些文件里有 fixed 浮层却没 Portal 到 body,也没在 OVERLAY_PORTAL_ALLOWLIST 里登记理由:\n' +
  `${violations.map((v) => `  · ${v}`).join('\n')}\n` +
  '若它不在页面内容树里(无 transform 祖先),请连理由一起加进白名单;否则套上 <Portal>。',
);

// ---- 5. (刻意不做的检查)----
// 曾想顺手加一条「禁止 animation 用 forwards/both 把 transform 永久钉住」,
// 试跑后立刻否掉:它把 `.player-sheet-exit { animation: player-slide-down … forwards }`
// 判成了违规 —— 但那是**退场动画**,播完组件就卸载了,forwards 正是它该有的语义。
// 这类"元素会不会成为 fixed 后代坐标系"的问题,看单个 CSS 规则判断不了,
// 取决于它**是不是某个浮层的祖先、且那个浮层是否已 Portal**。
// 与其写一条会误伤正确代码的模糊规则,不如把力气放在上面 1~4 条:
// Portal 化 + 白名单登记,已经能挡住真实的回归路径。

console.log('overlayPortal tests passed');
