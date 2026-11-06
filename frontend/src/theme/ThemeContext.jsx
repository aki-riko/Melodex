import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DARK_MEDIA_QUERY,
  DEFAULT_MODE,
  MODE_DESCRIPTIONS,
  THEME_STORAGE_KEY,
  applyThemeToDocument,
  getTheme,
  normalizeThemeMode,
  readStoredThemeMode,
  resolveThemeId,
  writeStoredThemeMode,
} from './themes.js';

// 全局主题态。
//
// 设计原则:
//   · 用户选的是**模式**(system / light / dark),不是皮肤 —— 全站只有 Fluent 一套;
//   · 写到 <html data-theme> 的是**解析后**的 id(fluent-light / fluent-dark),
//     由模式 + 系统偏好算出。组件只读 token,永远不需要知道用户选了什么模式;
//   · 首帧由 index.html 的内联脚本直接算好,React 挂载后只做后续同步 ——
//     否则选了深色的用户每次打开都会先闪一下浅色;
//   · 读写 Storage 失败(无痕模式)时当前会话照常生效,不抛错。

function safeStorage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

const ThemeContext = React.createContext(null);
ThemeContext.displayName = 'ThemeContext';

/** 读系统深浅色偏好。没有 matchMedia(测试环境)时按浅色处理。 */
function readPrefersDark() {
  try {
    return Boolean(window.matchMedia?.(DARK_MEDIA_QUERY)?.matches);
  } catch {
    return false;
  }
}

export function ThemeProvider({ children, storage }) {
  // 模式:首帧读 Storage。data-theme 已由 index.html 的内联脚本写好,
  // 这里不重复解析 —— 模式才是 React 该持有的状态。
  const [mode, setModeState] = useState(() => readStoredThemeMode(storage || safeStorage()));
  const [prefersDark, setPrefersDark] = useState(readPrefersDark);

  const storageRef = useRef(storage);
  storageRef.current = storage;

  const resolvedId = useMemo(() => resolveThemeId(mode, prefersDark), [mode, prefersDark]);

  useEffect(() => {
    applyThemeToDocument(document, resolvedId);
  }, [resolvedId]);

  // 跟随系统:监听器始终挂载 —— 用户从手动切回 system 时要立刻拿到最新值,
  // 那时再临时注册会有一帧用旧值的空窗。
  useEffect(() => {
    let query = null;
    try {
      query = window.matchMedia?.(DARK_MEDIA_QUERY) || null;
    } catch {
      query = null;
    }
    if (!query) return undefined;
    const onChange = (event) => setPrefersDark(Boolean(event.matches));
    // 新版浏览器用 addEventListener,旧版只有 addListener。
    if (typeof query.addEventListener === 'function') {
      query.addEventListener('change', onChange);
      return () => query.removeEventListener('change', onChange);
    }
    query.addListener?.(onChange);
    return () => query.removeListener?.(onChange);
  }, []);

  // 多标签页同步。注意存的是模式,不是解析结果。
  useEffect(() => {
    const onStorage = (event) => {
      if (event.key !== THEME_STORAGE_KEY) return;
      setModeState(normalizeThemeMode(event.newValue));
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const setMode = useCallback((next) => {
    const normalized = normalizeThemeMode(next);
    writeStoredThemeMode(storageRef.current || safeStorage(), normalized);
    setModeState(normalized);
    return normalized;
  }, []);

  const value = useMemo(() => ({
    mode,
    themeId: resolvedId,
    theme: getTheme(resolvedId),
    isSystem: mode === DEFAULT_MODE,
    modes: MODE_DESCRIPTIONS,
    setMode,
    /** 当前实际是深色还是浅色(解析后),给需要分支的少数场景用。 */
    isDark: resolvedId === 'fluent-dark',
  }), [mode, resolvedId, setMode]);

  return React.createElement(ThemeContext.Provider, { value }, children);
}

/** 主题态。未包 Provider 时给安全回落(而不是抛错整页白屏)。 */
export function useTheme() {
  const ctx = React.useContext(ThemeContext);
  if (ctx) return ctx;
  return {
    mode: DEFAULT_MODE,
    themeId: 'fluent-light',
    theme: getTheme('fluent-light'),
    isSystem: true,
    modes: MODE_DESCRIPTIONS,
    setMode: () => DEFAULT_MODE,
    isDark: false,
  };
}

export default ThemeContext;
