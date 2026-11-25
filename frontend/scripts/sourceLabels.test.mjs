// 手机端「搜索结果直接显示来源」的契约测试。
//
// 用户反馈(2026-11)：「手机版不点开搜索结果就无法看到来源」。
// 根因：SongRow 里来源写的是 `hidden lg:inline` —— 手机上完全不渲染。
//
// 这条门禁锁三件事：
//   ① 手机端来源必须可见（不能再有 hidden lg:* 把来源藏掉）；
//   ② 用**短名**而不是截断全称（截断得到「QQ音乐 · …」看不出平台差别）；
//   ③ 全称仍保留在 lg+（桌面信息更全）。

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const frontendRoot = resolve(here, '..');
const read = (rel) => readFileSync(join(frontendRoot, rel), 'utf8');

// ---------- 短名映射 ----------

const sourceLabelsSrc = read('src/utils/sourceLabels.js');
assert.match(sourceLabelsSrc, /export const sourceShortLabel/, '必须导出 sourceShortLabel');
assert.match(sourceLabelsSrc, /SOURCE_SHORT_LABELS/, '必须有短名映射表');

// 逐平台核对短名（复刻实现里的规则，并断言源码里真的登记了这些键）
const REQUIRED_SOURCES = [
  'netease', 'qq', 'qq_mobile', 'qq_connect', 'qq_wx',
  'kugou', 'kuwo', 'migu', 'qianqian', 'bilibili', 'soda', 'local',
];
for (const source of REQUIRED_SOURCES) {
  assert.match(
    sourceLabelsSrc,
    new RegExp(`\\b${source}:\\s*'`, ''),
    `短名表必须登记 ${source}（未登记会让手机端显示全称，与设计相悖）`,
  );
}

// 短名必须真的比全称短（否则这个字段没有意义）
const FULL_LABELS = {
  netease: '网易云音乐',
  qq: 'QQ音乐 · 强凭证',
  kugou: '酷狗音乐',
  kuwo: '酷我音乐',
  migu: '咪咕音乐',
  qianqian: '千千音乐',
  bilibili: '哔哩哔哩',
  soda: '汽水音乐',
};
const SHORT_LABELS = {
  netease: '网易',
  qq: 'QQ',
  kugou: '酷狗',
  kuwo: '酷我',
  migu: '咪咕',
  qianqian: '千千',
  bilibili: 'B站',
  soda: '汽水',
};
for (const key of Object.keys(SHORT_LABELS)) {
  assert.ok(
    SHORT_LABELS[key].length < FULL_LABELS[key].length,
    `${key} 的短名必须比全称短`,
  );
}

// ---------- SongRow 真的在手机上渲染来源 ----------

const songRowSrc = read('src/components/SongRow.js');
assert.match(songRowSrc, /sourceShortLabel/, 'SongRow 必须使用来源短名');
assert.match(songRowSrc, /const sourceShortName = sourceShortLabel\(rowSong\.source\)/,
  '必须从歌曲的 source 算出短名');

// 手机端呈现：不能用 hidden lg:* 隐藏（那是当初的 bug 形态）
const mobileSourceBlock = songRowSrc.match(/\{sourceShortName && \([\s\S]{0,600}?\)\}/);
assert.ok(mobileSourceBlock, '必须存在手机端来源渲染块');
const block = mobileSourceBlock[0];
assert.doesNotMatch(
  block,
  /hidden\s+lg:inline/,
  '手机端来源块不能被 hidden lg:inline 隐藏（用户反馈的正是「手机上不点开看不到来源」）',
);
assert.match(block, /sourceShortName/, '来源块内容必须来自短名');
assert.match(block, /title=\{sourceLabel\(rowSong\.source\)\}/,
  '手机端要有 title=完整来源，长按/悬停可看全称');
// 分工必须明确：手机显示短名、桌面显示全称，两者互斥而不是叠加
// （叠加会出现「QQ QQ音乐 · 强凭证」这种重复信息）。
assert.match(
  block,
  /lg:hidden/,
  '短名块应在 lg+ 隐藏（桌面由全称负责，否则来源会重复显示两次）',
);

// 全称仍在桌面保留
assert.match(
  songRowSrc,
  /hidden lg:inline[^>]*>\{sourceLabel\(rowSong\.source\)\}/,
  '桌面仍应显示完整来源（信息更全）',
);

// 不能因为加了来源就把行撑爆：短名要限宽并可截断
assert.match(block, /max-w-\[6rem\]/, '手机端来源要限宽，避免把行挤成多行');
assert.match(block, /truncate/, '手机端来源要可截断');

console.log('source label tests passed');
