// 页面级「返回上一页」的深度记录。
//
// 背景:底部导航是哈希路由,每次切页都是一次真实的历史前进。但返回键
// 起初只认浮层栈,完全不知道"页面"这件事,于是在 #more 这类子页按返回会
// 直接退出 App。
//
// 第一版修法很粗暴:只要不在首页就 `navigate('Home')` —— 结果是
// **从歌单点进去按返回,不管来路一律掉回首页**,也就是用户报的这个问题。
// 真正的"上一页"必须沿历史栈回去,而不是猜一个固定目标。
//
// 所以这里给每条站内历史打上深度标记,借此回答两个问题:
//   1. 当前这一页之前,还有没有**站内**的上一页?(有才后退,没有才退出)
//   2. 后退一步会回到哪一页?(交给浏览器,不自己算)
//
// 为什么不用 `window.history.length`:它包含跳转前的外部站点与重定向,
// 在外壳加载远端站的 APK 里几乎永远 > 1,拿它判断必然误判成"还能退"。

export const ROUTE_DEPTH_KEY = 'melodexRouteDepth';

export const readRouteDepth = (history = globalThis.history) => {
  const raw = history?.state?.[ROUTE_DEPTH_KEY];
  const depth = Number(raw);
  return Number.isFinite(depth) && depth > 0 ? depth : 0;
};

/**
 * 站内前进一页:写入带深度标记的历史条目。
 * 用 pushState 而不是 `location.hash =` —— 后者无法携带 state,
 * 而我们要靠 state 判断"这一步是站内第几层"。
 *
 * @returns 新的深度(>=1)
 */
export const pushRouteEntry = (
  targetHash,
  { history = globalThis.history, location = globalThis.location } = {},
) => {
  const depth = readRouteDepth(history) + 1;
  const hash = String(targetHash || '').replace(/^#/, '');
  // 第三个参数给完整 URL,保留当前 origin/path/query,只换 hash。
  history.pushState({ [ROUTE_DEPTH_KEY]: depth }, '', `#${hash}`);
  return depth;
};

/**
 * 当前是否还有站内上一页可以退。
 * 深度 0 = 本次会话的入口页(深链接直达也属于这种),此时后退会离开应用。
 */
export const canGoBackInApp = (history = globalThis.history) => readRouteDepth(history) > 0;

/**
 * 沿历史后退一页。返回是否真的发起了后退。
 * 只有确实存在站内上一页时才 back(),否则交给调用方决定退出。
 */
export const goBackInApp = (history = globalThis.history) => {
  if (!canGoBackInApp(history)) return false;
  history.back();
  return true;
};
