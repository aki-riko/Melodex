import assert from 'node:assert/strict';
import {
  SW_UPDATE_QUERY,
  SW_UPDATE_RESPONSE,
  createSafeServiceWorkerReloader,
  scheduleServiceWorkerUpdates,
} from '../src/pwaUpdatePolicy.js';

const createEventTarget = () => {
  const listeners = new Map();
  return {
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    dispatch(type) {
      listeners.get(type)?.();
    },
    listener(type) {
      return listeners.get(type);
    },
  };
};

const playingAudio = { ...createEventTarget(), paused: false, ended: false };
const documentTarget = createEventTarget();
const documentLike = {
  ...documentTarget,
  querySelector: (selector) => (selector === 'audio' ? playingAudio : null),
};
const serviceWorkerTarget = createEventTarget();
let reloadCalls = 0;
const safeReloader = createSafeServiceWorkerReloader({
  documentLike,
  navigatorLike: { serviceWorker: serviceWorkerTarget },
  reload: () => { reloadCalls += 1; },
});
safeReloader.listen();
assert.equal(typeof serviceWorkerTarget.listener('message'), 'function', '应监听 SW 升级握手');

const responses = [];
safeReloader.handleWorkerMessage({
  data: { type: SW_UPDATE_QUERY },
  ports: [{ postMessage: (payload) => responses.push(payload) }],
});
await Promise.resolve();
assert.equal(responses[0]?.type, SW_UPDATE_RESPONSE, '新页面必须响应安全升级能力');
assert.equal(safeReloader.isReloadPending(), true, '播放中收到更新后应记录待重载');
assert.equal(reloadCalls, 0, '播放中不得立即重载页面');

playingAudio.paused = true;
playingAudio.dispatch('pause');
assert.equal(reloadCalls, 1, '播放器暂停后应执行一次待处理重载');
playingAudio.dispatch('ended');
assert.equal(reloadCalls, 1, '同一更新不得重复重载');

const pausedAudio = { paused: true, ended: false };
let immediateReloads = 0;
const idleReloader = createSafeServiceWorkerReloader({
  documentLike: { querySelector: () => pausedAudio },
  reload: () => { immediateReloads += 1; },
});
assert.equal(idleReloader.requestReload(), true, '未播放时应立即切换到新 bundle');
assert.equal(immediateReloads, 1, '未播放时只应重载一次');

let scheduledCallback = null;
let scheduledInterval = null;
let updateCalls = 0;
const warnings = [];

const timerID = scheduleServiceWorkerUpdates({
  update() {
    updateCalls += 1;
    return Promise.resolve();
  },
}, {
  intervalMs: '60000',
  setIntervalFn(callback, interval) {
    scheduledCallback = callback;
    scheduledInterval = interval;
    return 17;
  },
  logger: { warn: (...args) => warnings.push(args) },
});

assert.equal(timerID, 17, '应返回更新定时器 ID');
assert.equal(scheduledInterval, 60000, '应读取生产环境配置的更新检查间隔');
assert.equal(typeof scheduledCallback, 'function', '应注册周期更新回调');
scheduledCallback();
await Promise.resolve();
assert.equal(updateCalls, 1, '周期回调应调用 ServiceWorkerRegistration.update');
assert.equal(warnings.length, 0, '正常更新不应产生警告');

assert.equal(
  scheduleServiceWorkerUpdates(null, { intervalMs: 60000, setIntervalFn: () => 1 }),
  null,
  '没有注册对象时不得创建无效定时器',
);
assert.equal(
  scheduleServiceWorkerUpdates({ update() {} }, { intervalMs: 0, setIntervalFn: () => 1 }),
  null,
  '无效配置不得创建定时器',
);

let rejectionCallback = null;
scheduleServiceWorkerUpdates({
  update() {
    return Promise.reject(new Error('network'));
  },
}, {
  intervalMs: 1000,
  setIntervalFn(callback) {
    rejectionCallback = callback;
    return 18;
  },
  logger: { warn: (...args) => warnings.push(args) },
});
rejectionCallback();
await new Promise((resolve) => setImmediate(resolve));
assert.equal(warnings.length, 1, '更新检查失败必须留下可观测警告');

console.log('pwaUpdatePolicy tests passed');
