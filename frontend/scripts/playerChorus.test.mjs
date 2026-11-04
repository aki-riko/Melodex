import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chorusPercent, parseChorusRange } from '../src/contexts/playerChorus.mjs';

// 副歌区间是"锦上添花"的展示层数据:Provider 什么时候写入、写成字符串还是数字都不确定,
// 而播放器是全站唯一的 audio 元素,任何元数据异常都不能把播放搞崩。
// 这些用例把"宽容解析 + 严格过滤"两头都钉死。

// ---- 1. 合法区间 ----
assert.deepEqual(
  parseChorusRange({ chorus_start_ms: 42000, chorus_end_ms: 68000 }, 200),
  { start: 42, end: 68 },
  '数字毫秒应换算成秒',
);
assert.deepEqual(
  parseChorusRange({ chorus_start_ms: '42000', chorus_end_ms: '68000' }, 200),
  { start: 42, end: 68 },
  '字符串毫秒同样必须被接受(后端序列化方式不一致)',
);
assert.deepEqual(
  parseChorusRange({ chorus_start_ms: '42000', chorus_end_ms: 68000 }, 200),
  { start: 42, end: 68 },
  '同一字段数字/字符串混用也要容忍',
);

// ---- 2. 缺字段 / 空 extra ----
assert.equal(parseChorusRange({}, 200), null, '空 extra 应返回 null');
assert.equal(parseChorusRange(null, 200), null, 'extra 为 null 应返回 null');
assert.equal(parseChorusRange(undefined, 200), null, 'extra 为 undefined 应返回 null');
assert.equal(
  parseChorusRange({ chorus_start_ms: 42000 }, 200),
  null,
  '只有起点没有终点应返回 null —— 画不出区间',
);
assert.equal(
  parseChorusRange({ chorus_end_ms: 68000 }, 200),
  null,
  '只有终点没有起点应返回 null',
);
assert.equal(parseChorusRange({ chorus_start_ms: '', chorus_end_ms: '' }, 200), null, '空字符串不算合法数字');
assert.equal(parseChorusRange({ chorus_start_ms: null, chorus_end_ms: 68000 }, 200), null, 'null 值应被拒绝');

// ---- 3. 顺序非法 / 负数 / 0 ----
assert.equal(
  parseChorusRange({ chorus_start_ms: 68000, chorus_end_ms: 42000 }, 200),
  null,
  'end <= start(倒序)应返回 null',
);
assert.equal(
  parseChorusRange({ chorus_start_ms: 42000, chorus_end_ms: 42000 }, 200),
  null,
  'end 等于 start(零长度)应返回 null',
);
assert.equal(
  parseChorusRange({ chorus_start_ms: -1000, chorus_end_ms: 68000 }, 200),
  null,
  '负数起点应返回 null',
);
assert.equal(parseChorusRange({ chorus_start_ms: 0, chorus_end_ms: 68000 }, 200), null, '0 起点应返回 null');
assert.equal(parseChorusRange({ chorus_start_ms: 42000, chorus_end_ms: 0 }, 200), null, '0 终点应返回 null');

// ---- 4. 区间过短 ----
assert.equal(
  parseChorusRange({ chorus_start_ms: 42000, chorus_end_ms: 44000 }, 200),
  null,
  '不足 5 秒的区间视为噪声,应返回 null',
);
assert.deepEqual(
  parseChorusRange({ chorus_start_ms: 42000, chorus_end_ms: 47000 }, 200),
  { start: 42, end: 47 },
  '恰好 5 秒应保留(边界是"至少 5 秒")',
);

// ---- 5. 开头 5% 比例校验 ----
assert.equal(
  parseChorusRange({ chorus_start_ms: 5000, chorus_end_ms: 30000 }, 200),
  null,
  '起点早于时长 5%(200 秒的 5% = 10 秒)应返回 null',
);
assert.deepEqual(
  parseChorusRange({ chorus_start_ms: 12000, chorus_end_ms: 30000 }, 200),
  { start: 12, end: 30 },
  '起点晚于时长 5% 应保留',
);
assert.deepEqual(
  parseChorusRange({ chorus_start_ms: 5000, chorus_end_ms: 30000 }, 0),
  { start: 5, end: 30 },
  '时长未知(0)时必须跳过比例校验,不能把数据判死',
);
assert.deepEqual(
  parseChorusRange({ chorus_start_ms: 5000, chorus_end_ms: 30000 }),
  { start: 5, end: 30 },
  '不传时长参数时同样跳过比例校验',
);

// ---- 6. extra 是 JSON 字符串 ----
assert.deepEqual(
  parseChorusRange('{"chorus_start_ms":"42000","chorus_end_ms":"68000"}', 200),
  { start: 42, end: 68 },
  'extra 为 JSON 字符串时必须先解析再取值',
);
assert.deepEqual(
  parseChorusRange(' {"chorus_start_ms":42000,"chorus_end_ms":68000} ', 200),
  { start: 42, end: 68 },
  '带首尾空白的 JSON 字符串也要能解析',
);
assert.equal(parseChorusRange('not json', 200), null, '非法 JSON 字符串应安静返回 null');
assert.equal(parseChorusRange('{}', 200), null, '空对象字符串应返回 null');
assert.equal(parseChorusRange('null', 200), null, "'null' 字符串应返回 null");
assert.equal(parseChorusRange('[1,2]', 200), null, '数组不是合法 extra,应返回 null');

