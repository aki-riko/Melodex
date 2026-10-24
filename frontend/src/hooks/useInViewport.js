import { useCallback, useEffect, useRef, useState } from 'react';

// 视口可见性探针。
//
// 为什么需要:每个歌曲行挂载后各自要查「是否已缓存到本机」(IndexedDB)与「是否已收藏」
// (走 /music/favorites/status_batch 合批接口)。已下载页实测 600+ 首、最近播放封顶 500 首,
// 一次性全量挂载等于上千次查询 —— 用户只看到第一屏,却把所有行的状态都问了一遍。
// 用 IntersectionObserver 把这两类查询推迟到「行快到视口」时再做。
//
// 语义:
//  · rootMargin 默认提前一屏('200px'),滚动时不会先看到空徽章再闪出来;
//  · once 默认 true —— 进入过视口就永久保持 true,避免来回滚动时反复触发查询与请求;
//  · 老浏览器 / 测试环境没有 IntersectionObserver 时直接返回 true(退化成旧行为),
//    绝不能因为缺少检测能力就让「收藏」「本机」徽章失效。
//
// 用法:
//   const [rowRef, inView] = useInViewport();
//   <div ref={rowRef} />
//   useEffect(() => { if (!inView) return; /* 查状态 */ }, [inView, ...]);
export const IN_VIEWPORT_MARGIN = '200px';

const supportsIntersectionObserver = () =>
  typeof window !== 'undefined' && typeof window.IntersectionObserver === 'function';

export function useInViewport({ rootMargin = IN_VIEWPORT_MARGIN, threshold = 0, once = true } = {}) {
  const supportedRef = useRef(null);
  if (supportedRef.current === null) supportedRef.current = supportsIntersectionObserver();
  const supported = supportedRef.current;

  // 不支持时初始就是 true,避免首帧先渲染成"未加载"再闪一下。
  const [inView, setInView] = useState(() => !supported);
  const seenRef = useRef(!supported);
  const [node, setNode] = useState(null);

  // 用 callback ref:行元素挂载/卸载都能感知,而且引用稳定,
  // 不会因为父组件重渲染就反复 disconnect/observe。同一个元素不重复 setState,
  // 免得每行多一次无意义的重渲染。
  const ref = useCallback((element) => {
    setNode((prev) => (prev === (element || null) ? prev : (element || null)));
  }, []);

  useEffect(() => {
    if (!supported || !node) return undefined;
    if (once && seenRef.current) return undefined;

    let observer = null;
    const markInView = () => {
      seenRef.current = true;
      setInView(true);
    };

    // 主滚动区是 #app-main(overflow-y-auto),不是文档本身。以它作 root 时 rootMargin
    // 才能真正提前一屏预取;拿不到它(或行不在其中,如某些全屏浮层)就退回 viewport 语义。
    const scroller = typeof document !== 'undefined' ? document.getElementById('app-main') : null;
    const root = scroller && scroller.contains(node) ? scroller : null;

    try {
      observer = new window.IntersectionObserver((entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          markInView();
          if (once && observer) observer.disconnect();
          return;
        }
        if (!once) setInView(false);
      }, { root, rootMargin, threshold });
      observer.observe(node);
    } catch {
      // rootMargin 非法 / 构造被拒:宁可当作可见(照旧查询),也不能让徽章永远不出现。
      markInView();
      return undefined;
    }

    return () => {
      if (observer) observer.disconnect();
    };
  }, [node, once, rootMargin, supported, threshold]);

  return [ref, supported ? inView : true];
}

export default useInViewport;
