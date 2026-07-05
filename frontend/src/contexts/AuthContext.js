import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { getMe, login as apiLogin, logout as apiLogout, setupAdmin, register as apiRegister } from '../services/musicdl';

const AuthContext = createContext(null);
const LAST_USER_KEY = 'melodex_last_known_user';

const loadLastKnown = () => {
  try {
    const raw = localStorage.getItem(LAST_USER_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
};

const saveLastKnown = (snapshot) => {
  try {
    localStorage.setItem(LAST_USER_KEY, JSON.stringify(snapshot));
  } catch { /* 本地存储不可用时不影响在线登录 */ }
};

const clearLastKnown = () => {
  try { localStorage.removeItem(LAST_USER_KEY); } catch { /* ignore */ }
};

// AuthProvider 在应用启动时拉取 /api/v1/me 判断登录态,向下提供当前用户与登录/登出操作。
// 未登录 → 渲染登录/初始化页;登录后 → 渲染主应用(见 App.js)。
export const AuthProvider = ({ children }) => {
  const refreshInFlightRef = useRef(null);
  const [state, setState] = useState({
    loading: true,
    authenticated: false,
    user: null,
    setupRequired: false,
    allowRegistration: false,
    desktop: false,
    offline: false,
  });

  const refresh = useCallback(() => {
    if (refreshInFlightRef.current) return refreshInFlightRef.current;

    const run = (async () => {
      try {
        const me = await getMe();
        const nextState = {
          loading: false,
          authenticated: !!me.authenticated,
          user: me.user || null,
          setupRequired: !!me.setupRequired,
          allowRegistration: !!me.allowRegistration,
          desktop: !!me.desktop,
          offline: false,
        };
        if (nextState.authenticated && nextState.user) {
          saveLastKnown({
            user: nextState.user,
            desktop: nextState.desktop,
            savedAt: new Date().toISOString(),
          });
        } else {
          clearLastKnown();
        }
        setState(nextState);
      } catch (e) {
        const status = e?.response?.status || 0;
        const cached = (!e?.response || status >= 500) ? loadLastKnown() : null;
        if (cached?.user?.id) {
          setState({
            loading: false,
            authenticated: true,
            user: cached.user,
            setupRequired: false,
            allowRegistration: false,
            desktop: !!cached.desktop,
            offline: true,
          });
          return;
        }
        setState((s) => ({ ...s, loading: false, authenticated: false, user: null, offline: false }));
      }
    })();

    refreshInFlightRef.current = run.finally(() => {
      refreshInFlightRef.current = null;
    });
    return refreshInFlightRef.current;
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // 全局 401 事件(会话过期):重新拉取 /me,失效则切回登录页。
  useEffect(() => {
    const onUnauthorized = () => { refresh(); };
    window.addEventListener('melodex:unauthorized', onUnauthorized);
    return () => window.removeEventListener('melodex:unauthorized', onUnauthorized);
  }, [refresh]);

  // 离线冷启动后,网络恢复时主动重新校验 /me,让 UI 回到在线权限态。
  useEffect(() => {
    const onOnline = () => { refresh(); };
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, [refresh]);

  const login = useCallback(async (username, password) => {
    const res = await apiLogin(username, password);
    await refresh();
    return res;
  }, [refresh]);

  const setup = useCallback(async (username, password, setupToken) => {
    const res = await setupAdmin(username, password, setupToken);
    await refresh();
    return res;
  }, [refresh]);

  const register = useCallback(async (username, password) => {
    const res = await apiRegister(username, password);
    await refresh();
    return res;
  }, [refresh]);

  const logout = useCallback(async () => {
    try {
      await apiLogout();
    } finally {
      clearLastKnown();
      await refresh();
    }
  }, [refresh]);

  const isAdmin = !state.offline && state.user?.role === 'admin';

  return (
    <AuthContext.Provider value={{ ...state, isAdmin, refresh, login, setup, register, logout }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
};
