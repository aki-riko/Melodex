import React, { useState } from 'react';
import { useAuth } from '../contexts/AuthContext';

// AuthGate:登录/初始化/注册页。根据后端状态切换模式:
//   - setupRequired → 初始化首个管理员(setup)
//   - 否则 → 登录(login),若开放注册则提供注册入口
const AuthGate = () => {
  const { setupRequired, allowRegistration, login, setup, register } = useAuth();
  const [mode, setMode] = useState(setupRequired ? 'setup' : 'login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [setupToken, setSetupToken] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const effectiveMode = setupRequired ? 'setup' : mode;

  const titles = {
    setup: '初始化管理员账号',
    login: '登录 Melodex',
    register: '注册新账号',
  };
  const buttons = { setup: '创建管理员', login: '登录', register: '注册' };

  const onSubmit = async (e) => {
    e.preventDefault();
    setError('');
    if (!username.trim() || !password) {
      setError('请输入用户名和密码');
      return;
    }
    if ((effectiveMode === 'setup' || effectiveMode === 'register') && password !== confirm) {
      setError('两次输入的密码不一致');
      return;
    }
    if (effectiveMode === 'setup' && !setupToken.trim()) {
      setError('请输入服务启动终端显示的初始化令牌');
      return;
    }
    setBusy(true);
    try {
      if (effectiveMode === 'setup') await setup(username.trim(), password, setupToken.trim());
      else if (effectiveMode === 'register') await register(username.trim(), password);
      else await login(username.trim(), password);
      // 成功后 AuthProvider.refresh 会切到主应用。
    } catch (err) {
      const msg = err?.response?.data?.error || '操作失败,请重试';
      setError(msg);
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background text-foreground px-4">
      <div className="w-full max-w-sm bg-card border border-border rounded-lg shadow-brutal p-6">
        <h1 className="text-2xl font-semibold mb-1">{titles[effectiveMode]}</h1>
        <p className="text-sm text-muted-foreground mb-5">
          {effectiveMode === 'setup'
            ? '系统尚无账号,创建首个管理员(ROOT)。'
            : '登录后即可使用你的歌单、收藏与本地库。'}
        </p>

        <form onSubmit={onSubmit} className="space-y-3">
          <input
            type="text"
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="用户名"
            className="w-full px-3 py-2 border border-border rounded-md bg-background outline-none focus:border-primary"
          />
          <input
            type="password"
            autoComplete={effectiveMode === 'login' ? 'current-password' : 'new-password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="密码(至少 6 位)"
            className="w-full px-3 py-2 border border-border rounded-md bg-background outline-none focus:border-primary"
          />
          {(effectiveMode === 'setup' || effectiveMode === 'register') && (
            <input
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder="确认密码"
              className="w-full px-3 py-2 border border-border rounded-md bg-background outline-none focus:border-primary"
            />
          )}
          {effectiveMode === 'setup' && (
            <input
              type="text"
              value={setupToken}
              onChange={(e) => setSetupToken(e.target.value)}
              placeholder="初始化令牌(见服务启动终端)"
              className="w-full px-3 py-2 border border-border rounded-md bg-background outline-none focus:border-primary"
            />
          )}
          {error && <p className="text-sm text-destructive font-medium">{error}</p>}
          <button
            type="submit"
            disabled={busy}
            className="w-full px-3 py-2 border border-border rounded-md bg-primary text-primary-foreground font-semibold shadow-brutal-sm transition-colors hover:bg-[#106EBE] disabled:opacity-60"
          >
            {busy ? '处理中…' : buttons[effectiveMode]}
          </button>
        </form>

        {!setupRequired && (
          <div className="mt-4 text-sm text-center text-muted-foreground">
            {effectiveMode === 'login' && allowRegistration && (
              <button onClick={() => { setMode('register'); setError(''); }} className="text-primary hover:underline">
                还没有账号?注册
              </button>
            )}
            {effectiveMode === 'register' && (
              <button onClick={() => { setMode('login'); setError(''); }} className="text-primary hover:underline">
                已有账号?登录
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default AuthGate;
