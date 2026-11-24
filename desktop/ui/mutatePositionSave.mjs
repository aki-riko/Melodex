// 突变验证:确认新增的三条写盘节流断言能抓住回退。
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
// 本文件就在 desktop/ui 里,目标同目录(不是上一级)。
const uiDir = here;
const target = resolve(uiDir, 'overlay.js');
const backup = resolve(process.env.TEMP, 'overlay.bak');

const runGate = () => {
  try {
    execFileSync(process.execPath, [resolve(uiDir, 'lyricsSettings.test.mjs')], {
      cwd: uiDir, stdio: 'pipe',
    });
    return { ok: true, msg: '' };
  } catch (error) {
    const text = String(error.stderr || error.stdout || '');
    const line = text.split('\n').find((l) => l.includes('AssertionError') || l.includes('must'));
    return { ok: false, msg: (line || '(no assertion)').trim() };
  }
};

const mutations = [
  {
    name: '去掉 dragArmed 门闩（回到无条件保存）',
    pattern: /  if \(!dragArmed\) return;\n  dragArmed = false;\n/,
    replacement: '',
  },
  {
    name: '去掉坐标去重判据',
    pattern: /    if \(lastSavedPosition && lastSavedPosition\[0\] === x && lastSavedPosition\[1\] === y\) \{\n      return;\n    \}\n/,
    replacement: '',
  },
  {
    name: '把去重判断挪到写盘之后（顺序错）',
    pattern: /    if \(lastSavedPosition && lastSavedPosition\[0\] === x && lastSavedPosition\[1\] === y\) \{\n      return;\n    \}\n    await invoke\('lyrics_save_position', \{ x, y \}\);/,
    replacement: "    await invoke('lyrics_save_position', { x, y });\n    if (lastSavedPosition && lastSavedPosition[0] === x && lastSavedPosition[1] === y) {\n      return;\n    }",
  },
];

let failed = 0;
for (const m of mutations) {
  copyFileSync(target, backup);
  const original = readFileSync(target, 'utf8');
  const mutated = original.replace(m.pattern, m.replacement);
  if (mutated === original) {
    console.log(`⚠️  跳过「${m.name}」:正则未匹配`);
    copyFileSync(backup, target);
    failed += 1;
    continue;
  }
  writeFileSync(target, mutated, 'utf8');
  const result = runGate();
  copyFileSync(backup, target);

  if (!result.ok) {
    console.log(`✅ 突变「${m.name}」被抓住 -> ${result.msg.slice(0, 100)}`);
  } else {
    console.log(`❌ 突变「${m.name}」未被抓住`);
    failed += 1;
  }
}

const final = runGate();
console.log(final.ok ? '✅ 还原后门禁重新通过' : `❌ 还原后仍失败: ${final.msg}`);
process.exit(failed === 0 && final.ok ? 0 : 1);
