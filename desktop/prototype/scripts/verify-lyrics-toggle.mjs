// 通过 WebView2 远程调试端口(CDP)驱动主窗口页面，验证「桌面歌词」按钮真的能开关歌词。
//
// 为什么用 CDP 而不是手点：这是能拿到**真实运行态证据**的方式——
// 点击前读壳侧设置文件、点击后看它是否翻转、再看歌词窗 hwnd 是否真的显示。
// 不用浏览器自动化工具（项目禁止），只连本机 WebView2 的调试端口。
//
// 用法: node verify-lyrics-toggle.mjs
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const SETTINGS = join(process.env.APPDATA, 'life.9li.melodex.desktoplyrics', 'desktop-lyrics-settings.json');

const readVisible = () => {
  try {
    return JSON.parse(readFileSync(SETTINGS, 'utf8')).visible;
  } catch (error) {
    return `读取失败: ${error.message}`;
  }
};

const targets = await (await fetch('http://127.0.0.1:9222/json')).json();
const page = targets.find((t) => t.url.startsWith('http://127.0.0.1:8329/') && !t.url.endsWith('sw.js'));
if (!page) {
  console.error('找不到主窗口页面');
  process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
let nextId = 1;
const pending = new Map();

const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = nextId++;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
});

ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result);
  }
});

await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true });
  ws.addEventListener('error', reject, { once: true });
});

const evaluate = async (expression) => {
  const result = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || 'JS 求值异常');
  }
  return result.result.value;
};

console.log('=== 1. 页面里是否渲染出该按钮 ===');
const found = await evaluate(`(() => {
  const btns = [...document.querySelectorAll('button[aria-label*="桌面歌词"]')];
  return btns.map((b) => ({
    label: b.getAttribute('aria-label'),
    pressed: b.getAttribute('aria-pressed'),
    title: b.getAttribute('title'),
    cls: b.className,
  }));
})()`);
console.log(JSON.stringify(found, null, 2));

if (found.length === 0) {
  console.error('!! 页面上找不到 aria-label 含「桌面歌词」的按钮');
  process.exit(2);
}

console.log('\n=== 2. 点击前壳侧设置 visible =', readVisible());

console.log('\n=== 3. 点击按钮 ===');
await evaluate(`(() => {
  const b = document.querySelector('button[aria-label*="桌面歌词"]');
  b.click();
  return true;
})()`);

// 等 IPC 往返 + 落盘
await new Promise((r) => setTimeout(r, 1200));

console.log('点击后壳侧设置 visible =', readVisible());
const after = await evaluate(`(() => {
  const b = document.querySelector('button[aria-label*="桌面歌词"]');
  return { label: b?.getAttribute('aria-label'), pressed: b?.getAttribute('aria-pressed') };
})()`);
console.log('点击后按钮状态 =', JSON.stringify(after));

console.log('\n=== 4. 再点一次（应翻转回来）===');
await evaluate(`document.querySelector('button[aria-label*="桌面歌词"]').click()`);
await new Promise((r) => setTimeout(r, 1200));
console.log('第二次点击后 visible =', readVisible());
const finalState = await evaluate(`(() => {
  const b = document.querySelector('button[aria-label*="桌面歌词"]');
  return { label: b?.getAttribute('aria-label'), pressed: b?.getAttribute('aria-pressed') };
})()`);
console.log('第二次点击后按钮状态 =', JSON.stringify(finalState));

ws.close();
