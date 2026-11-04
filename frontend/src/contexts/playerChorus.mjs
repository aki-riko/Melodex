// 副歌区间解析(纯函数,不依赖 React/DOM,便于 Node 契约测试)。
//
// 数据来源:歌曲 extra 里的 chorus_start_ms / chorus_end_ms,由 Provider / 后端写入。
// 这里**刻意不信任任何一层**:
//   · extra 可能是对象,也可能是 JSON 字符串(见 utils/songIdentity.js 对 extra 的宽容处理);
//   · 毫秒值可能是数字,也可能是数字字符串(不同来源序列化方式不一致);
//   · 字段可能缺失、为 null、为脏字符串,甚至是个对象/数组。
// 副歌标记只是"锦上添花"的展示层:任何解析失败都必须安静地退化成"没有副歌",
// 绝不能让一个元数据字段把播放器搞崩(这是全站唯一的 audio 元素,崩了整站没声音)。

// 区间长度下限:少于 5 秒的"副歌"多半是识别噪声(踩点/独白),画出来反而误导。
const MIN_CHORUS_SECONDS = 5;
// 位置下限:副歌不会出现在歌曲最开头(前 5% 多是前奏)。这条只在时长已知时才能判,
// 所以 durationSec 无效时**跳过**比例校验,而不是把数据判死。
const START_RATIO_FLOOR = 0.05;
const MS_PER_SECOND = 1000;

// extra 宽容解析成对象:对象直接用;字符串尝试 JSON.parse,失败视为无数据。
const toExtraObject = (extra) => {
  if (!extra) return null;
  if (typeof extra === 'object' && !Array.isArray(extra)) return extra;
  if (typeof extra !== 'string') return null;
  const raw = extra.trim();
  // 后端空 extra 常序列化成 '{}' / 'null' 这类无意义串,提前短路省一次 JSON.parse。
  if (!raw || raw === '{}' || raw === 'null') return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

// 毫秒字段 → 秒。空串/非数字/0/负数一律 null。
// 注意 Number('') === 0、Number('  ') === 0,所以必须先 trim 再判空,
// 否则"空字符串"会变成 start=0 这种假合法值。
const msToSeconds = (value) => {
  if (value == null) return null;
  const text = typeof value === 'string' ? value.trim() : value;
  if (text === '') return null;
  const ms = Number(text);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return ms / MS_PER_SECOND;
};

/**
 * 从歌曲 extra 解析合法的副歌区间。
 * @param {object|string|null|undefined} extra 歌曲 extra(对象或 JSON 字符串)
 * @param {number} [durationSec] 歌曲时长(秒);未知/为 0 时跳过 5% 比例校验
 * @returns {{start:number,end:number}|null} 秒为单位的区间,不合法返回 null
 */
export const parseChorusRange = (extra, durationSec = 0) => {
  try {
    const obj = toExtraObject(extra);
    if (!obj) return null;

    const start = msToSeconds(obj.chorus_start_ms);
    const end = msToSeconds(obj.chorus_end_ms);
    // 缺一边就无法定位:宁可没有标记,也不要画一条"半条副歌"。
    if (start == null || end == null) return null;
    // 顺序与长度校验,避免出现负宽度标记(视觉上会变成贴在最左侧的怪点)。
    if (end <= start) return null;
    if (end - start < MIN_CHORUS_SECONDS) return null;

    const duration = Number(durationSec);
    // 时长无效(0/NaN/负数)说明元数据还没到,此时放宽比例校验,等有值了自然会重算。
    if (Number.isFinite(duration) && duration > 0 && start < duration * START_RATIO_FLOOR) return null;

    return { start, end };
  } catch {
    // Symbol / 带副作用 getter / 循环引用等极端输入:解析失败等同于没有副歌。
    // 纯展示数据不该有资格中断播放。
    return null;
  }
};

/**
 * 把副歌起点换算成进度条上的百分比位置(0~100)。
 * @param {{start:number,end:number}|null} range parseChorusRange 的结果
 * @param {number} durationSec 歌曲时长(秒)
 * @returns {number|null} 百分比;区间或时长无效返回 null(UI 据此完全不渲染标记)
 */
export const chorusPercent = (range, durationSec) => {
  if (!range || typeof range !== 'object') return null;
  const duration = Number(durationSec);
  if (!Number.isFinite(duration) || duration <= 0) return null;
  const start = Number(range.start);
  if (!Number.isFinite(start)) return null;
  // 夹到 0~100:元数据时长与实际音频时长有偏差时,标记也不该溢出进度条。
  const pct = Math.min(100, Math.max(0, (start / duration) * 100));
  // 保留两位小数:避免 style 里出现一长串浮点数,也便于测试断言。
  return Math.round(pct * 100) / 100;
};
