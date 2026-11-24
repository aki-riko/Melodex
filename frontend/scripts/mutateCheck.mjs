// 突变验证:确认 playerRenderBudget.test.mjs 真能抓住回归。
// 用法: node mutateCheck.mjs
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const frontendRoot = resolve(here, '..');
const target = resolve(frontendRoot, 'src/contexts/PlayerContext.js');
const songRow = resolve(frontendRoot, 'src/components/SongRow.js');
const backup = resolve(process.env.TEMP, 'mutate-backup');

const runGate = () => {
  try {
    execFileSync(process.execPath, [resolve(frontendRoot, 'scripts/playerRenderBudget.test.mjs')], {
      cwd: frontendRoot,
      stdio: 'pipe',
    });
    return { ok: true, msg: '' };
  } catch (error) {
    const text = String(error.stderr || error.stdout || '');
    const line = text.split('\n').find((l) => l.includes('AssertionError')) || '(no assertion line)';
    return { ok: false, msg: line.trim() };
  }
};

const mutations = [
  {
    name: '把 progress 塞回控制面 value',
    file: target,
    from: '    nowPlaying, play, audioRef, notice, isPaused, mode, setMode,',
    to: '    nowPlaying, play, audioRef, notice, isPaused, progress, mode, setMode,',
    expect: 'progress/setProgress 不得出现在控制面 value 里',
  },
  {
    name: '去掉 controlValue 的 useMemo(退回内联对象)',
    file: target,
    from: '<PlayerContext.Provider value={controlValue}>',
    to: '<PlayerContext.Provider value={{ nowPlaying }}>',
    expect: '不得退回「渲染期内联 value={{...}}」写法',
  },
  {
    name: '移除 SongRow 的 memo',
    file: songRow,
    from: 'export default memo(SongRow, sameRowProps);',
    to: 'export default SongRow;',
    expect: 'SongRow 必须用 memo + 自定义比较导出',
  },
];

let failed = 0;
for (const m of mutations) {
  copyFileSync(m.file, backup);
  const original = readFileSync(m.file, 'utf8');
  if (!original.includes(m.from)) {
    console.log(`⚠️  跳过「${m.name}」:找不到待替换片段`);
    copyFileSync(backup, m.file);
    failed += 1;
    continue;
  }
  writeFileSync(m.file, original.replace(m.from, m.to), 'utf8');
  const result = runGate();
  copyFileSync(backup, m.file);

  if (!result.ok) {
    console.log(`✅ 突变「${m.name}」被抓住 -> ${result.msg}`);
  } else {
    console.log(`❌ 突变「${m.name}」未被抓住(门禁有漏洞)`);
    failed += 1;
  }
}

// 还原后必须重新变绿
const final = runGate();
console.log(final.ok ? '✅ 还原后门禁重新通过' : `❌ 还原后仍然失败: ${final.msg}`);

process.exit(failed === 0 && final.ok ? 0 : 1);
