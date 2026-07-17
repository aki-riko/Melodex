import assert from 'node:assert/strict';
import { scheduleServiceWorkerUpdates } from '../src/pwaUpdatePolicy.js';

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
