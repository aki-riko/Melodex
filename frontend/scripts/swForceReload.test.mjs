import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const viteConfig = await readFile(new URL('../vite.config.js', import.meta.url), 'utf8');
const registration = await readFile(new URL('../src/index.js', import.meta.url), 'utf8');

assert.doesNotMatch(
  viteConfig,
  /importScripts\s*:\s*\[[^\]]*sw-force-reload/,
  'Service Worker 不得再导入会强制导航播放窗口的脚本',
);
assert.match(
  registration,
  /onNeedReload:\s*\(\)\s*=>\s*\{\}/,
  '更新注册必须保留当前页面，不得在播放期间自动重载',
);

console.log('swForceReload tests passed');
