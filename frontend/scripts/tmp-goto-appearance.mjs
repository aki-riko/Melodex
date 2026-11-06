// 滚到「外观」并把那一屏截图拉回来。
import { execFileSync } from 'node:child_process';
import { readFileSync, unlinkSync } from 'node:fs';

const ADB = `${process.env.LOCALAPPDATA}\\Android\\Sdk\\platform-tools\\adb.exe`;
const SERIAL = '3B656W00MPC00000';
const DUMP = 'D:\\其他项目\\Melodex\\frontend\\ui-scan.xml';
const sh = (...args) => execFileSync(ADB, ['-s', SERIAL, ...args], { encoding: 'utf8' });
const sleep = (ms) => execFileSync('powershell', ['-Command', `Start-Sleep -Milliseconds ${ms}`]);

const visible = (target) => {
  sh('shell', 'uiautomator', 'dump', '/sdcard/ui-scan.xml');
  sh('pull', '/sdcard/ui-scan.xml', DUMP);
  const xml = readFileSync(DUMP, 'utf8');
  const re = new RegExp(`text="${target}"[^>]*bounds="\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]"`);
  const m = re.exec(xml);
  if (!m) return null;
  const [, x1, y1, x2, y2] = m;
  if (+x2 === 0) return null;
  return { x: Math.round((+x1 + +x2) / 2), y: Math.round((+y1 + +y2) / 2) };
};

for (let i = 0; i < 14; i += 1) {
  const pos = visible('外观');
  if (pos) {
    console.log('found at', JSON.stringify(pos));
    try { unlinkSync(DUMP); } catch {}
    process.exit(0);
  }
  sh('shell', 'input', 'swipe', '632', '2300', '632', '900', '250');
  sleep(500);
}
console.error('not found');
process.exit(1);
