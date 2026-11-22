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

/** 桌面歌词：页面监听歌词窗按钮命令的 DOM 事件名（与 Rust 侧约定一致）。 */
export const SHELL_LYRICS_COMMAND_EVENT = 'melodex:lyrics-command';

/** 歌词窗按钮可能发来的命令白名单。 */
export const SHELL_LYRICS_COMMANDS = ['prev', 'toggle', 'next'];

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

/**
 * 取壳内的 invoke 函数。
 *
 * Tauri 2 把命令通道挂在 `__TAURI_INTERNALS__.invoke`（旧版是 `__TAURI__.core.invoke`），
 * 两者都兼容；取不到就返回 null，让调用方降级而不是抛错。
 */
export const getShellInvoke = (scope = globalThis) =>
  scope?.__TAURI_INTERNALS__?.invoke
  || scope?.__TAURI__?.core?.invoke
  || null;

/**
 * 把一条歌词状态推给本机歌词窗。
 *
 * 只在壳内生效；浏览器里直接返回 false，不做任何网络/存储操作。
 * 失败只记日志——歌词窗没开、壳版本旧都不该影响播放。
 *
 * @returns {Promise<boolean>} 是否已交给壳
 */
export const pushLyricsState = async (state, options = {}) => {
  const scope = options.scope || globalThis;
  const logger = options.logger || console;
  if (!isDesktopShell(scope)) return false;

  const invoke = options.invoke || getShellInvoke(scope);
  if (typeof invoke !== 'function') return false;
  if (!state || (state.type !== 'track' && state.type !== 'progress')) {
    logger.warn('歌词状态类型非法，已丢弃', state?.type);
    return false;
  }

  try {
    await invoke('lyrics_push_state', { state });
    return true;
  } catch (error) {
    logger.warn('推送桌面歌词状态失败', error);
    return false;
  }
};

/**
 * 监听歌词窗发来的播放控制命令。
 *
 * 壳用 `eval` 派发 DOM 事件，因此远程页面**不需要任何 IPC 权限**即可接收。
 * 浏览器里完全惰性。
 *
 * @returns {() => void} 取消监听；非壳环境返回空函数
 */
export const attachLyricsCommandBridge = (handlers, options = {}) => {
  const scope = options.scope || globalThis;
  const logger = options.logger || console;
  if (!isDesktopShell(scope)) return () => {};

  const target = scope.window || scope;
  if (typeof target?.addEventListener !== 'function') return () => {};

  const onCommand = (event) => {
    const raw = event?.detail?.command;
    if (typeof raw !== 'string' || !SHELL_LYRICS_COMMANDS.includes(raw)) {
      logger.warn('收到无法识别的桌面歌词命令', event?.detail);
      return;
    }
    const handler = handlers?.[raw];
    if (typeof handler !== 'function') {
      logger.warn(`桌面歌词命令缺少处理器: ${raw}`);
      return;
    }
    try {
      handler();
    } catch (error) {
      logger.warn(`桌面歌词命令执行失败: ${raw}`, error);
    }
  };

  target.addEventListener(SHELL_LYRICS_COMMAND_EVENT, onCommand);
  return () => target.removeEventListener(SHELL_LYRICS_COMMAND_EVENT, onCommand);
};
