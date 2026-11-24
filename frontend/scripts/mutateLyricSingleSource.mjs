// 突变验证:确认 lyricDialogSingleSource.test.mjs 能抓住"又抄一份歌词逻辑"。
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const frontendRoot = resolve(here, '..');
const target = resolve(frontendRoot, 'src/components/PlaylistSongs.js');
const backup = resolve(process.env.TEMP, 'playlist-songs.bak');

const runGate = () => {
  try {
    execFileSync(process.execPath, [resolve(frontendRoot, 'scripts/lyricDialogSingleSource.test.mjs')], {
      cwd: frontendRoot, stdio: 'pipe',
    });
    return { ok: true, msg: '' };
  } catch (error) {
    const text = String(error.stderr || error.stdout || '');
    const line = text.split('\n').find((l) => l.includes('必须') || l.includes('不得') || l.includes('又出现'));
    return { ok: false, msg: (line || '(no assertion)').trim() };
  }
};

const mutations = [
  {
    name: '在 PlaylistSongs 里重新抄一句「无歌词」文案',
    pattern: /const showLyric = songLyric\.open;/,
    replacement: "const duplicated = '无歌词';\n  const showLyric = songLyric.open;",
  },
  {
    name: '去掉 LyricDialog 的 viewProps 展开写法',
    pattern: /<LyricDialog \{\.\.\.songLyric\.viewProps\} \/>/,
    replacement: '<LyricDialog lyric={null} onClose={() => {}} />',
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
    console.log(`✅ 突变「${m.name}」被抓住 -> ${result.msg.slice(0, 110)}`);
  } else {
    console.log(`❌ 突变「${m.name}」未被抓住`);
    failed += 1;
  }
}

const final = runGate();
console.log(final.ok ? '✅ 还原后门禁重新通过' : `❌ 还原后仍失败: ${final.msg}`);
process.exit(failed === 0 && final.ok ? 0 : 1);
