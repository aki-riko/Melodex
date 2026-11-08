import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Volume1, Volume2, VolumeX } from 'lucide-react';
import { useBackLayer } from '../contexts/backNavigation.js';
import {
  VOLUME_HOVER_CLOSE_DELAY_MS,
  VOLUME_HOVER_OPEN_DELAY_MS,
  VOLUME_SLIDER_STEP,
  VOLUME_WHEEL_STEP,
  VOLUME_WHEEL_UNIT,
  clampVolume,
  formatVolumePercent,
  normalizeWheelDelta,
  volumeAfterSteps,
  volumeIconTier,
  wheelVolumeSteps,
} from '../contexts/playerVolumeControl.js';

// 音量控件:喇叭按钮 + 悬停弹出的**垂直**长条 + 滚轮微调。
//
// 为什么不再用原来那根水平条:它被塞在播放条右侧 120~130px 的固定宽度里,
// 每像素约 0.8% 音量 —— 要调 5% 得把鼠标挪 6px,中低音量段根本停不住,
// 用户的实际感受就是「要么大要么小」。垂直条有 128px 有效行程,
// 每像素约 0.78%…并没有变,但**起点变长了 3 倍以上**且配合滚轮可以做
// 5%/格的确定性微调,不依赖鼠标精度。
//
// 三项必须注意的实现细节(都已验证,改之前先读):
//
// ① **滚轮必须用原生 addEventListener 且 passive:false**。
//    React 17+ 把 wheel 监听挂在 root 容器上并且**默认 passive**
//    (react-dom.development.js 里 `domEventName === 'wheel'` 直接置 true),
//    所以在 onWheel 里调 preventDefault() 是无效的 —— 页面会一边调音量一边滚动。
//    只有原生监听才能阻止默认滚动。
//
// ② **点击触发器和悬停共用同一个按钮,但语义不同**:
//    点击 = 静音切换(保持用户原有的肌肉记忆),悬停 = 弹出面板。
//    面板打开期间指针在面板上,离开"按钮+面板"的整体区域才收起。
//
// ③ **收起延时必须 ≥ 面板间距的跨越时间**。触发器与面板之间若留 gap,
//    鼠标横穿 gap 时会触发 pointerleave → 面板消失 → 永远到不了滑块。
//    这里用 padding 而不是 margin 造视觉间距,保证 gap 本身也在 hover 区内。
const triggerIconFor = (tier, size) => {
  if (tier === 'muted') return <VolumeX size={size} />;
  if (tier === 'low') return <Volume1 size={size} />;
  return <Volume2 size={size} />;
};

/**
 * @param {object} props
 * @param {number} props.volume 当前音量 0~1(未静音时的用户音量)
 * @param {boolean} props.muted 是否静音
 * @param {(v:number)=>void} props.onVolumeChange 拖动/滚轮改变音量
 * @param {()=>void} props.onToggleMute 点击图标:静音切换
 * @param {number} [props.iconSize] 图标尺寸
 * @param {string} [props.className] 触发器额外类名
 * @param {boolean} [props.openUp] 面板向上弹(默认 true)。两个调用点(底部播放条、
 *   全屏播放页底部控制行)都贴着屏幕底边,向下弹会直接出屏 —— 这是本组件最容易
 *   踩的一处,所以默认值就取安全的那一侧。
 */
