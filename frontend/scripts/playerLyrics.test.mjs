import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { currentLyricIndexAt, hasUsableLyrics, parseLRC } from '../src/contexts/playerLyrics.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const frontendRoot = resolve(here, '..');

const fragranceLrc = `[ti:フレグランス]\n[ar:茉ひる/RINZO]\n[00:00.11]フレグランス - 茉ひる/RINZO\n[00:18.07]あなたに似たようなこの香り\n[00:24.41]もしかして近くにいるの？`;
const fragranceLines = parseLRC(fragranceLrc);
assert.equal(fragranceLines.length, 3, '真实 QQ LRC 应解析出歌词行');
assert.equal(fragranceLines[1].text, 'あなたに似たようなこの香り');
assert.equal(fragranceLines[1].t, 18.07);
assert.equal(hasUsableLyrics(fragranceLines), true);
assert.equal(hasUsableLyrics([]), false, '空解析结果不能作为有效缓存');
assert.equal(hasUsableLyrics(parseLRC('[00:00.00] 暂无歌词')), false, '后端占位歌词不能污染缓存');
assert.deepEqual(parseLRC('[ti:仅元信息]\n[ar:歌手]'), []);

// ---------- 双语歌词：同戳行必须共享真实 end ----------
//
// 真实数据来自旧版 PrismQML 的 `tests/test_lyrics.py`（同一首 QQ 歌的原样歌词）：
// 原文行与拼音行时间戳完全相同。用户报「双语歌词逐字有问题（播放页/桌面的都有问题）」。
//
// 修复前的事故形态（已实测）：
//   line0.t=44.88 line0.end=44.88  → 原文行时长 0
//   line1.t=44.88 line1.end=51.11  → 拼音行独吞 6.23 秒
// 于是原文行永远不会被当作当前行，拼音行反而在逐字填色。
const qqBilingual = '[00:44.88]冲[00:45.07]得[00:45.28]破[00:45.66]盲[00:46.03]点'
  + '[00:46.77] [00:46.77]找[00:47.40]到[00:47.70]光[00:48.34]点[00:50.78]\n'
  + '[00:44.88]cong [00:45.07]da [00:45.28]po [00:45.66]mang '
  + '[00:46.03]din [00:46.77] [00:46.77]zou [00:47.40]dou '
  + '[00:47.70]guong [00:48.34]din [00:50.78]\n'
  + '[00:51.11]TWINS：[00:51.73]\n'
  + '[00:52.14]让[00:52.34]二[00:52.62]人[00:52.96]划[00:53.27]破'
  + '[00:53.54]黑[00:53.94]夜[00:54.53]\n';

const bilingualLines = parseLRC(qqBilingual);
assert.equal(bilingualLines.length, 4, '双语逐字应解析出 4 行');
assert.equal(bilingualLines[0].text, '冲得破盲点 找到光点');
assert.equal(bilingualLines[1].text, 'cong da po mang din  zou dou guong din');

assert.equal(
  bilingualLines[0].end, 51.11,
  '同戳组的原文行必须拿到组后第一个更晚的时间戳作为 end（修复前是 44.88，时长 0）',
);
assert.equal(bilingualLines[1].end, 51.11, '同戳组的拼音行同样是 51.11');
assert.ok(
  bilingualLines[0].end > bilingualLines[0].t,
  `原文行时长必须 > 0（实际 ${bilingualLines[0].end - bilingualLines[0].t}）`,
);
assert.equal(
  bilingualLines[0].words.at(-1).end, 51.11,
  '原文行末字填色要持续到组结束，不能停在行首',
);

// ---------- 播放页与桌面歌词必须算出同一行 ----------

for (const position of [44.9, 45.0, 46.9, 47.5, 49.0, 50.9]) {
  assert.equal(
    currentLyricIndexAt(bilingualLines, position), 0,
    `t=${position} 时应停在同戳组的首行（原文），而不是拼音行`,
  );
}
assert.equal(currentLyricIndexAt(bilingualLines, 51.2), 2, '过了组结束才进入下一行');
assert.equal(currentLyricIndexAt(bilingualLines, 52.5), 3);
assert.equal(currentLyricIndexAt(bilingualLines, 0), -1, '还没唱到第一行时返回 -1');
assert.equal(currentLyricIndexAt([], 10), -1);
assert.equal(currentLyricIndexAt(null, 10), -1);

// 普通（非双语）歌词行为必须完全不变。
const plain = parseLRC('[00:01.00]第一行\n[00:03.00]第二行\n[00:05.00]第三行');
assert.equal(plain[0].end, 3, '非双语行仍取下一行');
assert.equal(plain[2].end, 10, '末行仍兜底 +5 秒');
assert.equal(currentLyricIndexAt(plain, 3.5), 1);

// 三行同戳（原文 + 拼音 + 翻译）也必须整体归组，不能只跳过一行。
const tripleStamp = parseLRC(
  '[00:10.00]原文\n[00:10.00]pinyin\n[00:10.00]translation\n[00:14.00]下一句',
);
assert.equal(tripleStamp.length, 4);
for (const line of tripleStamp.slice(0, 3)) {
  assert.equal(line.end, 14, '三行同戳都要拿到 14');
}
assert.equal(currentLyricIndexAt(tripleStamp, 12), 0, '三行同戳时仍停在首行');

// ---------- 静态门禁：两端不得各写一份索引实现 ----------

const playerContext = readFileSync(join(frontendRoot, 'src/contexts/PlayerContext.js'), 'utf8');
assert.match(
  playerContext,
  /currentLyricIndex\s*=\s*currentLyricIndexAt/,
  'PlayerContext 必须复用 playerLyrics 的 currentLyricIndexAt，不能再自己实现一份',
);
assert.doesNotMatch(
  playerContext,
  /const currentLyricIndex = \(lines, cur\)/,
  'PlayerContext 里那份旧的二分实现必须删掉（它不回退同戳分组，双语歌词会错行）',
);

const lyricsCore = readFileSync(
  join(frontendRoot, '..', 'desktop/ui/lyricsCore.js'),
  'utf8',
);
assert.match(lyricsCore, /回退到分组\*?\*?首行/, '桌面歌词的群组回退语义必须仍然写在注释里');
assert.match(lyricsCore, /while \(answer > 0 && Number\(lines\[answer - 1\]\?\.t\) === activeTimestamp\)/,
  '桌面歌词 lyricIndexAt 的同戳回退逻辑必须存在');

console.log('player lyrics tests passed');
