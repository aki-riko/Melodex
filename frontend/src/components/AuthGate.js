import React, { useState } from 'react';
import { AlertCircle, Lock } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import Button from '../ui/Button';
import { Field, Input } from '../ui/Input';
import { cn } from '../ui/cn';

// AuthGate:登录/初始化/注册页。根据后端状态切换模式:
//   - setupRequired → 初始化首个管理员(setup)
//   - 否则 → 登录(login),若开放注册则提供注册入口
//
// 本轮修正:
//   · 主按钮曾用硬编码 `hover:bg-[#106EBE]`(旧蓝色主题残留,与 Spotify 绿冲突)
//   · 输入框曾只有 placeholder 当标签(输入后标签消失),且无字段级错误提示
//   · 错误曾用单一字符串依次覆盖,分不清是哪一项错了
const AuthGate = () => {
  const { setupRequired, allowRegistration, login, setup, register } = useAuth();
  const [mode, setMode] = useState(setupRequired ? 'setup' : 'login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [setupToken, setSetupToken] = useState('');
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState({});
  const [busy, setBusy] = useState(false);

  const effectiveMode = setupRequired ? 'setup' : mode;

  const titles = {
    setup: '初始化管理员账号',
    login: '登录 Melodex',
    register: '注册新账号',
  };
  const buttons = { setup: '创建管理员', login: '登录', register: '注册' };

  const clearFieldError = (key) => setFieldErrors((prev) => {
    if (!prev[key]) return prev;
    const next = { ...prev };
    delete next[key];
    return next;
  });

  const onSubmit = async (e) => {
    e.preventDefault();
    setError('');
    const next = {};
    if (!username.trim()) next.username = '请输入用户名';
    if (!password) next.password = '请输入密码';
    if ((effectiveMode === 'setup' || effectiveMode === 'register') && password && password !== confirm) {
      next.confirm = '两次输入的密码不一致';
    }
    if (effectiveMode === 'setup' && !setupToken.trim()) {
      next.setupToken = '请输入服务启动终端显示的初始化令牌';
    }
    setFieldErrors(next);
    if (Object.keys(next).length > 0) return;

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

  const switchMode = (next) => {
    setMode(next);
    setError('');
    setFieldErrors({});
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background text-foreground px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <p className="type-hero text-primary">
            Melo<span className="text-foreground">dex</span>
          </p>
          <p className="mt-1 type-caption text-muted-foreground">自托管音乐库 · 多源搜索下载</p>
        </div>

        <div className="rounded-lg border border-border bg-card p-6 shadow-subtle">
          <h1 className="type-title mb-1">{titles[effectiveMode]}</h1>
          <p className="mb-5 type-caption text-muted-foreground">
            {effectiveMode === 'setup'
              ? '系统尚无账号,创建首个管理员(ROOT)。'
              : '登录后即可使用你的歌单、收藏与本地库。'}
          </p>

          <form onSubmit={onSubmit} className="space-y-3" noValidate>
            <Field label="用户名" error={fieldErrors.username} required>
              <Input
                type="text"
                autoComplete="username"
                autoFocus
                value={username}
                onChange={(e) => { setUsername(e.target.value); clearFieldError('username'); }}
                placeholder="输入用户名"
                invalid={!!fieldErrors.username}
              />
            </Field>
            <Field
              label="密码"
              error={fieldErrors.password}
              hint={effectiveMode === 'login' ? undefined : '至少 8 位'}
              required
            >
              <Input
                type="password"
                autoComplete={effectiveMode === 'login' ? 'current-password' : 'new-password'}
                value={password}
                onChange={(e) => { setPassword(e.target.value); clearFieldError('password'); }}
                placeholder="输入密码"
                invalid={!!fieldErrors.password}
              />
            </Field>
            {(effectiveMode === 'setup' || effectiveMode === 'register') && (
              <Field label="确认密码" error={fieldErrors.confirm} required>
                <Input
                  type="password"
                  autoComplete="new-password"
                  value={confirm}
                  onChange={(e) => { setConfirm(e.target.value); clearFieldError('confirm'); }}
                  placeholder="再输入一次密码"
                  invalid={!!fieldErrors.confirm}
                />
              </Field>
            )}
            {effectiveMode === 'setup' && (
              <Field
                label="初始化令牌"
                error={fieldErrors.setupToken}
                hint="见服务启动终端输出的 setup token"
                required
              >
                <Input
                  type="text"
                  value={setupToken}
                  onChange={(e) => { setSetupToken(e.target.value); clearFieldError('setupToken'); }}
                  placeholder="粘贴初始化令牌"
                  invalid={!!fieldErrors.setupToken}
                />
              </Field>
            )}

            {error && (
              <div
                role="alert"
                className="flex items-start gap-2 rounded-md border border-destructive/45 bg-destructive/10 px-3 py-2 type-caption text-foreground"
              >
                <AlertCircle size={15} className="mt-0.5 flex-shrink-0 text-destructive" aria-hidden="true" />
                <span>{error}</span>
              </div>
            )}

            <Button
              type="submit"
              variant="primary"
              size="lg"
              block
              loading={busy}
              className="mt-1"
            >
              {busy ? '处理中…' : buttons[effectiveMode]}
            </Button>
          </form>

          {!setupRequired && (allowRegistration || effectiveMode === 'register') && (
            <div className="mt-4 text-center type-caption text-muted-foreground">
              {effectiveMode === 'login' && allowRegistration && (
                <button
                  type="button"
                  onClick={() => switchMode('register')}
                  className="text-primary hover:underline"
                >
                  还没有账号?注册
                </button>
              )}
              {effectiveMode === 'register' && (
                <button
                  type="button"
                  onClick={() => switchMode('login')}
                  className={cn('text-primary hover:underline')}
                >
                  已有账号?登录
                </button>
              )}
            </div>
          )}
        </div>

        <p className="mt-4 flex items-center justify-center gap-1.5 type-micro text-muted-foreground">
          <Lock size={12} aria-hidden="true" />
          密码使用 bcrypt 加盐存储,仅你本人可使用本实例
        </p>
      </div>
    </div>
  );
};

export default AuthGate;
