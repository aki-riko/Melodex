import assert from 'node:assert/strict';
import { urlSafeExtraValue, URL_HEAVY_EXTRA_KEYS } from '../src/utils/songUrlExtra.js';

// 回归背景:2026-09 QQ 逐字歌词(QRC)把整首 LRC 写进搜索结果 extra.lyric,
// 前端把它序列化进 /music/playback_segment 与 /music/download 的查询串后,
// 请求行约 20KB,直接超过 Nginx large_client_header_buffers,连接在代理层
// 被重置:浏览器只报 Failed to fetch,后端与 NPM 日志零记录,该歌无法播放/下载。

const BULKY_LRC = `[00:00.000]街[00:00.015]角[00:00.030]的[00:00.046]晚[00:00.061]风\n${'缠'.repeat(2000)}`;

assert.deepEqual(URL_HEAVY_EXTRA_KEYS, ['lyric']);

// 1) 对象 extra:剔除 lyric,其余键原样保留且顺序稳定。
const qqExtra = {
  _rank: '0',
  has_lossless: '1',
  lyric: BULKY_LRC,
  lyric_verbatim: '1',
  provider: 'melodex-native',
  songmid: '001e2FJz3QXaf0',
};
const cleaned = urlSafeExtraValue(qqExtra);
assert.ok(cleaned.length > 0);
assert.ok(!cleaned.includes('lyric":'), '不应残留任何 lyric 字段');
assert.ok(!cleaned.includes(BULKY_LRC.slice(0, 24)));
const parsed = JSON.parse(cleaned);
assert.equal(parsed.provider, 'melodex-native');
assert.equal(parsed.songmid, '001e2FJz3QXaf0');
assert.equal(parsed.lyric_verbatim, '1', '轻量标记字段必须保留');
assert.equal(parsed.has_lossless, '1');
assert.equal(parsed._rank, '0');

// 2) 剔除后只剩空对象 → 整个 extra 参数省略。
assert.equal(urlSafeExtraValue({ lyric: BULKY_LRC }), '');

// 3) 无 lyric 的对象保持原 JSON 语义;空对象/空值省略。
assert.equal(urlSafeExtraValue({ songmid: 'abc' }), '{"songmid":"abc"}');
assert.equal(urlSafeExtraValue({}), '');
assert.equal(urlSafeExtraValue(null), '');
assert.equal(urlSafeExtraValue(undefined), '');
assert.equal(urlSafeExtraValue(''), '');

// 4) 字符串形态(历史数据)同样剔除内嵌歌词。
const asString = JSON.stringify(qqExtra);
assert.equal(urlSafeExtraValue(asString), cleaned);
assert.equal(urlSafeExtraValue(JSON.stringify({ lyric: BULKY_LRC })), '');

// 5) 非法 JSON 字符串原样透传,不改变既有行为。
assert.equal(urlSafeExtraValue('not-json'), 'not-json');
assert.equal(urlSafeExtraValue('{"lyric":'), '{"lyric":');

// 6) 关键契约:构造后的播放 URL 必须远小于代理请求行上限(8KB)。
const params = new URLSearchParams();
params.set('id', '001e2FJz3QXaf0');
params.set('source', 'qq');
params.set('name', '街角的晚风');
params.set('artist', '陈小春');
params.set('album', '街角的晚风');
params.set('duration', '240');
params.set('cover', 'https://y.gtimg.cn/music/photo_new/T002R300x300M0000028jKt80PGmlB.jpg');
const safeValue = urlSafeExtraValue(qqExtra);
if (safeValue) params.set('extra', safeValue);
params.set('chunk', '0');
const url = `/music/playback_segment?${params.toString()}`;
assert.ok(url.length < 1024, `播放 URL 必须短于 1KB,实际 ${url.length}`);
assert.ok(!url.includes('lyric%22'), 'URL 中不得出现 lyric 字段(lyric_verbatim 等标记除外)');
assert.ok(!url.includes(encodeURIComponent(BULKY_LRC.slice(0, 24))), 'URL 中不得出现歌词内容');

console.log('songUrlExtra: all assertions passed');