const VolumeControl = ({
  volume,
  muted,
  onVolumeChange,
  onToggleMute,
  iconSize = 18,
  className = '',
  openUp = true,
}) => {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const openTimerRef = useRef(null);
  const closeTimerRef = useRef(null);
  // 滚轮余量按"控件实例"保存,避免跨实例串味。
  const wheelRestRef = useRef(0);
  // 滚轮回调里要读到最新音量,而原生监听只绑定一次 —— 用 ref 免得重挂。
  const volumeRef = useRef(volume);
  const onChangeRef = useRef(onVolumeChange);

  useEffect(() => { volumeRef.current = volume; }, [volume]);
  useEffect(() => { onChangeRef.current = onVolumeChange; }, [onVolumeChange]);

  const clearTimers = useCallback(() => {
    if (openTimerRef.current != null) {
      globalThis.clearTimeout(openTimerRef.current);
      openTimerRef.current = null;
    }
    if (closeTimerRef.current != null) {
      globalThis.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);

  useEffect(() => clearTimers, [clearTimers]);

  // 安卓返回键 / 浏览器后退:先收面板,而不是退站。
  useBackLayer({
    active: open,
    name: 'volume-panel',
    onBack: () => { setOpen(false); },
  });

  const scheduleOpen = useCallback(() => {
    clearTimers();
    openTimerRef.current = globalThis.setTimeout(() => {
      openTimerRef.current = null;
      setOpen(true);
    }, VOLUME_HOVER_OPEN_DELAY_MS);
  }, [clearTimers]);

  const scheduleClose = useCallback(() => {
    clearTimers();
    closeTimerRef.current = globalThis.setTimeout(() => {
      closeTimerRef.current = null;
      setOpen(false);
    }, VOLUME_HOVER_CLOSE_DELAY_MS);
  }, [clearTimers]);

  // 键盘可达性:只靠悬停的话,纯键盘用户永远打不开面板。
  //
  // ⚠ 只能对**键盘聚焦**开放,不能对所有 focus 开放:
  //   鼠标点击喇叭也会让按钮获得焦点,若无条件 setOpen(true),用户点一下静音
  //   面板就跟着弹出来 —— 而此刻他根本没想调音量。
  //   :focus-visible 正是浏览器用来区分"键盘聚焦 / 鼠标聚焦"的标准判据。
  const handleFocus = useCallback((event) => {
    if (!event.target.matches?.(':focus-visible')) return;
    clearTimers();
    setOpen(true);
  }, [clearTimers]);

  const handleBlur = useCallback(() => {
    // 用下一帧的 activeElement 判断,而不是 event.relatedTarget:
    // 某些浏览器(尤其拖动滑块后松开)会把 relatedTarget 置空,照它判断会误关面板。
    // 定时器必须自己登记——组件卸载后回调仍会跑,那时 rootRef 已空。
    clearTimers();
    closeTimerRef.current = globalThis.setTimeout(() => {
      closeTimerRef.current = null;
      const active = globalThis.document?.activeElement;
      if (active && rootRef.current?.contains(active)) return;
      setOpen(false);
    }, 0);
  }, [clearTimers]);

  // Esc 收起(与 ui/Menu、SleepTimerControl 的行为保持一致)。
  // 不用 document 级监听:面板是通过键盘/悬停打开的,滚动页面时不该被劫持。
  const handlePanelKeyDown = useCallback((event) => {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    setOpen(false);
  }, []);

  // ---- ① 滚轮:原生非被动监听 ----
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;

    const onWheel = (event) => {
      // 面板没开时不拦页面滚动 —— 否则鼠标划过播放条就把页面滚不动了。
      if (!open) return;
      event.preventDefault();
      const delta = normalizeWheelDelta(event.deltaY, event.deltaMode);
      if (delta === 0) return;
      const { steps, rest } = wheelVolumeSteps(wheelRestRef.current, delta, {
        unit: VOLUME_WHEEL_UNIT,
      });
      wheelRestRef.current = rest;
      if (steps === 0) return;
      // 向上滚(deltaY<0)应增大音量,故取反。
      const next = volumeAfterSteps(volumeRef.current, -steps, VOLUME_WHEEL_STEP);
      if (next === clampVolume(volumeRef.current)) return;
      volumeRef.current = next;
      onChangeRef.current?.(next);
    };

    // 必须 passive:false,见文件头 ①。
    root.addEventListener('wheel', onWheel, { passive: false });
    return () => root.removeEventListener('wheel', onWheel);
  }, [open]);

  const effectiveVolume = muted ? 0 : clampVolume(volume);
  const tier = volumeIconTier(effectiveVolume);
  const percentText = formatVolumePercent(effectiveVolume);

  return (
    <div
      ref={rootRef}
      className={`relative flex-shrink-0 ${className}`}
      onPointerEnter={scheduleOpen}
      onPointerLeave={scheduleClose}
      onFocus={handleFocus}
      onBlur={handleBlur}
    >
      <button
        type="button"
        onClick={onToggleMute}
        // 44×44 是仓库里图标按钮的通行尺寸(见播放条其它按钮),也是触控下限。
        // 尺寸写死在这里不是形式主义:相邻的「播放队列」按钮同样是 44×44,
        // 两者盒高一致才能保证图标中心落在同一条基线上 —— 之前这里没有尺寸,
        // 盒子只有图标那么高(18px),与旁边的 44px 盒子错开 2px,
        // 肉眼看就是「喇叭比队列图标高一点点」。
        className="flex h-11 w-11 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
        title={muted ? '取消静音' : '静音'}
        aria-label={muted ? '取消静音' : '静音'}
        aria-expanded={open}
        aria-haspopup="dialog"
      >
        {triggerIconFor(tier, iconSize)}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="音量调节"
          onKeyDown={handlePanelKeyDown}
          className={`absolute left-1/2 z-popover w-16 -translate-x-1/2 ${openUp ? 'bottom-full pb-2' : 'top-full pt-2'}`}
        >
          {/* 间距靠外层 padding 实现,保证 gap 也在 hover 区内(见文件头 ③) */}
          <div className="flex flex-col items-center gap-2 rounded-lg border border-border px-2 py-3 surface-acrylic fluent-flyout-in">
            <span className="type-micro text-muted-foreground tabular-nums" aria-hidden="true">{percentText}</span>
            <input
              type="range"
              min={0}
              max={1}
              step={VOLUME_SLIDER_STEP}
              value={effectiveVolume}
              onChange={(e) => onVolumeChange(Number(e.target.value))}
              className="volume-slider-vertical accent-primary cursor-pointer"
              aria-label="音量"
              aria-valuetext={percentText}
            />
          </div>
        </div>
      )}
    </div>
  );
};

export default VolumeControl;
