import assert from 'node:assert/strict';
import {
  authSnapshotsEqual,
  SERVER_DOWNLOADS_STALE_MS,
  serverDownloadsQueryOptions,
} from '../src/contexts/appWakePolicy.js';

const authState = {
  loading: false,
  authenticated: true,
  user: {
    id: 7,
    username: 'alice',
    role: 'user',
    disabled: false,
    created_at: '2026-07-15T00:00:00Z',
  },
  setupRequired: false,
  allowRegistration: false,
  desktop: false,
  offline: false,
};

assert.equal(
  authSnapshotsEqual(authState, { ...authState, user: { ...authState.user } }),
  true,
  '后台恢复拿到相同会话快照时不应触发整棵应用重渲染',
);
assert.equal(
  authSnapshotsEqual(authState, { ...authState, user: { ...authState.user, role: 'admin' } }),
  false,
  '角色变化必须更新鉴权状态',
);
assert.equal(
  authSnapshotsEqual(authState, { ...authState, offline: true }),
  false,
  '在线/离线状态变化必须更新鉴权状态',
);

const activeDownloads = serverDownloadsQueryOptions({ userId: 7, offline: false });
assert.equal(activeDownloads.enabled, true, '登录且在线时应读取服务器下载状态');
assert.equal(activeDownloads.staleTime, SERVER_DOWNLOADS_STALE_MS, '下载状态缓存时间应保持原有一分钟');
assert.equal(activeDownloads.refetchOnWindowFocus, false, '长时间后台恢复时不得立即自动刷新下载状态');
assert.equal(activeDownloads.refetchOnReconnect, false, '网络恢复时不得与页面唤醒争抢主线程');
assert.equal(serverDownloadsQueryOptions({ userId: 0, offline: false }).enabled, false, '未登录时不读取下载状态');
assert.equal(serverDownloadsQueryOptions({ userId: 7, offline: true }).enabled, false, '离线模式不读取下载状态');

console.log('appWakePolicy tests passed');
