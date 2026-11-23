// 桌面歌词的纯逻辑核心（无 DOM、无 Tauri 依赖，可直接被 node 测试）。
//
// ★ 这里每个函数都必须与旧 PrismQML 实现**逐行等价**，改之前先对照：
//   - 行索引/副行索引/行进度 → `desktop-prismqml/cpp/Lyrics.cpp`
//   - 逐字填充             → `desktop-prismqml/melodex_desktop/player.py:186`
// 旧版是这些观感的唯一权威：歌词"卡在上一行回退"、"同一时刻多行只亮第一行"
// 这类差异都会立刻被用户看出来。

export const desktopLyricsDeviceWebSocketURL = (baseURL) => {
  const url = new URL('/rest/desktop-lyrics/device', baseURL);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
};

/**
 * 当前时间对应的歌词行索引 —— 复刻 `Lyrics.cpp:currentLyricIndex`。
 *
 * 两步：
 *   ① 二分找最后一个 `t <= position` 的行；
 *   ② **回退到同一时间戳分组的第一行**。
 *
 * 第 ② 步是新版曾经漏掉的关键行为（`Lyrics.cpp:107-128`）：
 * LRC 里同一时刻常有**多行**（合唱双行、原词+翻译行），它们时间戳完全相同。
 * 只做第 ① 步会随后续行累积而停在分组末尾，表现为「合唱那两行先亮下面那行」；
 * 旧版则永远停在分组**第一行**，副行顺着往下走。
 */
