import React, { useState } from 'react';
import { Clock, X } from 'lucide-react';
import { SLEEP_TIMER_PRESETS_MINUTES, formatSleepTimerRemaining } from '../contexts/playerSleepTimer.js';

const panelAlignClass = {
  left: 'left-0',
  center: 'left-1/2 -translate-x-1/2',
  right: 'right-0',
};

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
}) => {
  const [open, setOpen] = useState(false);
  const remainingText = formatSleepTimerRemaining(remainingMs);
  const stateLabel = pendingEndOfTrack ? '播完停' : remainingText;
  const title = active
    ? pendingEndOfTrack
      ? '定时已到点,播完本首后停止'
      : `睡眠定时剩余 ${remainingText}`
    : '睡眠定时';

  const chooseMinutes = (minutes) => {
    onStart(minutes);
    setOpen(false);
  };

  const cancel = () => {
    onCancel();
    setOpen(false);
  };

  return (
    <div className={`relative flex-shrink-0 ${className}`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`inline-flex h-9 min-w-[2.25rem] items-center justify-center gap-1.5 rounded-full px-2 text-xs font-medium transition-colors ${
          active ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:bg-secondary hover:text-foreground'
        }`}
        title={title}
        aria-label={title}
        aria-expanded={open}
      >
        <Clock size={18} />
        {active && <span className="tabular-nums">{stateLabel}</span>}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-[80]" onClick={() => setOpen(false)} />
          <div className={`absolute bottom-full z-[90] mb-3 w-72 ${panelAlignClass[align] || panelAlignClass.right}`}>
            <div className="rounded-lg border border-border bg-card p-3 text-left shadow-2xl">
              <div className="mb-3 flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-foreground">睡眠定时</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {active
                      ? pendingEndOfTrack
                        ? '已到点,本首结束后停止'
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
                  <span className="block text-sm font-medium text-foreground">播完整首歌后停止</span>
                </span>
              </label>
            </div>
          </div>
        </>
      )}
    </div>
  );
};

export default SleepTimerControl;
