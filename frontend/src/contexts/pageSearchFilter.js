// 顶部全局搜索框的"当前页面过滤"契约。
//
// ## 问题
// TopBar 原来只有一条路：输入 → 跳到「找歌」做全网搜索。于是在「我的歌单」里想找
// 这张歌单里的某首歌时，会被整页带走 —— 用户原话：「其他页面的搜索不应该是这样的，
// 应该对应当前歌单的搜索才对」。
//
// ## 约定
// 页面若想让顶部搜索筛自己，就调用 `useRegisterPageSearchFilter(...)` 注册一个描述:
//     { placeholder?, count?, total?, onSearch(keyword) }
// TopBar 看到注册项时：
//   · 输入 → 立即调用 onSearch(keyword)（页面自己做本地过滤，不发请求）；
//   · 回车 / 点主建议 = 只筛本页（不会把人带走）；
//   · 下拉底部保留一个显式的「全网搜『xx』」次要入口，能力不丢。
//
// ## 为什么用 context 而不是 prop 透传
// TopBar 挂在 AppShell 上，页面组件在 <main> 里隔了几层；一路透传会污染
// Sidebar/Suspense 的边界。页面挂载/卸载即注册/注销，语义最清楚。
//
// ## 稳定引用
// 注册值必须稳定，否则每次父级渲染都会 setState → 再渲染，形成抖动。
// 所以这里用 ref 持有最新 descriptor，只把**稳定的**包装对象放进 state；
// 实时数据（count/placeholder）在 TopBar 里通过 readLive() 现取。

import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';

const PageSearchFilterContext = createContext(null);

const EMPTY = {
  active: false,
  placeholder: '',
  count: 0,
  total: 0,
  onSearch: null,
  readLive: () => null,
};

export function PageSearchFilterProvider({ children }) {
  // registered 里只放**稳定**的包装对象；实时字段由 readLive 现取。
  const [registered, setRegistered] = useState(null);
  const value = useMemo(() => {
    if (!registered) return EMPTY;
    return {
      active: true,
      onSearch: registered.onSearch,
      readLive: registered.readLive,
      // 下面两个是"注册那一刻"的快照，TopBar 优先用 readLive 拿实时值
      placeholder: registered.placeholder,
      count: registered.count,
      total: registered.total,
    };
  }, [registered]);
  return (
    <PageSearchFilterContext.Provider value={{ value, setRegistered }}>
      {children}
    </PageSearchFilterContext.Provider>
  );
}

/** TopBar 用：当前页面的过滤器描述（没有注册时返回 EMPTY）。 */
export function usePageSearchFilter() {
  const context = useContext(PageSearchFilterContext);
  return context?.value || EMPTY;
}

/**
 * 页面用：把「本地过滤」注册给顶部搜索框。
 *
 * @param {object|null} descriptor
 *   { placeholder?: string, count?: number, total?: number, onSearch: (kw: string) => void }
 *   传 null 表示当前页面不支持本地过滤（此时顶部搜索退回全网搜索）。
 *
 * ★ onSearch 建议包 useCallback；即便不包也不会造成注册抖动（见文件头"稳定引用"）。
 */
export function useRegisterPageSearchFilter(descriptor) {
  const context = useContext(PageSearchFilterContext);
  const setRegistered = context?.setRegistered;
  const enabled = Boolean(descriptor && typeof descriptor.onSearch === 'function');

  const liveRef = useRef(descriptor);
  liveRef.current = descriptor;

  const stable = useMemo(() => {
    if (!enabled) return null;
    return {
      placeholder: '',
      count: 0,
      total: 0,
      onSearch: (keyword) => liveRef.current?.onSearch?.(keyword),
      readLive: () => liveRef.current || null,
    };
    // enabled 只在"有没有过滤器"切换时变，descriptor 的内容变化不重注册。
  }, [enabled]);

  useEffect(() => {
    if (!setRegistered) return undefined;
    setRegistered(stable);
    return () => setRegistered((current) => (current === stable ? null : current));
  }, [setRegistered, stable]);
}

export default PageSearchFilterContext;
