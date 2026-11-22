/**
 * 桌面壳（Tauri）薄桥接。
 *
 * 职责只有一个：把壳侧派发的 `melodex:shell-shortcut` DOM 事件翻译成播放器动作。
 *
 * 三条纪律：
 * 1. **浏览器里必须完全惰性**——不在 Tauri 壳内时本模块不注册任何监听、不触碰任何全局。
 * 2. **不依赖任何 IPC 命令**：壳用 `eval` 派发 DOM 事件，所以远程页面无需任何本地权限。
 * 3. **不吞错**：动作处理器缺失或抛错都要留下日志，便于排查「按了没反应」。
 */

export const SHELL_SHORTCUT_EVENT = 'melodex:shell-shortcut';

/** 壳侧支持的动作名。 */
export const SHELL_ACTIONS = {
  TOGGLE: 'toggle',
  PREV: 'prev',
  NEXT: 'next',
};

/**
 * 判断当前是否运行在桌面壳内。
 *
 * Tauri 注入的全局对象在不同配置下可能叫 `__TAURI__` 或 `__TAURI_INTERNALS__`，
 * 两者都检查；但**不做任何假设性写入**。
 */
export const isDesktopShell = (scope = globalThis) =>
  Boolean(scope?.__TAURI__ || scope?.__TAURI_INTERNALS__);

/**
 * 把事件 detail 解析成动作名。非法输入返回 null，不抛错。
 */
export const normalizeShellAction = (rawDetail) => {
  const action = typeof rawDetail === 'string' ? rawDetail : rawDetail?.action;
  if (typeof action !== 'string') return null;
  const known = Object.values(SHELL_ACTIONS);
  return known.includes(action) ? action : null;
};

/**
 * 挂载桥接。
 *
 * @param {object} handlers 动作处理器，键为动作名（toggle/prev/next）。
 * @param {object} [options]
 * @param {object} [options.scope] 测试注入用，默认 `globalThis`。
 * @param {object} [options.logger] 默认 `console`。
 * @returns {() => void} 取消挂载函数；不在壳内时返回空函数。
 */
export const attachDesktopShellBridge = (handlers, options = {}) => {
  const scope = options.scope || globalThis;
  const logger = options.logger || console;

  if (!isDesktopShell(scope)) return () => {};

  const target = scope.window || scope;
  if (typeof target?.addEventListener !== 'function') return () => {};

  const onShortcut = (event) => {
    const action = normalizeShellAction(event?.detail);
    if (!action) {
      logger.warn('收到无法识别的桌面壳快捷键动作', event?.detail);
      return;
    }
    const handler = handlers?.[action];
    if (typeof handler !== 'function') {
      logger.warn(`桌面壳快捷键动作缺少处理器: ${action}`);
      return;
    }
    try {
      handler();
    } catch (error) {
      logger.warn(`桌面壳快捷键动作执行失败: ${action}`, error);
    }
  };

  target.addEventListener(SHELL_SHORTCUT_EVENT, onShortcut);
  return () => target.removeEventListener(SHELL_SHORTCUT_EVENT, onShortcut);
};
