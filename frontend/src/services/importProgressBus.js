// m3u 导入进度的广播总线（2026-11 全库扫描, P2-13 方案 C）。
//
// 为什么需要总线而不是把状态放进 Context:
//   · 导入任务的生命周期由**侧栏**发起（那里有"导入 m3u"菜单项）；
//   · 进度要显示在**歌单页顶部**（用户点完导入已被导航过去）；
//   · 这两处没有父子关系，塞进 Context 意味着为一次性的导入进度
//     给整棵树加一个会高频变化的 value —— 那就是 P1-2 刚拆掉的
//     "进度更新带动全树重渲染"的同一个坑。
//
// 所以沿用项目既有的做法（downloadBus / playlistBus）：浏览器原生事件，
// 不引入状态库，且订阅方按需挂载/卸载。
//
// 事件里传的是**完整快照**而不是增量：这样订阅方晚挂载（页面切换有 60ms 延迟）
// 也能靠后续一次广播拿到全量状态，不需要自己维护合并逻辑。

const EVENT = 'melodex:m3u-import-progress';

/**
 * 广播一份导入进度快照。
 *
 * @param {object|null} snapshot 进度快照（后端 m3uImportProgress 的形状）；
 *   传 null 表示"导入已结束/不再显示"，订阅方据此隐藏进度条。
 */
export const broadcastImportProgress = (snapshot) => {
  window.dispatchEvent(new CustomEvent(EVENT, { detail: snapshot }));
};

/**
 * 订阅导入进度。返回取消订阅函数（务必在组件卸载时调用）。
 *
 * ★ 注意：这里**不做** setTimeout 延迟派发。playlistBus 那样做是因为
 *   它要等目标组件挂载；进度是持续广播的，晚挂载的订阅方会在下一次
 *   （最多 1 秒后）轮询广播里拿到状态，不需要补齐机制。
 */
export const onImportProgress = (handler) => {
  const listener = (event) => handler(event.detail);
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
};
