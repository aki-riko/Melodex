import { useEffect, useRef } from 'react';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { backLayerStack } from './backLayers.js';

// 「回到上一层」的系统接线。两条通道都指向同一个 backLayerStack:
//
//   1. **浏览器 / PWA**:history.pushState 压一条哨兵 + 监听 popstate。
//   2. **安卓 APK**:物理返回键不产生 popstate。原生 SystemBackPlugin 用
//      OnBackPressedCallback 接管按键,再派发 DOM 事件 `melodex:systemback`。
//      事件若被 preventDefault() → 视为已消费;否则原生 moveTaskToBack。
//
// 为什么原生侧走 DOM 事件而不是 Capacitor notifyListeners:
//   notifyListeners 需要 JS 先 addListener 建立回调通道,冷启动或 JS 尚未
//   挂好监听时会静默丢失 —— 而返回键被吞掉比直接退出更糟(用户会觉得按了没反应)。
//   DOM 事件由页面自己 preventDefault(),没有"监听还没就绪"的窗口期。

export const SystemBack = registerPlugin('SystemBack');

export const isNativeAndroid = (capacitor = Capacitor) => Boolean(
  capacitor?.isNativePlatform?.() && capacitor?.getPlatform?.() === 'android',
);

export const BACK_SENTINEL = 'melodexBackLayer';

export const sentinelState = () => ({ [BACK_SENTINEL]: true });

/** 原生派发给页面的返回键事件名。与 SystemBackPlugin.kt 中的字符串必须一致。 */
export const SYSTEM_BACK_EVENT = 'melodex:systemback';

/**
 * 纯逻辑的历史守卫,注入 history 便于 Node 契约测试。
 *
 * ---- 常备单哨兵策略 ----
 * 为什么是"始终只留一条"而不是"每层压一条":
 *   · 每层压一条时,用户点遮罩关掉中间某层,历史里就残留一条哨兵,
 *     必须主动 back() 清理;而那次 back 又会触发 popstate,
 *     需要额外的"忽略下一次"标志,极易串成一收两层或直接退站。
 *   · 常备单哨兵:只要栈里还有层就保持一条哨兵。返回键先被它吃掉,
 *     若栈非空就**重新上膛**,于是连按多少次返回都只收层、不退站;
 *     栈空时不再上膛,下一次返回才真正离开页面。
 */
export const createHistoryBackGuard = ({
  history = globalThis.history,
  location = globalThis.location,
  onBack = () => 'passthrough',
  hasLayers = () => false,
  onSync,
  onRouteBack = () => false,
} = {}) => {
  let armed = false;
  let ignoreNextPop = false;
  // 主动 back() 回收哨兵时,浏览器可能延迟到下一帧才派发 popstate。
  // 用计数而不是布尔,避免"回收 → 立刻又上膛"时把上膛后的那次真实 pop 吞掉。
  let pendingIgnore = 0;

  const arm = () => {
    if (armed || !history?.pushState) return;
    history.pushState(sentinelState(), '', location?.href);
    armed = true;
  };

  const disarm = () => {
    if (!armed) return;
    armed = false;
    pendingIgnore += 1;
    history.back();
  };

  return {
    /** 层数变化后调用:有层则确保上膛,无层则回收哨兵。 */
    sync() {
      const before = armed;
      if (hasLayers()) arm();
      else disarm();
      if (before !== armed) onSync?.(armed);
    },

    /** popstate 处理。返回 true 表示这次返回已被消费。 */
    handlePop() {
      if (pendingIgnore > 0) {
        pendingIgnore -= 1;
        return false;
      }
      if (!armed) return false;
      armed = false;
      const result = onBack();
      if (result === 'handled' || result === 'blocked') {
        // 消费了:若还有层就重新上膛,保护下一次返回。
        if (hasLayers()) arm();
        return true;
      }
      // 浮层已清空:交给路由层 —— 不在首页就回首页(这同样算消费)。
      if (onRouteBack()) {
        if (hasLayers()) arm();
        return true;
      }
      return false;
    },

    isArmed: () => armed,
    isIgnoring: () => pendingIgnore > 0,
  };
};

