import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { MessageChannel } from 'node:worker_threads';
import vm from 'node:vm';

const viteConfig = await readFile(new URL('../vite.config.js', import.meta.url), 'utf8');
const registration = await readFile(new URL('../src/index.js', import.meta.url), 'utf8');
const source = await readFile(new URL('../public/sw-force-reload.js', import.meta.url), 'utf8');

assert.match(
  viteConfig,
  /importScripts\s*:\s*\[[^\]]*sw-force-reload/,
  'Service Worker 必须导入旧客户端迁移协调器',
);
assert.match(
  registration,
  /onNeedReload:\s*serviceWorkerReloader\.requestReload/,
  '更新注册必须在播放器安全边界切换页面 bundle',
);

const runActivation = async ({ activeWorker }) => {
  const listeners = new Map();
  const navigations = [];
  const capabilityMessages = [];
  let activationPromise = null;
  const capableClient = {
    url: 'https://music.example.test/#download',
    postMessage(message, ports) {
      capabilityMessages.push(message);
      ports[0].postMessage({ type: 'melodex:sw-update-capable', protocol: 1 });
    },
    navigate: async (url) => { navigations.push(`capable:${url}`); },
  };
  const legacyClient = {
    url: 'https://music.example.test/#settings',
    postMessage(message) { capabilityMessages.push(message); },
    navigate: async (url) => { navigations.push(`legacy:${url}`); },
  };
  const foreignClient = {
    url: 'https://outside.example.test/',
    postMessage() {},
    navigate: async (url) => { navigations.push(`foreign:${url}`); },
  };
  const worker = {
    registration: { active: activeWorker },
    location: { origin: 'https://music.example.test' },
    addEventListener: (type, listener) => listeners.set(type, listener),
    clients: {
      claim: async () => undefined,
      matchAll: async () => [capableClient, legacyClient, foreignClient],
    },
  };
  vm.runInNewContext(source, {
    self: worker,
    URL,
    Promise,
    MessageChannel,
    Number,
    setTimeout: (callback) => setTimeout(callback, 5),
    clearTimeout,
  });
  listeners.get('activate')({ waitUntil: (promise) => { activationPromise = promise; } });
  if (activationPromise) await activationPromise;
  await new Promise((resolve) => setImmediate(resolve));
  return { activationPromise, capabilityMessages, navigations };
};

const firstInstall = await runActivation({ activeWorker: null });
assert.equal(firstInstall.activationPromise, null, '首次安装不得无意义重载当前页面');
assert.deepEqual(firstInstall.navigations, [], '首次安装不得导航任何页面');

const updateInstall = await runActivation({ activeWorker: { scriptURL: '/old-sw.js' } });
assert.equal(updateInstall.capabilityMessages.length, 2, '更新时应只询问同源页面的升级能力');
assert.deepEqual(
  updateInstall.navigations,
  ['legacy:https://music.example.test/#settings'],
  '懂安全重载的新页面保留播放，只有不响应握手的旧页面强制迁移一次',
);

console.log('swForceReload tests passed');
