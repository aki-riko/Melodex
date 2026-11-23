// 验证「点播放条的桌面歌词按钮」→ 歌词窗 hwnd 真的显示/隐藏。
//
// 这是端到端的最后一环：前面已验证设置值翻转，但用户真正在意的是
// **窗口有没有出现**。这里用 CDP 点按钮，再用 Win32 读 hwnd 可见性。
//
// 用法: node verify-lyrics-window.mjs
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

/** 读歌词窗的 hwnd 可见性（复用项目里 ASCII 安全的测量脚本）。 */
const overlayVisible = () => {
  const out = execFileSync(
    'pwsh',
    ['-NoProfile', '-File', join(here, 'window-geometry.ps1')],
    { encoding: 'utf8' },
  );
  const line = out.split('\n').find((l) => l.includes('title=Melodex 桌面歌词'));
  if (!line) return null;
  return /visible=(True|False)/.exec(line)?.[1] === 'True';
};

const connect = async () => {
  const targets = await (await fetch('http://127.0.0.1:9222/json')).json();
  const page = targets.find(
    (t) => t.url.startsWith('http://127.0.0.1:8329/') && !t.url.endsWith('sw.js'),
  );
  if (!page) throw new Error('找不到主窗口页面');
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
  const click = async () => {
    await send('Runtime.evaluate', {
      expression: `document.querySelector('button[aria-label*="桌面歌词"]').click()`,
      awaitPromise: true,
    });
  };
  return { click, close: () => ws.close() };
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { click, close } = await connect();

const before = overlayVisible();
console.log(`起始: 歌词窗 visible=${before}`);
if (before === null) {
  console.error('!! 找不到歌词窗 hwnd');
  process.exit(1);
}

// 只在当前为隐藏时点开，避免依赖初始状态
if (!before) {
  console.log('点击按钮开启…');
  await click();
  await sleep(1500);
  const opened = overlayVisible();
  console.log(`开启后: 歌词窗 visible=${opened}`);
  if (!opened) {
    console.error('!! 点开后歌词窗仍未显示');
    close();
    process.exit(2);
  }

  console.log('再点一次关闭…');
  await click();
  await sleep(1500);
  const closed = overlayVisible();
  console.log(`关闭后: 歌词窗 visible=${closed}`);
  if (closed) {
    console.error('!! 再点后歌词窗没有隐藏');
    close();
    process.exit(3);
  }
  console.log('\n✅ 端到端通过：按钮 ↔ 设置 ↔ 歌词窗可见性 三者联动正确');
} else {
  console.log('歌词窗当前已显示，点击一次验证能否关闭…');
  await click();
  await sleep(1500);
  const closed = overlayVisible();
  console.log(`关闭后: 歌词窗 visible=${closed}`);
  if (closed) {
    console.error('!! 点击后没有隐藏');
    close();
    process.exit(4);
  }
  console.log('\n✅ 通过：点击能关闭歌词窗');
}

close();