// ---- 7. 脏值绝不抛异常 ----
assert.equal(
  parseChorusRange({ chorus_start_ms: 'abc', chorus_end_ms: 68000 }, 200),
  null,
  '非数字字符串应返回 null',
);
assert.equal(parseChorusRange({ chorus_start_ms: {}, chorus_end_ms: 68000 }, 200), null, '对象值应返回 null');
// 时长脏值等价于"时长未知":流程按约定跳过比例校验,但绝不能因此抛异常。
assert.doesNotThrow(
  () => parseChorusRange({ chorus_start_ms: 42, chorus_end_ms: 68000 }, 'abc'),
  '时长脏值不应让解析抛异常',
);
assert.deepEqual(
  parseChorusRange({ chorus_start_ms: 42, chorus_end_ms: 68000 }, 'abc'),
  { start: 0.042, end: 68 },
  '时长无法解析时按未知处理:跳过比例校验而不是把数据判死',
);
assert.doesNotThrow(() => parseChorusRange(Symbol('x'), 200), 'Symbol 输入不得抛异常');
const hostileExtra = {
  get chorus_start_ms() { throw new Error('boom'); },
  chorus_end_ms: 68000,
};
assert.doesNotThrow(() => parseChorusRange(hostileExtra, 200), '取值抛错的 getter 不得把播放器带崩');
assert.equal(parseChorusRange(hostileExtra, 200), null, 'getter 抛错时按无数据处理');

// ---- 8. chorusPercent ----
assert.equal(chorusPercent({ start: 50, end: 80 }, 200), 25, '副歌起点应换算成百分比位置');
assert.equal(chorusPercent({ start: 0, end: 10 }, 200), 0, '起点为 0 时百分比为 0');
assert.equal(chorusPercent({ start: 200, end: 210 }, 200), 100, '起点超出时长时应夹到 100,不溢出进度条');
assert.equal(chorusPercent({ start: 30, end: 80 }, 200), 15, '普通换算应保留精确值');
assert.equal(chorusPercent({ start: 1, end: 6 }, 3), 33.33, '百分比应保留两位小数');
assert.equal(chorusPercent(null, 200), null, '区间为 null 时应返回 null');
assert.equal(chorusPercent({ start: 50, end: 80 }, 0), null, '时长为 0 时应返回 null');
assert.equal(chorusPercent({ start: 50, end: 80 }, -10), null, '负时长应返回 null');
assert.equal(chorusPercent({ start: 50, end: 80 }, NaN), null, 'NaN 时长应返回 null');
assert.equal(chorusPercent({ start: 50, end: 80 }), null, '未传时长应返回 null');
assert.equal(chorusPercent({ start: 50, end: 80 }, 'abc'), null, '脏时长应返回 null');

// ---- 9. 端到端:解析 + 换算 ----
const e2eRange = parseChorusRange({ chorus_start_ms: '69000', chorus_end_ms: '95000' }, 210);
assert.deepEqual(e2eRange, { start: 69, end: 95 }, '端到端解析应得到秒为单位的区间');
assert.equal(chorusPercent(e2eRange, 210), 32.86, '端到端百分比应可交给 style 的 left 使用');

// ---- 10. PlayerBar 静态契约 ----
// 门禁兜的是"改播放器时把副歌标记删掉/接错"这类回归:这里断言三处进度条都接了标记,
// 且解析结果来自 useMemo 派生(而不是每帧重算)。
const playerContextSource = await readFile(
  new URL('../src/contexts/PlayerContext.js', import.meta.url),
  'utf8',
);
assert.match(playerContextSource, /from '\.\/playerChorus\.mjs'/, 'PlayerContext 必须从 playerChorus.mjs 导入副歌解析');
assert.match(playerContextSource, /parseChorusRange\(/, 'PlayerContext 必须调用 parseChorusRange');
assert.match(playerContextSource, /useMemo\(/, '副歌区间应由 useMemo 派生,避免每帧重新解析 extra');
assert.equal(
  (playerContextSource.match(/<ChorusMarker\b/g) || []).length,
  3,
  '三处真实进度条(桌面横条 / 移动全屏页 / 桌面全屏页)都应渲染可点副歌标记',
);
assert.match(
  playerContextSource,
  /aria-label="跳到副歌"/,
  '副歌标记必须有可访问名称(uxGuards 也要求图标按钮带 aria-label/title)',
);
assert.match(playerContextSource, /title="跳到副歌"/, '副歌标记应有鼠标悬停提示');
assert.match(
  playerContextSource,
  /pointer-events-none/,
  '移动迷你条那条 2px 细进度条上只放不可点的视觉指示',
);

console.log('playerChorus tests passed');
