// utils/quality.js 契约测试。
//
// 为什么需要:音质徽章有三路来源、优先级不同,而其中「服务器副本」那一路要
// 用「体积 × 8 ÷ 时长」反推码率 —— 这类数值逻辑最容易在无人察觉时算错
// (比如单位写成 KB 与 B 混淆、或把 0 当有效值参与除法)。
// 真实事故背景:自建歌单页的音质整列显示 "—",原因是歌曲记录里根本没有
// bitrate/ext(见 utils/songFields.js 的 songWritePayload),必须靠服务器副本来兜。

import { qualityFromBitrate, qualityFromSong, qualityFromServerCopy, resolveQuality } from '../src/utils/quality.js';

let failures = 0;
const eq = (actual, expected, label) => {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) {
    console.error(`FAIL ${label}\n  期望: ${b}\n  实际: ${a}`);
    failures += 1;
  }
};
const pick = (q) => (q ? { label: q.label, tone: q.tone } : null);

// ---- 1. 码率 → 徽章 ----
eq(pick(qualityFromBitrate(1411)), { label: '无损', tone: 'lossless' }, '1411kbps 应判无损');
eq(pick(qualityFromBitrate(800)), { label: '无损', tone: 'lossless' }, '800kbps 边界应判无损');
eq(pick(qualityFromBitrate(799)), { label: '高品', tone: 'high' }, '799kbps 应判高品');
eq(pick(qualityFromBitrate(320)), { label: '高品', tone: 'high' }, '320kbps 应判高品');
eq(pick(qualityFromBitrate(128)), { label: '128k', tone: 'plain' }, '128kbps 应显示 128k');
eq(pick(qualityFromBitrate(0)), null, '0 码率应返回 null(不编造)');
eq(pick(qualityFromBitrate(undefined)), null, 'undefined 应返回 null');

// ---- 2. 歌曲记录(来源 3) ----
eq(pick(qualityFromSong({ ext: 'FLAC' })), { label: '无损', tone: 'lossless' }, '歌曲 ext=FLAC(大写)应判无损');
eq(pick(qualityFromSong({ ext: '.flac' })), { label: '无损', tone: 'lossless' }, '歌曲 ext 带点也应判无损');
eq(pick(qualityFromSong({ ext: 'mp3', bitrate: 320 })), { label: '高品', tone: 'high' }, 'mp3+320k 应判高品');
eq(pick(qualityFromSong({})), null, '歌曲无任何音质字段应返回 null');

// ---- 3. 服务器副本(来源 2)—— 核心路径 ----
eq(
  pick(qualityFromServerCopy({ ext: 'flac', size_bytes: 35000000 }, { duration: 223 })),
  { label: '无损', tone: 'lossless' },
  '副本 flac 应判无损(不看体积)',
);
// 有损:体积 8.75MB / 223s ≈ 314kbps → 应判 314k
const mp3Copy = qualityFromServerCopy({ ext: 'mp3', size_bytes: 8_750_000 }, { duration: 223 });
eq(mp3Copy.label.endsWith('k'), true, 'mp3 副本应按体积/时长算出 k 值');
eq(
  Math.abs(parseInt(mp3Copy.label, 10) - Math.round((8_750_000 * 8) / 223 / 1000)) <= 1,
  true,
  `mp3 副本码率应≈${Math.round((8_750_000 * 8) / 223 / 1000)}k,实际 ${mp3Copy.label}`,
);
eq(mp3Copy.tone, 'plain', '约 314k 应落 plain 档(未到 320)');
// >=320 的有损判高品
// 注:13,000,000B / 326s ≈ 319kbps,差一点,所以这里取 13,200,000B → ≈324kbps。
// (第一版用例就是被这个测试自己抓出来的:我把 319 当成了 "320+")
eq(
  pick(qualityFromServerCopy({ ext: 'mp3', size_bytes: 13_200_000 }, { duration: 326 })),
  { label: '高品', tone: 'high' },
  '约 324k 的有损应判高品',
);
// 319k 这种"差一点"的必须落在 plain,不能四舍五入成高品
eq(
  pick(qualityFromServerCopy({ ext: 'mp3', size_bytes: 13_000_000 }, { duration: 326 })),
  { label: '319k', tone: 'plain' },
  '约 319k 的边界不应被判成高品',
);
// 只有扩展名、没有体积 → 只显示格式,不编造码率
eq(
  pick(qualityFromServerCopy({ ext: 'ogg' }, { duration: 200 })),
  { label: 'OGG', tone: 'plain' },
  '仅 ext 无体积时应显示格式名而非编造码率',
);
// 体积为 0 不能参与除法
eq(
  pick(qualityFromServerCopy({ ext: 'mp3', size_bytes: 0 }, { duration: 200 })),
  { label: 'MP3', tone: 'plain' },
  'size_bytes=0 应退化为格式名(0 不是有效证据)',
);
// 时长为 0 不能参与除法
eq(
  pick(qualityFromServerCopy({ ext: 'mp3', size_bytes: 5_000_000 }, { duration: 0 })),
  { label: 'MP3', tone: 'plain' },
  'duration=0 应退化为格式名',
);
eq(qualityFromServerCopy(null, { duration: 200 }), null, '无副本记录应返回 null');
eq(qualityFromServerCopy({}, { duration: 200 }), null, '副本无 ext 应返回 null');

// ---- 4. 优先级:验活 > 服务器副本 > 歌曲记录 ----
eq(
  pick(resolveQuality({ state: 'ok', bitrateNum: 1411 }, { ext: 'mp3', size_bytes: 5_000_000 }, { ext: 'mp3', bitrate: 128 })),
  { label: '无损', tone: 'lossless' },
  '验活结果应压过副本与歌曲记录',
);
eq(
  pick(resolveQuality(null, { ext: 'flac' }, { ext: 'mp3', bitrate: 128 })),
  { label: '无损', tone: 'lossless' },
  '无验活时副本应压过歌曲记录的预览值',
);
eq(
  pick(resolveQuality(null, null, { ext: 'mp3', bitrate: 320 })),
  { label: '高品', tone: 'high' },
  '既无验活也无副本时退回歌曲记录',
);
eq(
  pick(resolveQuality({ state: 'dead' }, { ext: 'flac' }, {})),
  { label: '无损', tone: 'lossless' },
  '验活失败(state=dead)不应挡住副本来源',
);
// 真实复现场景:自建歌单里的歌,歌曲记录没有音质字段,但已在服务器上
eq(
  pick(resolveQuality(null, { ext: 'flac', size_bytes: 30_000_000 }, { id: 'x', source: 'netease', duration: 240 })),
  { label: '无损', tone: 'lossless' },
  '自建歌单场景(歌曲无音质字段 + 有服务器副本)应显示出音质',
);
// 三者全空 → null(界面不显示,而不是显示 "—" 占位)
eq(resolveQuality(null, null, { duration: 200 }), null, '无任何证据时应返回 null');

if (failures > 0) {
  console.error(`\nquality 契约测试失败 ${failures} 项`);
  process.exitCode = 1;
} else {
  console.log('quality 契约测试通过：码率分档 / 扩展名归一 / 副本反推 / 三路优先级 / 零值防护全部符合预期。');
}
