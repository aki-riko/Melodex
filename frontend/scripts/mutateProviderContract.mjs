// 突变验证:确认 playerProviderContract.test.mjs 能抓住"两个 Provider 键不一致"。
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const frontendRoot = resolve(here, '..');
const native = resolve(frontendRoot, 'src/contexts/NativePlayerProvider.js');
const backup = resolve(process.env.TEMP, 'provider-native.bak');

const runGate = () => {
  try {
    execFileSync(process.execPath, [resolve(frontendRoot, 'scripts/playerProviderContract.test.mjs')], {
      cwd: frontendRoot, stdio: 'pipe',
    });
    return { ok: true, msg: '' };
  } catch (error) {
    const text = String(error.stderr || error.stdout || '');
    const line = text.split('\n').find((l) => l.includes('AssertionError') || l.includes('不一致') || l.includes('同时出现'));
    return { ok: false, msg: (line || '(no assertion)').trim() };
  }
};

// 用正则,避免手写缩进对不齐
const mutations = [
  {
    name: '原生 Provider 删掉 toggleMute 键(只在 Web 有)',
    pattern: /^(\s*)toggleMute,\s*$/m,
    replacement: '',
  },
  {
    name: '把 setProgress 塞回控制面(破坏重渲染隔离)',
    pattern: /^(\s*)handleBufferEvent: noop,\s*$/m,
    replacement: '$&\n$1setProgress,',
  },
];

let failed = 0;
for (const m of mutations) {
  copyFileSync(native, backup);
  const original = readFileSync(native, 'utf8');
  const mutated = original.replace(m.pattern, m.replacement);
  if (mutated === original) {
    console.log(`⚠️  跳过「${m.name}」:正则未匹配`);
    copyFileSync(backup, native);
    failed += 1;
    continue;
  }
  writeFileSync(native, mutated, 'utf8');
  const result = runGate();
  copyFileSync(backup, native);

  if (!result.ok) {
    console.log(`✅ 突变「${m.name}」被抓住 -> ${result.msg.slice(0, 120)}`);
  } else {
    console.log(`❌ 突变「${m.name}」未被抓住`);
    failed += 1;
  }
}

const final = runGate();
console.log(final.ok ? '✅ 还原后门禁重新通过' : `❌ 还原后仍失败: ${final.msg}`);
process.exit(failed === 0 && final.ok ? 0 : 1);
