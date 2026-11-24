// 突变验证:确认 modalLayer.test.mjs 能抓住"手写模态遮罩绕过行为层"。
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const frontendRoot = resolve(here, '..');
const settings = resolve(frontendRoot, 'src/components/Settings.js');
const hook = resolve(frontendRoot, 'src/ui/useModalLayer.js');
const backupSettings = resolve(process.env.TEMP, 'modal-settings.bak');
const backupHook = resolve(process.env.TEMP, 'modal-hook.bak');

const runGate = () => {
  try {
    execFileSync(process.execPath, [resolve(frontendRoot, 'scripts/modalLayer.test.mjs')], {
      cwd: frontendRoot, stdio: 'pipe',
    });
    return { ok: true, msg: '' };
  } catch (error) {
    const text = String(error.stderr || error.stdout || '');
    const line = text.split('\n').find((l) => l.includes('AssertionError')) || '(no assertion)';
    return { ok: false, msg: line.trim() };
  }
};

// 用正则做替换,避免手写缩进对不齐
const mutations = [
  {
    name: '移除第一个 role="dialog"',
    file: settings,
    pattern: /role="dialog"\r?\n\s*aria-modal="true"/,
    replacement: 'aria-modal="true"',
  },
  {
    name: '移除第一个 aria-modal="true"',
    file: settings,
    pattern: /aria-modal="true"\r?\n\s*aria-labelledby="qr-login-title"/,
    replacement: 'aria-labelledby="qr-login-title"',
  },
  {
    name: '从 hook 里删掉 Esc 处理',
    file: hook,
    pattern: /if \(event\.key === 'Escape'\)/,
    replacement: 'if (false)',
  },
  {
    name: '从 hook 里删掉返回键调用',
    file: hook,
    pattern: /^\s*useBackLayer\(\{/m,
    replacement: '  void ({',
  },
];

let failed = 0;
for (const m of mutations) {
  const backup = m.file === settings ? backupSettings : backupHook;
  copyFileSync(m.file, backup);
  const original = readFileSync(m.file, 'utf8');
  const mutated = original.replace(m.pattern, m.replacement);
  if (mutated === original) {
    console.log(`⚠️  跳过「${m.name}」:正则未匹配`);
    copyFileSync(backup, m.file);
    failed += 1;
    continue;
  }
  writeFileSync(m.file, mutated, 'utf8');
  const result = runGate();
  copyFileSync(backup, m.file);

  if (!result.ok) {
    console.log(`✅ 突变「${m.name}」被抓住 -> ${result.msg}`);
  } else {
    console.log(`❌ 突变「${m.name}」未被抓住(门禁有漏洞)`);
    failed += 1;
  }
}

const final = runGate();
console.log(final.ok ? '✅ 还原后门禁重新通过' : `❌ 还原后仍失败: ${final.msg}`);
process.exit(failed === 0 && final.ok ? 0 : 1);
