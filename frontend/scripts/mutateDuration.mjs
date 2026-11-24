// 突变验证:确认 durationFormat.test.mjs 能抓住"播放器退回不折小时"的回归。
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const frontendRoot = resolve(here, '..');
const target = resolve(frontendRoot, 'src/contexts/PlayerContext.js');
const backup = resolve(process.env.TEMP, 'duration-backup.js');

const runGate = () => {
  try {
    execFileSync(process.execPath, [resolve(frontendRoot, 'scripts/durationFormat.test.mjs')], {
      cwd: frontendRoot, stdio: 'pipe',
    });
    return { ok: true, msg: '' };
  } catch (error) {
    const text = String(error.stderr || error.stdout || '');
    const line = text.split('\n').find((l) => l.includes('AssertionError')) || '(no assertion)';
    return { ok: false, msg: line.trim() };
  }
};

const original = readFileSync(target, 'utf8');
copyFileSync(target, backup);

// 突变:把 formatPlaybackTime 换回旧的 fmtTime 实现(不折小时)
const mutation = original.replace(
  'const fmtTime = formatPlaybackTime;',
  'const fmtTime = (s) => { if (!s || !isFinite(s)) return \'0:00\'; const m = Math.floor(s / 60), sec = Math.floor(s % 60); return `${m}:${sec.toString().padStart(2, \'0\')}`; };',
);

if (mutation === original) {
  console.log('⚠️  找不到待替换片段,突变未执行');
} else {
  writeFileSync(target, mutation, 'utf8');
  const result = runGate();
  copyFileSync(backup, target);
  console.log(result.ok
    ? '❌ 突变「播放器退回不折小时」未被抓住(门禁有漏洞)'
    : `✅ 突变被抓住 -> ${result.msg}`);
}

const final = runGate();
console.log(final.ok ? '✅ 还原后门禁重新通过' : `❌ 还原后仍失败: ${final.msg}`);
