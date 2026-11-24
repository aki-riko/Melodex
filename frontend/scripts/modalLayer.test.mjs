// 内联模态弹窗的可访问性契约(2026-11 全库扫描补充)。
//
// 背景:Settings.js 里「扫码登录」和「手填 Cookie」两个弹窗是手写的 fixed 遮罩,
// 四件事一个都没有 —— 没有 role="dialog"/aria-modal(读屏不知道这是弹窗)、
// 没有 Esc(键盘用户进得去出不来)、没有焦点陷阱(Tab 会跑到遮罩背后)、
// 没有 useBackLayer(安卓返回键直接退站)。而项目自己的 ui/Dialog.js 四件都有,
// 说明这是"后期手写的浮层漏了规范",不是刻意的设计。
//
// 已改为挂 ui/useModalLayer.js(只补行为,不动样式 —— 用户要求不改视觉)。
// 这条门禁锁住"每个手写模态遮罩都必须挂行为层",防止再长出第三个漏网的。
//
// 运行: node scripts/modalLayer.test.mjs

import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const frontendRoot = resolve(scriptDir, '..');
const srcRoot = resolve(frontendRoot, 'src');

const walk = (dir, out = []) => {
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) walk(abs, out);
    else if (/\.(js|jsx)$/.test(entry)) out.push(abs);
  }
  return out;
};

const read = (abs) => readFileSync(abs, 'utf8');

// ---- 1. hook 自身必须做齐四件事 ----
const hookSource = read(resolve(srcRoot, 'ui/useModalLayer.js'));
for (const [needle, why] of [
  ['useBackLayer({', '返回键:安卓/浏览器后退必须先关弹窗,不能直接退站'],
  ["event.key === 'Escape'", 'Esc:键盘用户必须能关闭'],
  ["event.key !== 'Tab'", '焦点陷阱:Tab 不能跑到遮罩背后的控件上'],
  ['return panelRef', '打开时必须把焦点移进面板,否则读屏从页面顶部开始念'],
]) {
  assert.ok(hookSource.includes(needle), `useModalLayer 缺少 ${why}(找不到 ${needle})`);
}
// 反向:不能只是注释里提一嘴 —— 必须是真实调用语句。
// (踩过的坑:最初用 includes('useBackLayer') 检查,把注释也算通过,
//  突变验证时删掉真实调用门禁仍然绿。)
assert.match(
  hookSource,
  /^\s*useBackLayer\(\{/m,
  'useBackLayer 必须是真实的 hook 调用(行首缩进 + 调用括号),不能只出现在注释里',
);

// ---- 2. Settings 的两个手写弹窗必须挂上行为层 ----
const settings = read(resolve(srcRoot, 'components/Settings.js'));
assert.match(settings, /useModalLayer\(/, 'Settings 的手写弹窗必须挂 useModalLayer');

// 每个 `fixed inset-0 z-modal` 的遮罩,其内层面板都要有 role="dialog"
const modalMasks = [...settings.matchAll(/fixed inset-0 z-modal/g)];
assert.ok(modalMasks.length >= 2, `Settings 里应有 ≥2 个手写模态遮罩,实测 ${modalMasks.length}`);

const dialogRoles = [...settings.matchAll(/role="dialog"/g)];
assert.equal(
  dialogRoles.length,
  modalMasks.length,
  `手写模态遮罩(${modalMasks.length} 个)与 role="dialog"(${dialogRoles.length} 个)数量必须一致 ——`
  + ' 少了哪个,读屏软件就不会把它播报成弹窗',
);

const ariaModals = [...settings.matchAll(/aria-modal="true"/g)];
assert.equal(
  ariaModals.length,
  modalMasks.length,
  `手写模态遮罩(${modalMasks.length} 个)与 aria-modal(${ariaModals.length} 个)数量必须一致`,
);

// ---- 3. 全库扫:任何手写模态遮罩都不得绕过行为层 ----
//
// 例外:ui/Dialog.js 自己就是规范实现(它内部已含 useBackLayer + Esc + 焦点陷阱),
// 不要求它再调 useModalLayer。
const offenders = [];
for (const file of walk(srcRoot)) {
  const rel = relative(frontendRoot, file).replace(/\\/g, '/');
  if (rel.endsWith('ui/Dialog.js') || rel.endsWith('ui/useModalLayer.js')) continue;
  const source = read(file);
  const masks = [...source.matchAll(/fixed inset-0 z-modal/g)];
  if (masks.length === 0) continue;
  // 该文件必须挂行为层,或至少有一条 useBackLayer(等价实现)
  const hasLayer = source.includes('useModalLayer') || source.includes('useBackLayer');
  if (!hasLayer) offenders.push(`${rel}(${masks.length} 个遮罩)`);
}
assert.deepEqual(
  offenders,
  [],
  `这些文件有手写模态遮罩但没挂行为层(缺 Esc/焦点陷阱/返回键): ${offenders.join(', ')}`,
);

console.log(
  '模态弹窗契约通过:useModalLayer 含返回键+Esc+焦点陷阱+移焦四件事;'
  + `Settings 的 ${modalMasks.length} 个手写遮罩均已挂行为层且带 role/aria-modal;`
  + ' 全库无绕过行为层的模态遮罩。',
);
