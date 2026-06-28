import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { getMe, login as apiLogin, logout as apiLogout, setupAdmin, register as apiRegister } from '../services/musicdl';

const AuthContext = createContext(null);

// AuthProvider 在应用启动时拉取 /api/v1/me 判断登录态,向下提供当前用户与登录/登出操作。
// 未登录 → 渲染登录/初始化页;登录后 → 渲染主应用(见 App.js)。
export const AuthProvider = ({ children }) => {
  const [state, setState] = useState({
    loading: true,
    authenticated: false,
    user: null,
    setupRequired: false,
    allowRegistration: false,
    desktop: false,
  });

  const refresh = useCallback(async () => {
    try {
      const me = await getMe();
      setState({
        loading: false,
        authenticated: !!me.authenticated,
        user: me.user || null,
        setupRequired: !!me.setupRequired,
        allowRegistration: !!me.allowRegistration,
        desktop: !!me.desktop,
      });
    } catch (e) {
      // 网络错误等:标记未登录但不阻塞展示(允许重试)。
      setState((s) => ({ ...s, loading: false, authenticated: false }));
    }
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
      await refresh();
    }
  }, [refresh]);

  const isAdmin = state.user?.role === 'admin';

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
