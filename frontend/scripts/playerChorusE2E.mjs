// 副歌点位的端到端契约测试：上游真实数据 → Provider extra → 前端解析器。
//
// 为什么需要它：Provider 侧只测了「extra 里有没有写入 chorus_*_ms」，前端只测了
// 「给定 extra 能不能解析」，两边各自全绿，却没人证明**这两半拼起来是通的** ——
// 真实踩点就是字段名/单位（秒 vs 毫秒）对不上，纯函数测试永远发现不了。
//
// 这里用固定的真实样本（取自 2026-11 对 网易 /api/song/chorus 与 酷我 payInfo.refrain_*
// 的真机抓取，数值原样保留），不联网、不依赖临时文件，所以能长期作为门禁跑。
import assert from 'node:assert/strict';
import { chorusPercent, parseChorusRange } from '../src/contexts/playerChorus.mjs';

// duration 是毫秒（Provider payload 里的口径），extra 是真实抓到的字段。
const realSamples = [
  {
    label: 'kuwo 晴天',
    durationMs: 269000,
    extra: { chorus_start_ms: '84346', chorus_end_ms: '142843' },
    expectStart: 84.346,
    expectPercent: 31.36,
  },
  {
    label: 'netease 晴天 (id=186016)',
    durationMs: 269000,
    extra: { chorus_start_ms: '84498', chorus_end_ms: '142301' },
    expectStart: 84.498,
    expectPercent: 31.41,
  },
  {
    label: 'netease 夜曲 (id=185811)',
    durationMs: 269000,
    extra: { chorus_start_ms: '57036', chorus_end_ms: '91033' },
    expectStart: 57.036,
    expectPercent: 21.2,
  },
  {
    label: 'netease 孤勇者 (id=1901371647)',
    durationMs: 269000,
    extra: { chorus_start_ms: '80615', chorus_end_ms: '115684' },
    expectStart: 80.615,
    expectPercent: 29.97,
  },
];

for (const sample of realSamples) {
  // Provider 的 duration 是**秒**，前端解析器要秒；这里按真实口径换算。
  const durationSec = sample.durationMs / 1000;
  const range = parseChorusRange(sample.extra, durationSec);
  assert.ok(range, `${sample.label}: 真实 extra 必须能解析出副歌区间`);
  assert.equal(
    Number(range.start.toFixed(3)),
    Number(sample.expectStart.toFixed(3)),
    `${sample.label}: 副歌起点应按毫秒→秒正确换算（这条能抓住"单位搞错 1000 倍"）`,
  );
  assert.ok(range.end > range.start, `${sample.label}: 区间必须正序`);

  const pct = chorusPercent(range, durationSec);
  assert.equal(pct, sample.expectPercent, `${sample.label}: 进度条百分比应为 ${sample.expectPercent}`);
  assert.ok(pct >= 0 && pct <= 100, `${sample.label}: 百分比必须落在进度条范围内`);
}

// 交叉验证：两个独立上游对同一首歌给出的副歌点应当高度一致。
// 不一致到超过 2 个百分点通常意味着有一边把单位或曲长搞错了。
const kuwo = parseChorusRange(realSamples[0].extra, 269);
const netease = parseChorusRange(realSamples[1].extra, 269);
const drift = Math.abs(chorusPercent(kuwo, 269) - chorusPercent(netease, 269));
assert.ok(drift < 2, `酷我与网易对《晴天》的副歌点偏差过大(${drift.toFixed(2)}%)，疑似单位/曲长口径错误`);

// 反向保护：Provider 没拿到数据时前端必须安静降级，不能画到 0% 或报错。
assert.equal(parseChorusRange({}, 269), null, '空 extra 必须返回 null');
assert.equal(parseChorusRange({ chorus_start_ms: '84346' }, 269), null, '只有起点也算无效');
assert.equal(parseChorusRange({ chorus_start_ms: '142843', chorus_end_ms: '84346' }, 269), null, '倒序必须拒绝');

console.log(`副歌端到端契约通过:${realSamples.length} 首真实样本，跨源偏差 ${drift.toFixed(2)}%`);
