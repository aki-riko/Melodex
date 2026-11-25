// 解析同步歌词并过滤没有时间轴的元信息行。
// QQ 逐字歌词与网易行级歌词共用同一套时间戳格式。
export const parseLRC = (raw) => {
  if (!raw || typeof raw !== 'string') return [];
  const re = /\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
  const toSec = (match) => parseInt(match[1], 10) * 60
    + parseInt(match[2], 10)
    + (match[3] ? parseInt(match[3].padEnd(3, '0'), 10) / 1000 : 0);
  const out = [];

  for (const line of raw.split(/\r?\n/)) {
    re.lastIndex = 0;
    const segments = [];
    let match;
    let previousTime = null;
    let previousEnd = 0;
    while ((match = re.exec(line)) !== null) {
      if (previousTime !== null) {
        segments.push({ t: previousTime, s: line.slice(previousEnd, match.index) });
      }
      previousTime = toSec(match);
      previousEnd = re.lastIndex;
    }
    if (previousTime !== null) segments.push({ t: previousTime, s: line.slice(previousEnd) });
    if (segments.length === 0) continue;

    const text = segments.map((segment) => segment.s).join('').replace(/\s+$/, '');
    if (!text.trim()) continue;

    const words = segments
      .filter((segment) => segment.s.length > 0)
      .map((segment) => ({ t: segment.t, s: segment.s }));
    out.push({
      t: segments[0].t,
      text,
      words: words.length >= 2 ? words : null,
    });
  }

  out.sort((a, b) => a.t - b.t);
  // ★ end 必须按「时间戳严格大于本行的第一行」来定，**不能**直接取下一行。
  //
  // 踩过的坑（2026-11，用户报「双语歌词逐字有问题」，播放页和桌面歌词都有）：
  // QQ 的双语逐字里，原文行与拼音/翻译行**时间戳完全相同**：
  //     [00:44.88]冲[00:45.07]得…（原文）
  //     [00:44.88]cong [00:45.07]da …（拼音）
  // 直接写 `end = 下一行.t` 会让原文行 end === 自身 t（实测 44.88 === 44.88），
  // 整行时长变成 0：填色进度只能二值化，且原文行永远不会是"当前行"，
  // 而拼音行独吞了后面 6.23 秒 —— 用户看到的就是「译音行在逐字变色、原文一行不亮」。
  // 改成跳过同戳行之后，同组每行都拿到同一个真实 end（51.11），填色才与原文对齐。
  for (let i = 0; i < out.length; i += 1) {
    let nextIndex = i + 1;
    while (nextIndex < out.length && out[nextIndex].t <= out[i].t) nextIndex += 1;
    out[i].end = nextIndex < out.length ? out[nextIndex].t : out[i].t + 5;
    if (out[i].words) {
      for (let j = 0; j < out[i].words.length; j += 1) {
        out[i].words[j].end = j + 1 < out[i].words.length
          ? out[i].words[j + 1].t
          : out[i].end;
      }
    }
  }
  return out;
};

/**
 * 当前播放位置对应的歌词行索引 —— 播放页与桌面歌词**必须共用这一个**。
 *
 * 与 `desktop/ui/lyricsCore.js` 的 `lyricIndexAt` 完全同构（二分 + 回退到同戳分组
 * **首行**）。同一份歌词在两端算出不同行，用户会直接看出来（同一时刻播放页停在
 * 拼音行、桌面停在原文行）—— 这正是「双语歌词逐字有问题」的另一半原因。
 */
export const currentLyricIndexAt = (lines, position) => {
  if (!Array.isArray(lines) || lines.length === 0) return -1;
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
  if (answer < 0) return -1;
  // 回退到同戳分组首行：同组是「原文 + 拼音/翻译」，首个才该被当作当前行。
  const activeTimestamp = Number(lines[answer]?.t);
  while (answer > 0 && Number(lines[answer - 1]?.t) === activeTimestamp) answer -= 1;
  return answer;
};

const unavailableLyricText = /^暂无歌词[。.!！]?$/;

/**
 * 剔除「占位行」—— 平台在没拿到歌词时会返回一条 `[00:00.00]暂无歌词`，
 * 它带着合法时间戳，会混进正常歌词里。
 *
 * ★ 为什么必须**删掉**而不是只判断（踩过，用户截图报「一半着色一半没有」）：
 *   之前只有 `hasUsableLyrics` 做"有没有真歌词"的判断，
 *   但这条占位行仍留在数组里。桌面歌词窗拿它当普通歌词渲染，
 *   `lineProgress` 按 t/end 算出进度 → 整行或半行被涂成"已播放色"，
 *   用户看到的就是「暂无歌词」四个字一半粉一半白。
 *   过滤掉之后数组为空 → 桌面歌词窗按"无歌词"回退显示歌曲名/歌手名，
 *   与旧版 PrismQML 行为一致。
 */
export const stripPlaceholderLyrics = (lines) => {
  if (!Array.isArray(lines)) return [];
  return lines.filter((line) => {
    const text = String(line?.text || '').trim();
    return text && !unavailableLyricText.test(text);
  });
};

export const hasUsableLyrics = (lines) => Array.isArray(lines) && lines.some((line) => {
  const text = String(line?.text || '').trim();
  return text && !unavailableLyricText.test(text);
});
