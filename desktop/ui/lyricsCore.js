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
 * 整行填色进度 —— 复刻 `Lyrics.cpp:lyricProgress`（行 140-170）。
 *
 * 有 words 时**按字数加权**，不是按词块数平均：
 *   totalChars = Σ max(1, len(word.s))
 *   逐个词累加：已过 end 的整词计数，正在唱的按时间插值，然后 break
 *   progress = completed / totalChars
 *
 * 无 words（行级 LRC）时 `(position - t) / (end - t)`，且旧版在
 * `end <= start` 时直接返回 1（不是除零）。
 */
export const lineProgress = (line, position) => {
  if (!line) return 0;
  const words = Array.isArray(line.words) ? line.words : [];

  if (words.length > 0) {
    let totalChars = 0;
    for (const word of words) {
      totalChars += Math.max(1, String(word?.s ?? '').length);
    }
    let completed = 0;
    for (const word of words) {
      const chars = Math.max(1, String(word?.s ?? '').length);
      const start = Number(word?.t) || 0;
      const end = Number(word?.end) || start;
      if (position >= end) {
        completed += chars;
        continue;
      }
      if (position > start && end > start) {
        completed += chars * ((position - start) / (end - start));
      }
      break;
    }
    return Math.max(0, Math.min(1, completed / Math.max(1, totalChars)));
  }

  const start = Number(line.t) || 0;
  const end = Number.isFinite(Number(line.end)) ? Number(line.end) : start + 5;
  // 旧版无 words 分支不判 position<=start，直接算比值；这里保持同式，
  // 但因为 progress 会被 clamp 到 [0,1]，早于 start 时结果为 0，观感一致。
  if (end <= start) return 1;
  return Math.max(0, Math.min(1, (position - start) / (end - start)));
};
