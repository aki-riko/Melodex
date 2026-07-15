import assert from 'node:assert/strict';
import reactQueryCore from 'react-query/lib/core/index.js';
import {
  authSnapshotsEqual,
  createWakeReconciler,
  SERVER_DOWNLOADS_STALE_MS,
  scheduleWakeReconciliation,
  serverDownloadsQueryOptions,
  WAKE_RECONCILIATION_IDLE_TIMEOUT_MS,
} from '../src/contexts/appWakePolicy.js';

const {
  QueryClient,
  QueryObserver,
  focusManager,
  onlineManager,
} = reactQueryCore;

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

const frames = new Map();
const idleCallbacks = new Map();
const idleOptions = new Map();
let nextTaskID = 1;
const runtime = {
  requestAnimationFrame: (callback) => {
    const id = nextTaskID++;
    frames.set(id, callback);
    return id;
  },
  cancelAnimationFrame: (id) => frames.delete(id),
  requestIdleCallback: (callback, options) => {
    const id = nextTaskID++;
    idleCallbacks.set(id, callback);
    idleOptions.set(id, options);
    return id;
  },
  cancelIdleCallback: (id) => idleCallbacks.delete(id),
};
const runNext = (tasks) => {
  const entry = tasks.entries().next().value;
  assert.ok(entry, '应存在待执行任务');
  const [id, callback] = entry;
  tasks.delete(id);
  callback();
};

let scheduledReconciliations = 0;
scheduleWakeReconciliation(() => { scheduledReconciliations += 1; }, runtime);
assert.equal(frames.size, 1, '恢复对账应先等待首个绘制帧');
runNext(frames);
assert.equal(frames.size, 1, '首帧后还应再让出一个绘制帧');
runNext(frames);
assert.equal(idleCallbacks.size, 1, '两个绘制帧后才进入空闲调度');
assert.equal(
  idleOptions.values().next().value?.timeout,
  WAKE_RECONCILIATION_IDLE_TIMEOUT_MS,
  '页面持续忙碌时也必须在截止时间内完成状态对账',
);
assert.equal(scheduledReconciliations, 0, '空闲回调前不得立即对账');
runNext(idleCallbacks);
assert.equal(scheduledReconciliations, 1, '空闲阶段应执行一次对账');

let visible = false;
let online = true;
let reconcileCount = 0;
const scheduled = [];
const schedule = (callback) => {
  const task = { active: true, callback };
  scheduled.push(task);
  return () => { task.active = false; };
};
const runScheduled = (task) => {
  if (task.active) task.callback();
};
const reconciler = createWakeReconciler({
  isVisible: () => visible,
  isOnline: () => online,
  reconcile: () => { reconcileCount += 1; },
  schedule,
});

reconciler.onVisibilityChange();
assert.equal(scheduled.length, 0, '页面仍隐藏时不得安排对账');
visible = true;
reconciler.onVisibilityChange();
assert.equal(scheduled.length, 1, '页面恢复可见后应安排延迟对账');
reconciler.onOnline();
assert.equal(scheduled.length, 2, '联网事件应合并为新的待执行对账');
runScheduled(scheduled[0]);
assert.equal(reconcileCount, 0, '被后续事件取代的旧任务不得执行');
runScheduled(scheduled[1]);
assert.equal(reconcileCount, 1, '合并后的最新任务应执行一次');

reconciler.onVisibilityChange();
visible = false;
reconciler.onVisibilityChange();
runScheduled(scheduled[2]);
assert.equal(reconcileCount, 1, '再次进入后台应取消尚未执行的对账');
visible = true;
reconciler.onOnline();
online = false;
reconciler.onOffline();
runScheduled(scheduled[3]);
assert.equal(reconcileCount, 1, '再次离线应取消尚未执行的对账');

let queryCalls = 0;
const queryClient = new QueryClient();
queryClient.mount();
const queryObserver = new QueryObserver(queryClient, {
  queryKey: ['server-downloads-wake-integration'],
  queryFn: async () => {
    queryCalls += 1;
    return { downloads: [], total: 0 };
  },
  ...serverDownloadsQueryOptions({ userId: 7, offline: false }),
  staleTime: 0,
});
const unsubscribe = queryObserver.subscribe(() => {});

await queryObserver.refetch();
const callsBeforeWake = queryCalls;
focusManager.setFocused(false);
focusManager.setFocused(true);
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(queryCalls, callsBeforeWake, 'React Query 聚焦恢复不得立即重新抓取');

onlineManager.setOnline(false);
onlineManager.setOnline(true);
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(queryCalls, callsBeforeWake, 'React Query 联网恢复不得立即重新抓取');

let integrationVisible = true;
let integrationOnline = true;
const integrationTasks = [];
const integrationReconciler = createWakeReconciler({
  isVisible: () => integrationVisible,
  isOnline: () => integrationOnline,
  reconcile: () => { queryObserver.refetch(); },
  schedule: (callback) => {
    const task = { active: true, callback };
    integrationTasks.push(task);
    return () => { task.active = false; };
  },
});
integrationReconciler.onVisibilityChange();
runScheduled(integrationTasks[0]);
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(queryCalls, callsBeforeWake + 1, '空闲协调器最终应执行一次服务器状态对账');

integrationReconciler.cancel();
unsubscribe();
queryClient.unmount();
queryClient.clear();
focusManager.setFocused(undefined);
onlineManager.setOnline(undefined);

console.log('appWakePolicy tests passed');
