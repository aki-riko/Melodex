// 桌面壳薄桥接契约测试。
//
// 锁住三条纪律：
// 1. 浏览器环境（无 __TAURI__）必须完全惰性 —— 不注册任何监听。
// 2. 壳内才注册，且能正确解析动作、调用对应处理器。
// 3. 非法输入不抛错、不静默吞掉（要留下日志）。

import assert from 'node:assert/strict';
import {
  attachDesktopShellBridge,
  isDesktopShell,
  normalizeShellAction,
  SHELL_ACTIONS,
  SHELL_SHORTCUT_EVENT,
} from '../src/platform/desktopShell.js';

let passed = 0;
const test = (name, fn) => {
  fn();
  passed += 1;
  console.log(`  ok - ${name}`);
};

/** 极简 window 替身：只记录监听注册，用于断言"是否真的挂了监听"。 */
const fakeWindow = () => {
  const listeners = new Map();
  return {
    listeners,
    addEventListener: (type, handler) => {
      listeners.set(type, handler);
    },
    removeEventListener: (type, handler) => {
      if (listeners.get(type) === handler) listeners.delete(type);
    },
    dispatch: (type, event) => {
      const handler = listeners.get(type);
      if (handler) handler(event);
    },
  };
};

const silentLogger = { warn: () => {} };

test('浏览器环境判定为不在壳内', () => {
  assert.equal(isDesktopShell({}), false);
  assert.equal(isDesktopShell({ window: {} }), false);
});

test('壳环境（__TAURI__ 或 __TAURI_INTERNALS__）判定为在壳内', () => {
  assert.equal(isDesktopShell({ __TAURI__: {} }), true);
  assert.equal(isDesktopShell({ __TAURI_INTERNALS__: {} }), true);
});

test('浏览器环境下不注册任何监听（零副作用）', () => {
  const win = fakeWindow();
  const scope = { window: win };
  const dispose = attachDesktopShellBridge({ toggle: () => {} }, { scope, logger: silentLogger });
  assert.equal(win.listeners.size, 0, '浏览器里不应注册监听');
  assert.equal(typeof dispose, 'function');
  dispose();
  assert.equal(win.listeners.size, 0);
});

test('壳内注册单个监听并解析动作', () => {
  const win = fakeWindow();
  const scope = { __TAURI__: {}, window: win };
  const calls = [];
  attachDesktopShellBridge(
    { toggle: () => calls.push('toggle'), prev: () => calls.push('prev'), next: () => calls.push('next') },
    { scope, logger: silentLogger },
  );
  assert.equal(win.listeners.size, 1);
  assert.ok(win.listeners.has(SHELL_SHORTCUT_EVENT));

  win.dispatch(SHELL_SHORTCUT_EVENT, { detail: { action: SHELL_ACTIONS.TOGGLE } });
  win.dispatch(SHELL_SHORTCUT_EVENT, { detail: { action: SHELL_ACTIONS.PREV } });
  win.dispatch(SHELL_SHORTCUT_EVENT, { detail: { action: SHELL_ACTIONS.NEXT } });
  assert.deepEqual(calls, ['toggle', 'prev', 'next']);
});

test('取消挂载后不再响应', () => {
  const win = fakeWindow();
  const scope = { __TAURI__: {}, window: win };
  let count = 0;
  const dispose = attachDesktopShellBridge({ toggle: () => { count += 1; } }, { scope, logger: silentLogger });
  win.dispatch(SHELL_SHORTCUT_EVENT, { detail: { action: 'toggle' } });
  assert.equal(count, 1);
  dispose();
  win.dispatch(SHELL_SHORTCUT_EVENT, { detail: { action: 'toggle' } });
  assert.equal(count, 1, '取消后不应再触发');
});

test('非法动作被拒且记日志', () => {
  const warnings = [];
  const win = fakeWindow();
  const scope = { __TAURI__: {}, window: win };
  attachDesktopShellBridge({}, { scope, logger: { warn: (...args) => warnings.push(args) } });

  win.dispatch(SHELL_SHORTCUT_EVENT, { detail: { action: 'drop-tables' } });
  win.dispatch(SHELL_SHORTCUT_EVENT, { detail: null });
  win.dispatch(SHELL_SHORTCUT_EVENT, {});
  assert.equal(warnings.length, 3, '每次非法输入都应记录');
});

test('缺少处理器时记警告而不是抛错', () => {
  const warnings = [];
  const win = fakeWindow();
  const scope = { __TAURI__: {}, window: win };
  attachDesktopShellBridge({}, { scope, logger: { warn: (...args) => warnings.push(args) } });
  assert.doesNotThrow(() => {
    win.dispatch(SHELL_SHORTCUT_EVENT, { detail: { action: 'toggle' } });
  });
  assert.equal(warnings.length, 1);
  assert.match(String(warnings[0][0]), /缺少处理器/);
});

test('处理器抛错被捕获并记录，不冒泡', () => {
  const warnings = [];
  const win = fakeWindow();
  const scope = { __TAURI__: {}, window: win };
  attachDesktopShellBridge(
    { toggle: () => { throw new Error('boom'); } },
    { scope, logger: { warn: (...args) => warnings.push(args) } },
  );
  assert.doesNotThrow(() => {
    win.dispatch(SHELL_SHORTCUT_EVENT, { detail: { action: 'toggle' } });
  });
  assert.equal(warnings.length, 1);
  assert.match(String(warnings[0][0]), /执行失败/);
});

test('normalizeShellAction 接受裸字符串与对象两种形态', () => {
  assert.equal(normalizeShellAction('toggle'), 'toggle');
  assert.equal(normalizeShellAction({ action: 'next' }), 'next');
  assert.equal(normalizeShellAction({ action: 'unknown' }), null);
  assert.equal(normalizeShellAction(undefined), null);
  assert.equal(normalizeShellAction(42), null);
});

console.log(`\ndesktop shell bridge tests passed (${passed})`);