export const lyricIndexAt = (lyrics, position) => {
  const lines = Array.isArray(lyrics) ? lyrics : [];
  let low = 0;
  let high = lines.length - 1;
  let answer = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (Number(lines[middle]?.t) <= position) {
      answer = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  if (answer < 0) return answer;
  // 回退到分组首行，与旧版 while 循环等价（只比时间戳是否严格相等）。
  const activeTimestamp = Number(lines[answer]?.t);
  while (answer > 0 && Number(lines[answer - 1]?.t) === activeTimestamp) {
    answer -= 1;
  }
  return answer;
};

/**
 * 副行索引 —— 复刻 `Lyrics.cpp:secondaryLyricIndex`。
 *
 * 三个边界都是旧版原样：
 *   - 没有歌词 → -1；
 *   - 还没唱到第一行（active=-1）→ 0（副行位置显示第一行，而不是空白）；
 *   - 已到最后一行 → -1。
 */
export const secondaryLyricIndex = (lyrics, activeIndex) => {
  const lines = Array.isArray(lyrics) ? lyrics : [];
  if (lines.length === 0) return -1;
  if (activeIndex < 0) return 0;
  if (activeIndex >= lines.length) return -1;
  return activeIndex + 1 < lines.length ? activeIndex + 1 : -1;
};

export const lyricFrame = (lyrics, position) => {
  const lines = Array.isArray(lyrics) ? lyrics : [];
  const index = lyricIndexAt(lines, position);
  const nextIndex = secondaryLyricIndex(lines, index);
  return {
    index,
    previous: index > 0 ? lines[index - 1] : null,
    current: index >= 0 ? lines[index] : null,
    next: nextIndex >= 0 ? lines[nextIndex] : null,
  };
};

/**
 * 单个词的填充比例（0..1）。
 *
 * 供「逐词」场景使用；整行进度请用 `lineProgress`（按字数加权，与旧版一致）。
 */
export const lyricWordFill = (word, position) => {
  const start = Number(word?.t) || 0;
  const end = Math.max(start, Number(word?.end) || start);
  if (position <= start) return 0;
  if (position >= end || end === start) return 1;
  return Math.max(0, Math.min(1, (position - start) / (end - start)));
};

/**
 * 单个"字符"的**视觉宽度权重**（以全角汉字为 1.0）。
 *
 * ★ 为什么需要它（用户实测：「逐字歌词有时候会跳着显示，主要在空格之后」）：
 *   旧实现（含旧版 `Lyrics.cpp`）用 `Σ max(1, len(word.s))` 按**字数**加权，
 *   把空格也算成 1 整字。但空格的渲染宽度只有汉字的约 1/4，
 *   于是「字数进度」比「像素进度」跑得快/慢，填色位置会在空格处突然跳一下。
 *
 *   实测（「眉目缱绻中 飘零 随风」，词时间均匀分布）：
 *     按字数进度  0.454 / 0.727 / 1.000
 *     按像素进度  0.523 / 0.761 / 1.000
 *     最大偏差 **0.66em**（约 0.7 个字宽）→ 视觉上就是"跳"
 *   无空格的行两者完全一致（偏差 0.0001），这也解释了为什么问题总出在空格后。
 *
 * 权重取值（近似 CSS 排版比例）：
 *   空白 0.28 ／ 全角/CJK 1.0 ／ 其他（拉丁、数字、符号）0.55
 */
const charWidthWeight = (ch) => {
  if (ch === ' ' || ch === '\u3000' || ch === '\t' || ch === '\n') return 0.28;
  const code = ch.codePointAt(0) || 0;
  // CJK 统一表意文字、扩展 A、兼容表意、日文假名、全角标点/字母
  const isWide = (code >= 0x1100 && code <= 0x115f) // 谚文字母
    || (code >= 0x2e80 && code <= 0xa4cf) // CJK 部首~彝文
    || (code >= 0xac00 && code <= 0xd7a3) // 谚文音节
    || (code >= 0xf900 && code <= 0xfaff) // CJK 兼容表意
    || (code >= 0xfe30 && code <= 0xfe6f) // CJK 兼容形式
    || (code >= 0xff00 && code <= 0xff60) // 全角形式
    || (code >= 0xffe0 && code <= 0xffe6);
  return isWide ? 1.0 : 0.55;
};

/** 一段文字的视觉总宽度（相对全角汉字）。 */
const textWidthWeight = (text) => {
  let width = 0;
  for (const ch of String(text ?? '')) width += charWidthWeight(ch);
  return width;
};

/**
 * 整行填色进度 —— 与旧版 `Lyrics.cpp:lyricProgress` 同构，但权重从**字数改视觉宽度**。
 *
 * 有 words 时：
 *   totalWidth = Σ max(0.28, textWidthWeight(word.s))
 *   逐个词累加：已过 end 的整词进位，正在唱的按时间插值，然后 break
 *   progress = completed / totalWidth
 *
 * ★ 与旧版的**有意差异**：旧版按字符数（空格算 1 整字），这里按视觉宽度。
 *   原因见 `charWidthWeight` 的注释（用户实测空格后填色会跳）。
 *   纯中文无空格时两者结果一致，所以不会影响原来的观感。
 *
 * 无 words（行级 LRC）时 `(position - t) / (end - t)`，且 `end <= start` 时返回 1（不是除零）。
 */
export const lineProgress = (line, position) => {
  if (!line) return 0;
  const words = Array.isArray(line.words) ? line.words : [];

  if (words.length > 0) {
    // 每个词的视觉宽度权重；空串按最小 0.28 兜底（不能让总宽度变 0）。
    const weights = words.map((word) => Math.max(0.28, textWidthWeight(word?.s)));
    let totalWidth = 0;
    for (const weight of weights) totalWidth += weight;

    let completed = 0;
    for (let index = 0; index < words.length; index += 1) {
      const word = words[index];
      const weight = weights[index];
      const start = Number(word?.t) || 0;
      const end = Number(word?.end) || start;
      if (position >= end) {
        completed += weight;
        continue;
      }
      if (position > start && end > start) {
        completed += weight * ((position - start) / (end - start));
      }
      break;
    }
    return Math.max(0, Math.min(1, completed / Math.max(0.28, totalWidth)));
  }

  const start = Number(line.t) || 0;
  const end = Number.isFinite(Number(line.end)) ? Number(line.end) : start + 5;
  // 旧版无 words 分支不判 position<=start，直接算比值；这里保持同式，
  // 但因为 progress 会被 clamp 到 [0,1]，早于 start 时结果为 0，观感一致。
  if (end <= start) return 1;
  return Math.max(0, Math.min(1, (position - start) / (end - start)));
};
