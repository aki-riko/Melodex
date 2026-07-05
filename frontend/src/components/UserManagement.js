import React, { useState } from 'react';
import { useQuery } from 'react-query';
import {
  adminListUsers,
  adminCreateUser,
  adminSetUserRole,
  adminSetUserDisabled,
  adminResetPassword,
  adminDeleteUser,
  adminSetRegistration,
} from '../services/musicdl';
import { useAuth } from '../contexts/AuthContext';
import { useFeedback } from '../contexts/FeedbackContext';
import LoadingState from './LoadingState';

const ROLE_LABEL = { admin: '管理员', user: '普通用户' };

const UserManagement = () => {
  const { user: me } = useAuth();
  const feedback = useFeedback();
  const usersQuery = useQuery(['admin-users'], adminListUsers, {
    retry: (count, err) => err?.name !== 'AuthRequiredError' && count < 2,
  });
  const [newUser, setNewUser] = useState({ username: '', password: '', role: 'user' });
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  const users = usersQuery.data?.users || [];
  const allowRegistration = !!usersQuery.data?.allowRegistration;

  const refresh = () => usersQuery.refetch();
  const flash = (m) => { setMsg(m); setErr(''); feedback.success(m); setTimeout(() => setMsg(''), 2000); };
  const fail = (e) => { const message = e?.response?.data?.error || '操作失败'; setErr(message); feedback.error(message); };

  const onCreate = async (e) => {
    e.preventDefault();
    setErr('');
    if (!newUser.username.trim() || !newUser.password) { setErr('请填用户名和密码'); return; }
    try {
      await adminCreateUser(newUser.username.trim(), newUser.password, newUser.role);
      setNewUser({ username: '', password: '', role: 'user' });
      flash('已创建');
      refresh();
    } catch (e2) { fail(e2); }
  };

  const onToggleRole = async (u) => {
    try {
      await adminSetUserRole(u.id, u.role === 'admin' ? 'user' : 'admin');
      flash('角色已更新');
      refresh();
    } catch (e) { fail(e); }
  };

  const onToggleDisabled = async (u) => {
    try {
      await adminSetUserDisabled(u.id, !u.disabled);
      flash(u.disabled ? '已启用' : '已禁用');
      refresh();
    } catch (e) { fail(e); }
  };

  const onResetPassword = async (u) => {
    const pw = await feedback.prompt({
      title: `为 ${u.username} 设置新密码`,
      body: '修改后该用户的旧会话会失效。',
      label: '新密码',
      inputType: 'password',
      placeholder: '至少 8 位',
      confirmLabel: '重置密码',
    });
    if (!pw) return;
    if (pw.length < 8) {
      setErr('密码至少 8 位');
      feedback.error('密码至少 8 位');
      return;
    }
    try {
      await adminResetPassword(u.id, pw);
      flash('密码已重置');
    } catch (e) { fail(e); }
  };

  const onDelete = async (u) => {
    const ok = await feedback.confirm({
      title: `删除用户 ${u.username}?`,
      body: '其歌单与下载归属将一并删除,此操作不可恢复。',
      confirmLabel: '删除用户',
      danger: true,
    });
    if (!ok) return;
    try {
      await adminDeleteUser(u.id);
      flash('已删除');
      refresh();
    } catch (e) { fail(e); }
  };

  const onToggleRegistration = async () => {
    try {
      await adminSetRegistration(!allowRegistration);
      flash(allowRegistration ? '已关闭注册' : '已开放注册');
      refresh();
    } catch (e) { fail(e); }
  };

  return (
    <div className="max-w-4xl mx-auto pb-32">
      <h2 className="text-3xl font-semibold mb-2">用户管理</h2>
      <p className="text-muted-foreground mb-6 mt-3">管理账号、角色与开放注册开关。仅管理员可见。</p>

      {(msg || err) && (
        <p className={`mb-4 text-sm font-medium ${err ? 'text-destructive' : 'text-success'}`}>{err || msg}</p>
      )}

      <section className="mb-8 p-4 border border-border rounded-lg bg-card">
        <div className="flex items-center justify-between">
          <div>
            <p className="font-semibold">开放注册</p>
            <p className="text-sm text-muted-foreground">关闭时仅管理员可创建账号(邀请制)。</p>
          </div>
          <button
            onClick={onToggleRegistration}
            className={`px-3 py-1.5 border border-border rounded-md font-semibold text-sm transition-colors ${allowRegistration ? 'bg-success text-success-foreground' : 'bg-muted text-muted-foreground'}`}
          >
            {allowRegistration ? '已开放' : '已关闭'}
          </button>
        </div>
      </section>

      <section className="mb-8">
        <h3 className="text-xl font-semibold mb-3">新建用户</h3>
        <form onSubmit={onCreate} className="flex flex-wrap items-center gap-2">
          <input
            value={newUser.username}
            onChange={(e) => setNewUser({ ...newUser, username: e.target.value })}
            placeholder="用户名"
            className="px-3 py-2 border border-border rounded-md bg-card outline-none focus:border-primary"
          />
          <input
            type="password"
            value={newUser.password}
            onChange={(e) => setNewUser({ ...newUser, password: e.target.value })}
            placeholder="密码(≥8 位)"
            className="px-3 py-2 border border-border rounded-md bg-card outline-none focus:border-primary"
          />
          <select
            value={newUser.role}
            onChange={(e) => setNewUser({ ...newUser, role: e.target.value })}
            className="px-3 py-2 border border-border rounded-md bg-card outline-none focus:border-primary"
          >
            <option value="user">普通用户</option>
            <option value="admin">管理员</option>
          </select>
          <button type="submit" className="px-4 py-2 border border-border rounded-md bg-primary text-primary-foreground font-semibold text-sm hover:brightness-95 transition-colors">
            创建
          </button>
        </form>
      </section>

      <section>
        <h3 className="text-xl font-semibold mb-3">用户列表</h3>
        {usersQuery.isLoading ? (
          <LoadingState
            title="加载用户列表"
            detail="正在读取账号、角色和注册开关状态"
            rows={4}
            className="mb-4"
          />
        ) : (
          <div className="space-y-2">
            {users.map((u) => (
              <div key={u.id} className="flex flex-wrap items-center gap-2 p-3 border border-border rounded-md bg-card">
                <div className="flex-grow min-w-0">
                  <p className="font-semibold truncate">
                    {u.username}
                    {u.id === me?.id && <span className="ml-2 text-xs text-muted-foreground">(我)</span>}
                    {u.disabled && <span className="ml-2 text-xs text-destructive">已禁用</span>}
                  </p>
                  <p className="text-sm text-muted-foreground">{ROLE_LABEL[u.role] || u.role}</p>
                </div>
                {u.id !== me?.id && (
                  <>
                    <button onClick={() => onToggleRole(u)} className="px-2 py-1 border border-border rounded-md bg-card text-xs font-medium hover:bg-secondary transition-colors">
                      {u.role === 'admin' ? '降为用户' : '升为管理员'}
                    </button>
                    <button onClick={() => onToggleDisabled(u)} className="px-2 py-1 border border-border rounded-md bg-card text-xs font-medium hover:bg-secondary transition-colors">
                      {u.disabled ? '启用' : '禁用'}
                    </button>
                  </>
                )}
                <button onClick={() => onResetPassword(u)} className="px-2 py-1 border border-border rounded-md bg-card text-xs font-medium hover:bg-secondary transition-colors">
                  重置密码
                </button>
                {u.id !== me?.id && (
                  <button onClick={() => onDelete(u)} className="px-2 py-1 border border-border rounded-md bg-destructive text-destructive-foreground text-xs font-semibold hover:brightness-95 transition-colors">
                    删除
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
};

export default UserManagement;
