import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../public/sw-force-reload.js', import.meta.url), 'utf8');
const listeners = new Map();
const steps = [];
let matchOptions = null;
let activationPromise = null;

const sameOriginClient = {
  url: 'https://music.example.test/#download',
  navigate(url) {
    steps.push(`navigate:${url}`);
    return new Promise(() => {});
  },
};
const rejectedClient = {
  url: 'https://music.example.test/#settings',
  async navigate() {
    steps.push('navigate:rejected');
    throw new Error('closed client');
  },
};
const foreignClient = {
  url: 'https://outside.example.test/',
  async navigate() {
    steps.push('navigate:foreign');
  },
};

const worker = {
  location: { origin: 'https://music.example.test' },
  addEventListener(type, listener) {
    listeners.set(type, listener);
  },
  clients: {
    async claim() {
      steps.push('claim');
    },
    async matchAll(options) {
      steps.push('matchAll');
      matchOptions = options;
      return [sameOriginClient, rejectedClient, foreignClient];
    },
  },
};

vm.runInNewContext(source, { self: worker, URL, Promise });
const activate = listeners.get('activate');
assert.equal(typeof activate, 'function', '脚本应注册 activate 监听器');

activate({
  waitUntil(promise) {
    activationPromise = promise;
  },
});
assert.ok(activationPromise, 'activate 必须用 waitUntil 保持生命周期');
await activationPromise;

assert.equal(matchOptions?.type, 'window', '应只查询窗口客户端');
assert.equal(matchOptions?.includeUncontrolled, true, '应覆盖已控制与未控制的 PWA 窗口');
assert.deepEqual(
  steps,
  [
    'claim',
    'matchAll',
    'navigate:https://music.example.test/#download',
    'navigate:rejected',
  ],
  '激活时应先接管窗口，再只导航同源页面，且不得等待页面导航完成',
);

console.log('swForceReload tests passed');
