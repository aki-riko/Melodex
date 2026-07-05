import React from 'react';
import { Loader2 } from 'lucide-react';

const widths = ['w-3/4', 'w-2/3', 'w-5/6', 'w-1/2', 'w-4/5', 'w-3/5'];

export const LoadingRows = ({ rows = 5, compact = false }) => (
  <div className="space-y-2" aria-hidden="true">
    {Array.from({ length: rows }).map((_, index) => (
      <div key={index} className="flex items-center gap-3 rounded-md px-3 py-2">
        <div className={`${compact ? 'h-9 w-9' : 'h-11 w-11'} flex-shrink-0 rounded loading-shimmer`} />
        <div className="min-w-0 flex-grow space-y-2">
          <div className={`h-3 rounded loading-shimmer ${widths[index % widths.length]}`} />
          <div className={`h-2.5 rounded loading-shimmer ${widths[(index + 3) % widths.length]}`} />
        </div>
        <div className="hidden h-3 w-16 rounded loading-shimmer md:block" />
      </div>
    ))}
  </div>
);

const LoadingState = ({
  title = '加载中',
  detail = '正在读取数据,请稍等',
  rows = 4,
  compact = false,
  showRows = true,
  className = '',
}) => (
  <div className={`rounded-md border border-border bg-card/70 px-4 py-4 ${className}`} role="status" aria-live="polite">
    <div className="flex items-start gap-3">
      <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
        <Loader2 size={20} className="animate-spin" />
      </div>
      <div className="min-w-0 flex-grow">
        <p className="font-semibold text-foreground">
          {title}
          <span className="loading-dots" aria-hidden="true" />
        </p>
        {detail ? <p className="mt-1 text-sm leading-6 text-muted-foreground">{detail}</p> : null}
      </div>
    </div>
    {showRows && !compact ? (
      <div className="mt-4">
        <LoadingRows rows={rows} />
      </div>
    ) : null}
  </div>
);

export const InlineLoading = ({ label = '加载中', className = '' }) => (
  <span className={`inline-flex items-center gap-2 text-muted-foreground ${className}`} role="status" aria-live="polite">
    <Loader2 size={16} className="animate-spin text-primary" />
    <span>
      {label}
      <span className="loading-dots" aria-hidden="true" />
    </span>
  </span>
);

export default LoadingState;