// ---- 路由层的返回:由 AppShell 注册"当前是否还可以回上一页" ----

let routeBackResolver = () => false;

/**
 * 注册「没有浮层时,返回键该不该回上一页」。
 * AppShell 挂载时注册,返回 true 表示会把用户带回首页。
 */
export const setRouteBackResolver = (resolver) => {
  routeBackResolver = typeof resolver === 'function' ? resolver : () => false;
  return () => { routeBackResolver = () => false; };
};

// ---- 安卓原生桥 ----

let nativeBridgeBound = false;

/**
 * 把原生返回键接到返回栈。只订阅一次(全局)。
 * 由页面 preventDefault 表达"我消费了",原生据此决定是否退到后台。
 *
 * 处理顺序(与视觉层级一致,先上后下):
 *   1. 浮层(弹窗/抽屉/菜单/播放页)按 LIFO 收;
 *   2. 浮层全收完后,若当前不在首页 → 回首页;
 *   3. 已经在首页 → 交回原生 moveTaskToBack。
 *
 * 为什么第 2 步必须有:哈希路由是**页面**切换,但原生桥不知道这件事。
 * 真机实测过,少了这一步在「更多」页按返回会直接退到桌面 —— 用户眼里就是
 * "我只是想回上一页,App 却没了"。
 */
export const bindNativeBackBridge = (target = globalThis.window) => {
  if (nativeBridgeBound || !target?.addEventListener) return () => {};
  nativeBridgeBound = true;

  const onSystemBack = (event) => {
    const result = backLayerStack.handleBack();
    if (result !== 'passthrough') {
      event.preventDefault();
      return;
    }
    // 浮层已清空:看看是不是还在某个子页面。
    if (routeBackResolver()) {
      event.preventDefault();
      return;
    }
    // 已经是首页,什么都不做 —— 让原生 moveTaskToBack。
  };

  target.addEventListener(SYSTEM_BACK_EVENT, onSystemBack);
  return () => {
    nativeBridgeBound = false;
    target.removeEventListener(SYSTEM_BACK_EVENT, onSystemBack);
  };
};

/**
 * 把某一层挂进返回栈。组件内使用:
 *
 *   useBackLayer({ active: open, onBack: () => setOpen(false), name: 'dialog' });
 *
 * active 变 true 时入栈,变 false 时按 id 精确移除自己;
 * onBack 返回 false 表示"这次不认,交给下层"。
 */
export const useBackLayer = ({ active, onBack, dismissable = true, id, name = '' } = {}) => {
  const handlerRef = useRef(onBack);
  useEffect(() => { handlerRef.current = onBack; }, [onBack]);

  useEffect(() => {
    if (!active) return undefined;
    const key = backLayerStack.push({
      id,
      dismissable,
      name,
      onBack: () => handlerRef.current?.(),
    });
    return () => { backLayerStack.remove(key); };
  }, [active, dismissable, id, name]);
};

/**
 * 应用根部挂一次:负责浏览器 popstate 与安卓原生事件。
 */
export const useBackNavigation = () => {
  const guardRef = useRef(null);

  useEffect(() => {
    const guard = createHistoryBackGuard({
      onBack: () => backLayerStack.handleBack(),
      hasLayers: () => backLayerStack.size() > 0,
      // 浮层清空后,交给路由层决定是否回上一个页面。
      onRouteBack: () => routeBackResolver(),
    });
    guardRef.current = guard;

    // 层数一变就同步哨兵:开第一层时上膛,全部关完后回收。
    const unsubscribe = backLayerStack.subscribe(() => guard.sync());
    // 挂载时可能已有层(例如恢复出来的状态),补一次同步。
    guard.sync();

    const onPop = () => guard.handlePop();
    window.addEventListener('popstate', onPop);
    const unbindNative = bindNativeBackBridge();

    return () => {
      window.removeEventListener('popstate', onPop);
      unsubscribe();
      unbindNative();
      guardRef.current = null;
    };
  }, []);

  return guardRef;
};
