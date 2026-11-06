import React, { useEffect, useRef, useState } from 'react';
import { Clock, Menu, X } from 'lucide-react';
import { SLEEP_TIMER_PRESETS_MINUTES, formatSleepTimerRemaining } from '../contexts/playerSleepTimer.js';

const panelAlignClass = {
  left: 'left-0',
  center: 'left-1/2 -translate-x-1/2',
  right: 'right-0',
};

// 睡眠定时面板。
//
// ⚠ 这里曾经有一个把功能整个废掉的事故(2026-10 的 z-index 语义化 sweep 引入):
// 面板原本是「透明全屏遮罩 + 一个浮层」两层,遮罩用 z-[80]、面板用 z-[90]。
// sweep 把这两个魔法数字换成语义层时换成了 backdrop=z-drawer(60)、panel=z-popover(50),
// **顺序被弄反了** —— 遮罩压在面板之上。视觉上面板照常显示(它只在播放条这个
// 层叠上下文里),但用户点到面板的每一下其实都点在透明遮罩上:
// 遮罩的 onClick 只做 setOpen(false),于是「选 30 分钟」表现为"面板一闪就没了,
// 定时根本没设上",连「播完本首再停」的开关都点不动 —— 用户看到的就是「自动停止失效」。
//
// 现在不再自己造遮罩:改用 ui/Menu 同款的「document 监听 + outside click / Esc」,
// 从根上消掉这类"两层 z-index 谁高"的顺序问题。
// 若将来要加回遮罩,必须保证 backdrop 的 z 值 ≤ 面板的 z 值(见 uxGuards 的 popover-backdrop-order 门禁)。
const SleepTimerControl = ({
  active,
  pendingEndOfTrack,
  remainingMs,
  stopAfterTrack,
  onStopAfterTrackChange,
  onStart,
  onCancel,
  align = 'right',
  className = '',
  variant = 'default',
  extraActions = [],
}) => {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const remainingText = formatSleepTimerRemaining(remainingMs);
  const stateLabel = pendingEndOfTrack ? '播完停' : remainingText;
  const title = active
    ? pendingEndOfTrack
      ? '定时已到点，播完本首后停止'
      : `睡眠定时剩余 ${remainingText}`
    : '睡眠定时';
  const isMobileMenu = variant === 'mobileMenu';
  const triggerTitle = isMobileMenu
    ? active ? `播放器菜单，${title}` : '播放器菜单'
    : title;

  useEffect(() => {
    if (!open) return undefined;
    // 触发器本身也在 rootRef 内:点它不算"点外面",交给 onClick 的 toggle 去收,
    // 否则 pointerdown 先关、click 再开,会变成永远关不掉。
    const onPointerDown = (event) => {
      if (rootRef.current?.contains(event.target)) return;
      setOpen(false);
    };
    const onKeyDown = (event) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [open]);

  const chooseMinutes = (minutes) => {
    onStart(minutes);
    setOpen(false);
  };

  const cancel = () => {
    onCancel();
    setOpen(false);
  };

  return (
    <div ref={rootRef} className={`relative flex-shrink-0 ${className}`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`${isMobileMenu
          ? 'flex h-12 w-12 items-center justify-center rounded-full'
          : 'inline-flex h-9 min-w-[2.25rem] items-center justify-center gap-1.5 rounded-full px-2 text-xs font-medium'
        } transition-colors ${
          active ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:bg-secondary hover:text-foreground'
        }`}
        title={triggerTitle}
        aria-label={triggerTitle}
        aria-expanded={open}
      >
        {isMobileMenu ? <Menu size={26} /> : <Clock size={18} />}
        {!isMobileMenu && active && <span className="tabular-nums">{stateLabel}</span>}
      </button>

      {open && (
        <div className={`absolute bottom-full z-popover mb-3 w-72 ${panelAlignClass[align] || panelAlignClass.right}`}>
          <div className="rounded-lg border border-border p-3 text-left surface-acrylic">
            {extraActions.length > 0 && (
              <div className="mb-3 border-b border-border pb-2">
                {extraActions.map(({ key, icon: ActionIcon, label, hint, onClick }) => (
                  <button
                    key={key || label}
                    type="button"
                    onClick={() => {
                      onClick?.();
                      setOpen(false);
                    }}
                    className="flex w-full items-center gap-3 rounded-md px-2 py-2 text-left transition-colors hover:bg-secondary"
                  >
                    {ActionIcon && <ActionIcon size={19} className="flex-shrink-0 text-muted-foreground" />}
                    <span className="min-w-0 flex-grow text-sm font-medium text-foreground">{label}</span>
                    {hint && <span className="flex-shrink-0 text-xs text-muted-foreground">{hint}</span>}
                  </button>
                ))}
              </div>
            )}
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-foreground">睡眠定时</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {active
                    ? pendingEndOfTrack
                      ? '已到点，本首结束后停止'
                      : `剩余 ${remainingText}`
                    : '选择停止播放时间'}
                </p>
              </div>
              {active && (
                <button
                  type="button"
                  onClick={cancel}
                  className="flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                  title="取消定时"
                  aria-label="取消定时"
                >
                  <X size={16} />
                </button>
              )}
            </div>

            <div className="grid grid-cols-3 gap-2">
              {SLEEP_TIMER_PRESETS_MINUTES.map((minutes) => (
                <button
                  key={minutes}
                  type="button"
                  onClick={() => chooseMinutes(minutes)}
                  className="rounded-md border border-border bg-background px-2 py-2 text-sm font-medium transition-colors hover:border-primary hover:text-primary"
                >
                  {minutes} 分钟
                </button>
              ))}
            </div>

            <label className="mt-3 flex cursor-pointer items-start gap-3 rounded-md bg-background px-3 py-2">
              <input
                type="checkbox"
                checked={stopAfterTrack}
                onChange={(e) => onStopAfterTrackChange(e.target.checked)}
                className="mt-0.5 h-4 w-4 flex-shrink-0 accent-primary"
              />
              <span className="min-w-0">
                <span className="block text-sm font-medium text-foreground">定时到点后，播完当前歌曲再停止</span>
              </span>
            </label>
          </div>
        </div>
      )}
    </div>
  );
};

export default SleepTimerControl;
