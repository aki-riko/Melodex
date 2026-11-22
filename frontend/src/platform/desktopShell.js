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

// ---------- 桌面歌词设置（主窗口「设置」页用）----------
//
// 与旧 PrismQML 实现对齐：那 6 项设置放在**主窗口的设置页**（SettingsPage.qml），
// 不是独立窗口——用户点「设置」就能看到。这里给网页侧提供同样的读写入口。
//
// 权限说明：只有 `lyrics_settings_get` / `lyrics_settings_update` 两条对主窗口开放，
// 语义自限（读写本机歌词设置），不涉及文件/网络/系统能力。见 capabilities/lyrics-bridge.json。

/** 设置变化事件名（壳侧广播，多窗口同步用）。 */
export const SHELL_LYRICS_SETTINGS_EVENT = 'melodex:lyrics-settings';

/**
 * 读取桌面歌词设置。
 *
 * 浏览器里返回 null（而不是抛错），让调用方按"无原生歌词"渲染。
 *
 * @returns {Promise<object|null>}
 */
export const getLyricsSettings = async (options = {}) => {
  const scope = options.scope || globalThis;
  const logger = options.logger || console;
  if (!isDesktopShell(scope)) return null;

  const invoke = options.invoke || getShellInvoke(scope);
  if (typeof invoke !== 'function') return null;

  try {
    return await invoke('lyrics_settings_get');
  } catch (error) {
    logger.warn('读取桌面歌词设置失败', error);
    return null;
  }
};

/**
 * 局部更新桌面歌词设置。
 *
 * 只传要改的字段（补丁语义）；返回更新后的完整设置，失败返回 null。
 * 壳侧写盘失败时**不会**改状态，所以这里不做乐观更新。
 *
 * @returns {Promise<object|null>}
 */
export const updateLyricsSettings = async (patch, options = {}) => {
  const scope = options.scope || globalThis;
  const logger = options.logger || console;
  if (!isDesktopShell(scope)) return null;
  if (!patch || typeof patch !== 'object') {
    logger.warn('歌词设置补丁非法，已丢弃', patch);
    return null;
  }

  const invoke = options.invoke || getShellInvoke(scope);
  if (typeof invoke !== 'function') return null;

  try {
    return await invoke('lyrics_settings_update', { patch });
  } catch (error) {
    logger.warn('保存桌面歌词设置失败', error);
    return null;
  }
};

/**
 * 重置歌词窗位置到默认（水平居中、垂直 76%）。
 *
 * @returns {Promise<object|null>}
 */
export const resetLyricsPosition = async (options = {}) => {
  const scope = options.scope || globalThis;
  const logger = options.logger || console;
  if (!isDesktopShell(scope)) return null;

  const invoke = options.invoke || getShellInvoke(scope);
  if (typeof invoke !== 'function') return null;

  try {
    return await invoke('lyrics_reset_position');
  } catch (error) {
    logger.warn('重置桌面歌词位置失败', error);
    return null;
  }
};

/**
 * 订阅歌词设置变化（设置窗/托盘改动时同步主窗口 UI）。
 *
 * @returns {() => void} 取消订阅；非壳环境返回空函数
 */
export const attachLyricsSettingsBridge = (handler, options = {}) => {
  const scope = options.scope || globalThis;
  const logger = options.logger || console;
  if (!isDesktopShell(scope)) return () => {};
  if (typeof handler !== 'function') return () => {};

  const target = scope.window || scope;
  if (typeof target?.addEventListener !== 'function') return () => {};

  // Tauri 的事件监听通过 __TAURI__.event.listen 注册，不是 DOM 事件。
  const listen = scope?.__TAURI__?.event?.listen;
  if (typeof listen !== 'function') return () => {};

  let unlisten = null;
  let disposed = false;

  listen(SHELL_LYRICS_SETTINGS_EVENT, (event) => {
    try {
      handler(event?.payload);
    } catch (error) {
      logger.warn('处理歌词设置事件失败', error);
    }
  })
    .then((fn) => {
      // 订阅完成前就被取消了：立即退订，避免泄漏。
      if (disposed) {
        if (typeof fn === 'function') fn();
        return;
      }
      unlisten = fn;
    })
    .catch((error) => logger.warn('订阅歌词设置事件失败', error));

  return () => {
    disposed = true;
    if (typeof unlisten === 'function') unlisten();
  };
};
