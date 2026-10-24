import React from 'react';
import { cn } from './cn';

// 统一空状态。此前空态有三种:一行小灰字、什么都没有、和加载态共用同一个组件。
// 空状态必须回答两个问题:为什么这里是空的、我该做什么。
//
// 用法:
//   <EmptyState icon={Search} title="还没有搜索结果"
//     description="试试「歌手 歌名」或粘贴歌曲链接"
//     action={<Button variant="primary" onClick={goSearch}>去搜索</Button>} />

export default function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  compact = false,
  className = '',
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center text-center',
        compact ? 'py-6' : 'py-12',
        className,
      )}
    >
      {Icon && (
        <div
          className={cn(
            'mb-3 flex items-center justify-center rounded-full bg-secondary/70 text-muted-foreground',
            compact ? 'h-10 w-10' : 'h-14 w-14',
          )}
          aria-hidden="true"
        >
          <Icon size={compact ? 18 : 24} />
        </div>
      )}
      <p className={cn('font-semibold text-foreground', compact ? 'type-body' : 'type-section')}>
        {title}
      </p>
      {description && (
        <p className="mt-1 max-w-sm type-caption text-muted-foreground">{description}</p>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
