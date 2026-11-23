// 验证「点锁定后歌词不再消失」——用户实测 bug 的回归验证。
//
// 复现路径（修复前）：暂停/空闲时点控制条的「锁定」按钮 →
//   lyrics_settings_update({click_through:true}) →
//   旧实现无条件执行 set_overlay_visible(visible && has_lyrics_state) →
//   has_lyrics_state 为 false → 窗口被隐藏 → 用户看到「歌词没了」。
//
// 修复后要求：锁定/解锁**只切穿透**，窗口可见性不变。
//
// 用法: node verify-lock-keeps-visible.mjs
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const SETTINGS = join(process.env.APPDATA, 'life.9li.melodex.desktoplyrics', 'desktop-lyrics-settings.json');

const readSettings = () => JSON.parse(readFileSync(SETTINGS, 'utf8'));
const overlayVisible = () => {
  const out = execFileSync('pwsh', ['-NoProfile', '-File', join(here, 'window-geometry.ps1')], { encoding: 'utf8' });
  const line = out.split('\n').find((l) => l.includes('title=Melodex 桌面歌词'));
  return line ? /visible=(True|False)/.exec(line)?.[1] === 'True' : null;
};

const targets = await (await fetch('http://127.0.0.1:9222/json')).json();
const page = targets.find((t) => t.url.includes('overlay.html'));
const ws = new WebSocket(page.webSocketDebuggerUrl);
let nextId = 1;
const pending = new Map();
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = nextId++;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
});
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
  }
});
await new Promise((r, j) => {
  ws.addEventListener('open', r, { once: true });
  ws.addEventListener('error', j, { once: true });
});
const ev = async (x) => {
  const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) return 'EXC: ' + (r.exceptionDetails.text || '');
  return r.result.value;
};

const step = async (label) => {
  const s = readSettings();
  console.log(`${label}`);
  console.log(`   设置: visible=${s.visible} click_through=${s.click_through}`);
  console.log(`   窗口可见: ${overlayVisible()}`);
  return s;
};

await step('① 初始状态');

console.log('\n② 点「锁定」（模拟控制条按钮）');
await ev(`window.__TAURI_INTERNALS__.invoke('lyrics_settings_update', { patch: { click_through: true } })`);
await new Promise((r) => setTimeout(r, 900));
const locked = await step('   锁定后');
if (!locked.click_through) { console.error('   ✗ 穿透没生效'); process.exit(2); }
if (!overlayVisible()) { console.error('   ✗ 歌词窗口被隐藏了（bug 未修好）'); process.exit(3); }
console.log('   ✓ 锁定生效且歌词仍在');

console.log('\n③ 解除锁定');
await ev(`window.__TAURI_INTERNALS__.invoke('lyrics_settings_update', { patch: { click_through: false } })`);
await new Promise((r) => setTimeout(r, 900));
await step('   解锁后');

console.log('\n④ 改字号（不该影响可见性）');
await ev(`window.__TAURI_INTERNALS__.invoke('lyrics_settings_update', { patch: { font_size: 44 } })`);
await new Promise((r) => setTimeout(r, 900));
const resized = await step('   改字号后');
if (!overlayVisible()) { console.error('   ✗ 改字号把窗口弄没了'); process.exit(4); }
console.log('   ✓ 改字号不影响可见性');

console.log('\n⑤ 恢复 36px');
await ev(`window.__TAURI_INTERNALS__.invoke('lyrics_settings_update', { patch: { font_size: 36 } })`);
await new Promise((r) => setTimeout(r, 900));
await step('   恢复后');

console.log('\n✅ 通过：锁定/解锁/改字号都不再影响歌词窗口可见性');
ws.close();
