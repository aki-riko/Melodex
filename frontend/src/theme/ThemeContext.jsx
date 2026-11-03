import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DEFAULT_THEME_ID,
  THEME_STORAGE_KEY,
  applyThemeToDocument,
  getTheme,
  normalizeThemeId,
  readStoredThemeId,
  writeStoredThemeId,
} from './themes.js';

// 全局主题态。设计原则:
//   · 主题只是 documentElement 上的 data-theme,所有色值/圆角/材质都由 index.css 决定;
//   · 默认值在 index.html 的启动脚本里就已写进 <html data-theme>,这里只做后续同步,
//     因此首屏不会闪一下默认主题再跳变;
//   · 读写 Storage 失败(无痕模式)时当前会话照常生效,不抛错。

/** 取当前浏览器 Storage,拿不到就返回 null(调用方各自兜底)。 */
function safeStorage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

const ThemeContext = React.createContext(null);
ThemeContext.displayName = 'ThemeContext';

export function ThemeProvider({ children, storage }) {
  // 首帧直接读已生效的 data-theme(启动脚本写过),再退回 Storage / 默认值。
  const [themeId, setThemeId] = useState(() => {
    const fromDocument = typeof document !== 'undefined'
      ? document.documentElement.getAttribute('data-theme')
      : null;
    if (fromDocument) return normalizeThemeId(fromDocument);
    return readStoredThemeId(storage || safeStorage());
  });

  // storage 可能在测试里被替换;用 ref 保证调用时取最新,不因再渲染重放 effect。
  const storageRef = useRef(storage);
  storageRef.current = storage;

  useEffect(() => {
    applyThemeToDocument(document, themeId);
  }, [themeId]);

  // 多标签页/多窗口同步:另一处改了主题,这边跟着变(不写回 Storage,避免来回打乒乓)。
  useEffect(() => {
    const onStorage = (event) => {
      if (event.key !== THEME_STORAGE_KEY) return;
      setThemeId(normalizeThemeId(event.newValue));
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const setTheme = useCallback((id) => {
    const normalized = normalizeThemeId(id);
    writeStoredThemeId(storageRef.current || safeStorage(), normalized);
    setThemeId(normalized);
    return normalized;
  }, []);

  const value = useMemo(() => ({
    themeId,
    theme: getTheme(themeId),
    isDefault: themeId === DEFAULT_THEME_ID,
    setTheme,
  }), [themeId, setTheme]);

  return React.createElement(ThemeContext.Provider, { value }, children);
}

/** 主题态。未包 Provider 时给默认主题的安全回落(而不是抛错整页白屏)。 */
export function useTheme() {
  const ctx = React.useContext(ThemeContext);
  if (ctx) return ctx;
  const theme = getTheme(DEFAULT_THEME_ID);
  return {
    themeId: theme.id,
    theme,
    isDefault: true,
    setTheme: () => getTheme(DEFAULT_THEME_ID).id,
  };
}

export default ThemeContext;
