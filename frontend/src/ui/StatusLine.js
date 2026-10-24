import React from 'react';
import { AlertCircle, CheckCircle2, Info, Loader2, TriangleAlert, X } from 'lucide-react';
import { cn } from './cn';

// 内联状态行。
// 历史问题:搜索结果页把"已找到搜索结果""听歌识曲未启用"做成两条整宽彩色横幅,
// 各占 60px 高,却只传达一句话 —— 页面因此显得"一块一块、没有重点"。
// 现在:只有"阻断性错误"用 banner(细边框、浅底、单行);
//      其余状态一律用 inline(一行灰字 + 小图标),不再抢视觉。
//
// tone: info | success | warning | error | neutral
// layout: banner(带边框底色的条) | inline(无边框的一行)

const TONES = {
  neutral: {
    icon: Info,
    text: 'text-muted-foreground',
    wrap: 'border-border bg-card/70 text-muted-foreground',
    iconCls: 'text-muted-foreground',
  },
  info: {
    icon: Info,
    text: 'text-muted-foreground',
    wrap: 'border-info/30 bg-info/10 text-muted-foreground',
    iconCls: 'text-info',
  },
  success: {
    icon: CheckCircle2,
    text: 'text-muted-foreground',
    wrap: 'border-success/25 bg-success/10 text-muted-foreground',
    iconCls: 'text-success',
  },
  warning: {
    icon: TriangleAlert,
    text: 'text-muted-foreground',
    wrap: 'border-warning/35 bg-warning/10 text-muted-foreground',
    iconCls: 'text-warning',
  },
  error: {
    icon: AlertCircle,
    text: 'text-foreground',
    wrap: 'border-destructive/45 bg-destructive/10 text-foreground',
    iconCls: 'text-destructive',
  },
};

/**
 * @param {object} props
 * @param {'info'|'success'|'warning'|'error'|'neutral'} [props.tone]
 * @param {'banner'|'inline'} [props.layout]
 * @param {boolean} [props.loading] 左侧显示 spinner,progress>0 时显示确定进度条
 * @param {number} [props.progress] 0-100
 * @param {() => void} [props.onDismiss]
 * @param {React.ReactNode} [props.action]
 */
export default function StatusLine({
  tone = 'neutral',
  layout = 'inline',
  icon,
  loading = false,
  progress = null,
  onDismiss,
  action,
  className = '',
  children,
}) {
  const conf = TONES[tone] || TONES.neutral;
  const Icon = icon || conf.icon;
  const isBanner = layout === 'banner';

  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      aria-live={tone === 'error' ? 'assertive' : 'polite'}
      className={cn(
        'flex items-start gap-2.5',
        isBanner
          ? cn('rounded-md border px-3 py-2', conf.wrap)
          : 'py-1',
        className,
      )}
    >
      <span className={cn('mt-0.5 flex-shrink-0', conf.iconCls)} aria-hidden="true">
        {loading
          ? <Loader2 size={isBanner ? 16 : 14} className="animate-spin" />
          : <Icon size={isBanner ? 16 : 14} />}
      </span>
      <div className={cn('min-w-0 flex-grow', isBanner ? 'type-caption' : 'type-micro', conf.text)}>
        <div className="min-w-0">{children}</div>
        {progress != null && (
          <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-secondary" aria-hidden="true">
            <div
              className="h-full rounded-full bg-primary transition-[width] duration-base ease-standard"
              style={{ width: `${Math.max(0, Math.min(100, progress))}%` }}
            />
          </div>
        )}
      </div>
      {action && <div className="flex-shrink-0">{action}</div>}
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="关闭提示"
          className="-mr-1 -mt-0.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors duration-base hover:bg-secondary hover:text-foreground"
        >
          <X size={14} />
        </button>
      )}
    </div>
  );
}
