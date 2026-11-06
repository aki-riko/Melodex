// 安卓返回键 / 浏览器后退的分层处理。
//
// 背景:这个项目此前**从没系统调优过**返回键 ——
//   · APK 侧:MainActivity 没有覆写返回键,Capacitor 8 核心也不转发,
//     于是物理返回键在任意页面都**直接退出 App**(不是先收一层界面再退出);
//   · Web 侧:只有「全屏播放页」自己 pushState 拦了一层,其余全部没有 ——
//     弹窗、抽屉、搜索建议、队列面板、睡眠定时面板按下返回键时,
//     要么直接退站/退 App,要么什么都没发生。
//
// 这里不重复造轮子去逐个组件改 pushState(那是原本的写法,而且每加一个弹层
// 就要记得补一处,必然漏)。改为一个**集中式返回栈**:
//
//   · 任何"盖住内容的层"打开时 push 一个 handler,关闭时按 id 移除自己;
//   · 返回键只问栈顶:LIFO,先收最上面那层,收完再按返回才继续往下;
//   · 栈空时才走系统默认行为(浏览器后退 / 退出 App)。
//
// 关键设计约束(都是踩过或容易踩的):
//   1. **同一层重复 push 必须幂等**:React StrictMode 会双跑 effect,
//      不幂等会一次返回收两层,用户看到"弹窗一跳就退站"。
//   2. **关闭必须按 id 精确移除**,不能写 `pop()` —— 用户可以先点遮罩关掉
//      中间某层而留上层开着,这时候 pop() 会删错人。
//   3. **不可 dismiss 的层**(例如必须选一个的确认框)永远挡住返回:
//      栈顶不可关闭时返回键应当**什么都不做**,而不是穿透去关下一层或退站。
//   4. **onBack 返回 false = "我这次不认"**(比如内部还有子状态没退完),
//      此时交给下层继续问;返回 true/undefined 视为已消费。
//
// 纯逻辑,无 DOM 依赖 —— 浏览器/systemBack 接线在 backNavigation.js,
// 这样本模块可以被 Node 契约测试完整覆盖。

export const createBackLayerStack = () => {
  // 数组天然保持插入顺序;按 id 精确删除,避免"删错人"。
  const layers = [];
  const listeners = new Set();
  let seq = 0;

  const notify = () => {
    listeners.forEach((listener) => {
      try {
        listener(layers.length);
      } catch {
        // 订阅者异常不能影响返回栈本身的状态推进。
      }
    });
  };

  const removeById = (id) => {
    const index = layers.findIndex((item) => item.id === id);
    if (index < 0) return false;
    layers.splice(index, 1);
    notify();
    return true;
  };

  return {
    /**
     * 压入一层。返回稳定 id,用于移除。
     * 同 id 重复压入是**替换**而不是新增(React 重渲染会给出新闭包)。
     * 替换不改变层数,因此不触发订阅通知。
     */
    push({ id, onBack, dismissable = true, name = '' } = {}) {
      const key = id || `back-layer-${++seq}`;
      const entry = { id: key, onBack, dismissable: Boolean(dismissable), name };
      const existing = layers.findIndex((item) => item.id === key);
      if (existing >= 0) {
        layers[existing] = entry;
        return key;
      }
      layers.push(entry);
      notify();
      return key;
    },

    /** 按 id 移除自己。不在栈里时静默返回(重复移除是正常流程)。 */
    remove: removeById,

    /** 栈顶(最近打开的那层),空栈返回 null。 */
    top() {
      return layers.length ? layers[layers.length - 1] : null;
    },

    size() {
      return layers.length;
    },

    /** 订阅层数变化(用于重新上膛历史哨兵)。返回退订函数。 */
    subscribe(listener) {
      if (typeof listener !== 'function') return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    /** 仅供测试/调试:导出当前层快照。 */
    snapshot() {
      return layers.map(({ id, dismissable, name }) => ({ id, dismissable, name }));
    },

    /**
     * 处理一次返回。
     * @returns {'handled'|'blocked'|'passthrough'}
     *   handled     → 某一层消费了返回(已关闭或内部退了一步)
     *   blocked     → 栈顶不可关闭:调用方必须吞掉这次返回,不能退站/退 App
     *   passthrough → 栈空或各层都不认:调用方走系统默认
     */
    handleBack() {
      // 从栈顶往下问,找到第一个愿意消费的层。
      for (let i = layers.length - 1; i >= 0; i -= 1) {
        const layer = layers[i];
        // 不可关闭的层**不调用** onBack:它本来就不允许被返回键收掉,
        // 而 onBack 的语义就是"关闭/退一步"。若照样调用,Dialog 的
        // onBack(=> onClose()) 会把这个本应挡住的弹窗关掉。
        // 直接判 blocked,调用方吞掉这次返回。
        if (!layer.dismissable) return 'blocked';
        const consumed = layer.onBack?.();
        if (consumed === false) continue; // 这层不认,继续问下面
        // 消费了:摘掉它(它的 effect 清理时再 remove 也是幂等的)。
        layers.splice(i, 1);
        notify();
        return 'handled';
      }
      return 'passthrough';
    },
  };
};

/** 全局单例。UI 层与安卓桥都指向这一份,测试用上面的工厂另建。 */
export const backLayerStack = createBackLayerStack();
