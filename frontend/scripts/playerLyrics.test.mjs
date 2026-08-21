import assert from 'node:assert/strict';
import { hasUsableLyrics, parseLRC } from '../src/contexts/playerLyrics.mjs';

const fragranceLrc = `[ti:フレグランス]\n[ar:茉ひる/RINZO]\n[00:00.11]フレグランス - 茉ひる/RINZO\n[00:18.07]あなたに似たようなこの香り\n[00:24.41]もしかして近くにいるの？`;
const fragranceLines = parseLRC(fragranceLrc);
assert.equal(fragranceLines.length, 3, '真实 QQ LRC 应解析出歌词行');
assert.equal(fragranceLines[1].text, 'あなたに似たようなこの香り');
assert.equal(fragranceLines[1].t, 18.07);
assert.equal(hasUsableLyrics(fragranceLines), true);
assert.equal(hasUsableLyrics([]), false, '空解析结果不能作为有效缓存');
assert.equal(hasUsableLyrics(parseLRC('[00:00.00] 暂无歌词')), false, '后端占位歌词不能污染缓存');
assert.deepEqual(parseLRC('[ti:仅元信息]\n[ar:歌手]'), []);

console.log('player lyrics tests passed');
