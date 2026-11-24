// 突变验证:确认 listen 订阅测试能抓住"去掉 catch 或改回裸调用"。
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const overlay = resolve(here, 'overlay.js');
const settings = resolve(here, 'settings.js');
const backupOverlay = resolve(process.env.TEMP, 'overlay2.bak');
const backupSettings = resolve(process.env.TEMP, 'settings2.bak');

const runGate = () => {
  try {
    execFileSync(process.execPath, [resolve(here, 'lyricsSettings.test.mjs')], {
      cwd: here, stdio: 'pipe',
    });
    return { ok: true, msg: '' };
  } catch (error) {
    const text = String(error.stderr || error.stdout || '');
    const line = text
      .split('\n')
      .find((l) => l.includes('没有 .catch') || l.includes('未处理失败') || l.includes('AssertionError'));
    return { ok: false, msg: (line || '(no assertion)').trim() };
  }
};

const mutations = [
  {
    file: overlay,
    backup: backupOverlay,
    name: 'subscribe 包装里去掉 .catch',
    pattern: /  listen\(eventName, handler\)\.catch\(\(error\) => \{\n    console\.warn\(`订阅桌面歌词事件失败: \$\{eventName\}`, error\);\n  \}\);/,
    replacement: '  listen(eventName, handler);',
  },
  {
    file: overlay,
    backup: backupOverlay,
    name: '把 subscribe 调用改回裸 listen',
    pattern: /subscribe\(STATE_EVENT, \(event\) => applyStateMessage\(event\.payload\)\);/,
    replacement: 'listen(STATE_EVENT, (event) => applyStateMessage(event.payload));',
  },
  {
    file: settings,
    backup: backupSettings,
    name: 'settings.js 去掉 .catch',
    pattern: /\.catch\(\(error\) => \{\n  console\.warn\(`订阅桌面歌词设置同步失败: \$\{SETTINGS_EVENT\}`, error\);\n\}\);/,
    replacement: ';',
  },
];

let failed = 0;
for (const m of mutations) {
  copyFileSync(m.file, m.backup);
  const original = readFileSync(m.file, 'utf8');
  const mutated = original.replace(m.pattern, m.replacement);
  if (mutated === original) {
    console.log(`⚠️  跳过「${m.name}」:正则未匹配`);
    copyFileSync(m.backup, m.file);
    failed += 1;
    continue;
  }
  writeFileSync(m.file, mutated, 'utf8');
  const result = runGate();
  copyFileSync(m.backup, m.file);

  console.log(
    result.ok
      ? `❌ 突变「${m.name}」未被抓住`
      : `✅ 突变「${m.name}」被抓住 -> ${result.msg.slice(0, 100)}`,
  );
  if (result.ok) failed += 1;
}

const final = runGate();
console.log(final.ok ? '✅ 还原后门禁重新通过' : `❌ 还原后仍失败: ${final.msg}`);
process.exit(failed === 0 && final.ok ? 0 : 1);
