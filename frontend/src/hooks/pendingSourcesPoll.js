/**
 * 慢源补齐的「自动补拉」控制器 —— 纯逻辑,不依赖 React / 浏览器。
 *
 * 为什么单独抽出来:这里出过一个**只有运行时才看得见**的 bug(2026-11-27 用户报
 * 「提示说结果会自动刷新,实际上并没有刷新」),静态断言完全抓不到。
 *
 * 事故复盘(生产日志为证,关键词「爱乐之城」):
 *   20:11:57  前台返回 2.5s,pending=[qq kugou migu qianqian],界面显示"还有 4 个源"
 *   20:12:22  25 秒后补拉一次(命中缓存,但缓存里 pending 仍是那 4 个)
 *   之后      **再也没有任何搜索请求** —— 补拉只跑了一圈就停住了
 *   20:14:32  后台补齐其实成功了(60 首写进缓存),但前端早已不再来取
 *
 * 旧实现把"下一轮"寄托在 React effect 的依赖 `[pendingSourcesKey]` 上:
 * 补拉回来的 pending_sources 与上一轮**一模一样**(后台还没跑完),key 不变 →
 * effect 不重跑 → 计时器再也不会被安排。于是"每 25 秒一次"实际只发生了一次。
 *
 * 现在由控制器**自己**在计时器触发后重新武装,不再依赖外部 state 变化。
 */

// 实测:后台补齐任务受 MUSIC_DL_SEARCH_BACKGROUND_CONCURRENCY(默认 1)限流,
// song / lyric / album 三条链路是**排队**跑的,不是并行。2026-11-27 那次实测:
// lyric 跑了 2m0s, song 排到它后面才起跑, 再花 35.4s —— 合计约 2.5 分钟。
// 6 次 × 25s = 150s 正好卡在这个边界上,差几秒就永远等不到。给到 300s 留出余量。
export const PENDING_REFETCH_DELAY_MS = 25000;
export const PENDING_REFETCH_MAX = 12;

/**
 * @param {object} options
 * @param {() => void} options.refetch 触发一次补拉(由调用方去调 react-query 的 refetch)
 * @param {number} [options.delayMs]
 * @param {number} [options.max]
 * @param {(fn: () => void, ms: number) => any} [options.setTimeoutFn] 便于测试注入假计时器
 * @param {(id: any) => void} [options.clearTimeoutFn]
 */
export const createPendingSourcesPoller = ({
  refetch,
  delayMs = PENDING_REFETCH_DELAY_MS,
  max = PENDING_REFETCH_MAX,
  setTimeoutFn = (fn, ms) => window.setTimeout(fn, ms),
  clearTimeoutFn = (id) => window.clearTimeout(id),
} = {}) => {
  let timer = null;
  let attempts = 0;
  let identity = '';
  let pendingKey = '';

  const stop = () => {
    if (timer !== null) {
      clearTimeoutFn(timer);
      timer = null;
    }
  };

  // arm 只负责"安排**下一次**", 到点后由回调自己再调一次 arm 续上。
  const arm = () => {
    stop();
    if (!pendingKey) return;
    if (attempts >= max) return;
    timer = setTimeoutFn(() => {
      timer = null;
      attempts += 1;
      try {
        refetch?.();
      } finally {
        // ★ 核心:不管 refetch 成功失败都要续上下一轮,
        //   否则一次网络抖动就把整条补齐链路永久掐断。
        //   次数上限由 attempts >= max 兜住,不会无限重试。
        arm();
      }
    }, delayMs);
  };

  return {
    /**
     * 每次拿到新数据时调用(幂等:身份与名单都没变就什么都不做)。
     *
     * @param {{identity?: string, pendingKey?: string}} next
     *   identity   —— 当前搜索的身份(query + 重搜 nonce),换搜索/重搜时用于清零次数
     *   pendingKey —— 后端报出的待补齐源(逗号拼接),空串表示已经齐了
     */
    update(next) {
      if (!next) return;
      const nextIdentity = next.identity ?? '';
      const nextPending = next.pendingKey ?? '';
      const identityChanged = nextIdentity !== identity;
      const pendingChanged = nextPending !== pendingKey;
      if (!identityChanged && !pendingChanged) return;

      identity = nextIdentity;
      pendingKey = nextPending;

      if (!pendingKey) {
        // 补完了(或这一轮压根没有慢源):收工并清零,下一次搜索从头计数。
        attempts = 0;
        stop();
        return;
      }
      if (identityChanged) {
        // 换了搜索(含同一个词重搜)= 一批新的慢源, 次数必须清零。
        attempts = 0;
      } else if (pendingChanged) {
        // 名单变了说明后台有了进展(某些源回来了), 重新给满次数。
        attempts = 0;
      }
      arm();
    },
    stop,
    get attempts() { return attempts; },
    get identity() { return identity; },
    get pendingKey() { return pendingKey; },
    get armed() { return timer !== null; },
  };
};
