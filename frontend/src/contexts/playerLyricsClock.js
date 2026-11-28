// 桌面歌词窗的「实时播放位置」取数与推送节奏 —— 纯逻辑，零 React / 零 DOM。
//
// ★ 为什么需要这个文件（2026-11-28 用户报「桌面歌词逐字歌词行首会回弹一下」）：
//
// 根因是**推给歌词窗的位置是陈旧的采样值**，两处叠加：
//
//   ① 整包（type:'track'）在 `lyricIdx` 变化时立刻发，但位置取的是组件里缓存的
//      `progress.cur` —— 那是上一次 timeupdate 的采样值，天然滞后 0~250ms。
//   ② `progress` 包用 `setInterval(250)` 发，而该 effect 依赖里含 `progress.cur`；
//      timeupdate 每变一次 cur 就 clearInterval + 重建定时器，**间隔 ≤250ms 时
//      定时器永远来不及触发**。实测 50s 播放只发出 2 个 progress 包、10 个整包。
//
// 于是歌词窗几乎只能靠"行首整包"重新锚定位置，而它带着随机滞后；
// 歌词窗的 `effectivePosition()` 是 `position + (now - receivedAt)` 外推，
// 新包一覆盖就把位置**往回拨**（实测每次 -250ms），逐字填色随之后退 ——
// 用户看到的就是行首那一下回弹。
//
// 实测（离线重放真实 overlay.js + 真实推送时序，120s / 12 行）：
//   填色回退 12 次，平均回退量 0.053（约 0.7 个字宽）；
//   位置倒退 14 次、每次 -250ms，其中 7 次落在行首 600ms 内。
//
// 两条修法（本文件负责第 ① 条，第 ② 条在 desktop/ui/lyricsCore.js 的
// `advanceLyricsAnchor`，两侧都做才稳）：
//   ① 发送侧改报**真实播放位置**，而不是闭包里的陈旧 state；
//   ② 接收侧对锚点做单调保护（除非是显式 seek / 换歌）。

/**
 * 取「此刻」的真实播放位置（秒）。
 *
 * 优先级（每一项都对应真实代码路径，不要随意调换）：
 *   1. `resume`：跳转后目标已定、但音频还没追上。此时必须报目标，
 *      否则会把用户刚拖到的位置报回去（和进度条回弹是同一个 bug）。
 *   2. `pending`：拖动进行中 —— 只认拇指，播放器报什么都是拖动前的位置。
 *   3. 音频元素的 `currentTime`：最接近真实播放点。仅在**未暂停**且有限时采用。
 *   4. 兜底 `fallback`：暂停时 currentTime 停在原处，直接用；或音频还没就绪。
 *
 * ★ 为什么暂停时不用 `currentTime` 而用 fallback：两者通常相等，
 *   但暂停瞬间 `currentTime` 可能被浏览器夹到缓冲边界，而 `fallback`
 *   （= 界面正在显示的进度）才是用户眼里的位置。取 fallback 不会跳。
 *
 * @param {object} options
 * @param {{currentTime?: number} | null} options.audio 音频元素（可空）
 * @param {boolean} options.paused 是否暂停
 * @param {number|null} options.resume 待恢复/已提交的跳转目标（秒）
 * @param {boolean} options.pending 是否正在拖动进度条
 * @param {number} options.fallback 兜底位置（秒）
 * @returns {number} 0 以上的有限秒数
 */
export const liveLyricsPosition = ({
  audio = null,
  paused = false,
  resume = null,
  pending = false,
  fallback = 0,
} = {}) => {
  const safeFallback = Number.isFinite(Number(fallback)) ? Math.max(0, Number(fallback)) : 0;

  // 1. 跳转目标优先：音频可能还在加载/缓冲，报 currentTime 会把它拽回旧位置。
  const resumeValue = Number(resume);
  if (resume != null && Number.isFinite(resumeValue) && resumeValue >= 0) return resumeValue;

  // 2. 拖动中：播放器报的是拖动开始前的位置。
  if (pending) return safeFallback;

  // 3. 正常播放：取音频元素当前时间。暂停时它不一定被更新，见下。
  const current = Number(audio?.currentTime);
  if (!paused && Number.isFinite(current) && current >= 0) return current;

  // 4. 暂停 / 音频未就绪 / currentTime 非法。
  return safeFallback;
};

/**
 * 下一次 `progress` 包该在多久之后发。
 *
 * ★ 修的是「250ms 定时器被反复重建、几乎从不触发」这条（实测 50s 只发 2 个）：
 *   React 的 `setInterval` 一旦依赖里含 4Hz 的 `progress.cur`，就会被
 *   clearInterval + 重新创建，250ms 的间隔永远等不到。
 *
 * 改成**按帧自调度**（每次发完自己 setTimeout 下一次），就不再依赖 effect
 * 重建：只要组件还在，节奏就是稳定的。同时给出下限保护，
 * 避免某次卡顿后疯狂补发把 IPC 打爆。
 *
 * @param {object} options
 * @param {number} options.intervalMs 期望间隔（默认 250）
 * @param {number} options.elapsedMs 上一次推送到现在已经过去的毫秒数
 * @returns {number} 下一次应当等待的毫秒数（>= 0）
 */
export const nextLyricsProgressDelay = ({ intervalMs = 250, elapsedMs = 0 } = {}) => {
  const interval = Number.isFinite(Number(intervalMs)) ? Math.max(50, Number(intervalMs)) : 250;
  const elapsed = Number.isFinite(Number(elapsedMs)) ? Math.max(0, Number(elapsedMs)) : 0;
  // 已经超时（掉帧/后台节流）→ 立刻补一次，但仍留 16ms 让出主线程。
  if (elapsed >= interval) return 16;
  return interval - elapsed;
};

/**
 * 推送节奏的**最小间隔**：两次 IPC 之间至少隔这么久。
 *
 * 桌面歌词的填色是歌词窗侧按 rAF 自己外推的，不需要 60Hz 的 IPC。
 * 250ms 的锚点刷新已经足够压住漂移；更密只会白烧序列化与跨进程调用。
 */
export const LYRICS_PROGRESS_INTERVAL_MS = 250;

/**
 * 歌词窗侧「锚点单调保护」的容差（秒）。
 *
 * 新锚点比当前外推位置旧多少以内**不算倒退**？
 * 取 30ms：远小于一次 timeupdate（约 250ms），能挡住真实回退；
 * 又大于 IPC 抖动，不会把正常的小幅落后误判成倒退而冻结位置。
 */
export const LYRICS_ANCHOR_TOLERANCE_SECONDS = 0.03;
