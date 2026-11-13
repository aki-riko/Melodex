// 全屏播放页的动效纯逻辑(无 React 依赖,便于 Node 合同测试直接导入)。
//
// 放在独立模块的原因:PlayerContext.js 已超过 2000 行,而这些规则恰恰是
// "写错了构建不报错、只有手感变差"的那一类,必须能被单测锁住。

/**
 * 收起动画时长(ms)。与 index.css 里 `.player-sheet-exit` 的 0.26s 一一对应:
 * 定时器到点才卸载播放页。两边只改一边,会出现"滑出后空等"或"没滑完就消失"。
 * playerSheetMotion.test.mjs 会比对两处数值。
 */
export const SHEET_EXIT_MS = 260;

/** 系统是否开启了"减少动态效果"。非浏览器环境(测试)一律视为否。 */
export const prefersReducedMotion = () => {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
};

/**
 * 收起播放页要等多久再卸载。
 * reduced-motion 下 CSS 动画被压成 1ms,播放页瞬间滑出 —— 若仍等满 260ms,
 * 用户会看到一块已经不在动、却还拦着点击的透明层(实际是 forwards 停在屏外的播放页)。
 */
export const sheetExitDelay = (reduced) => (reduced ? 0 : SHEET_EXIT_MS);

/**
 * 歌词自动居中时用平滑滚动还是瞬移。
 *
 * 只有「同一首歌、歌词区已在显示、当前行往下走了一行」才该平滑滚动。
 * 以下情况必须瞬移('auto'):
 *   · 歌词区刚出现(展开播放页 / 封面切到歌词):否则会从第一行一路滑到当前行,
 *     而且与播放页上滑、淡入动画叠在一起,看着像页面在乱晃;
 *   · 换歌:新歌当前行与旧歌位置毫无关系,平滑滑过去只是噪音。
 *
 * @param {{songKey:string, visible:boolean}|null} prev 上一次滚动时的快照
 * @param {{songKey:string, visible:boolean}} next 本次
 * @returns {'auto'|'smooth'|null} null 表示不需要滚动(歌词区不可见)
 */
export const lyricScrollBehavior = (prev, next) => {
  if (!next || !next.visible) return null;
  if (!prev || !prev.visible) return 'auto';
  if (prev.songKey !== next.songKey) return 'auto';
  return 'smooth';
};

/**
 * 逐字歌词某个字的填色进度(0~100)。
 * 已唱完 = 100,未开始 = 0,唱到一半按时间比例。时间戳异常(end<=t)时按"未开始/已结束"二值处理。
 */
export const karaokeFillPercent = (word, cur) => {
  if (!word) return 0;
  const t = Number(word.t);
  const end = Number(word.end);
  const now = Number(cur);
  if (!Number.isFinite(now) || !Number.isFinite(t)) return 0;
  if (Number.isFinite(end) && now >= end) return 100;
  if (!(Number.isFinite(end) && end > t) || now <= t) return 0;
  return Math.max(0, Math.min(1, (now - t) / (end - t))) * 100;
};
