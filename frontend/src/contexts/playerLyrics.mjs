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
  for (let i = 0; i < out.length; i += 1) {
    out[i].end = i + 1 < out.length ? out[i + 1].t : out[i].t + 5;
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
