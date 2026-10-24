import React from 'react';
import { cn } from './cn';

// 分段控件。替代此前搜索页那三张「推荐排序 / 高音质优先 / 文件更小」大卡片 ——
// 每张卡约 60px 高、占满一行、物重与搜索结果同级,把页面切成"一坨一坨"。
// 排序是次要控件,应该压成一行紧凑分段。
//
// 用法:
//   <Segmented value={sort} onChange={setSort}
//     options={[{value:'recommended',label:'推荐'}, ...]} />

const SIZES = {
  sm: 'h-8 px-2.5 text-xs',
  md: 'h-9 px-3 text-sm',
};

export default function Segmented({
  value,
  onChange,
  options = [],
  size = 'md',
  className = '',
  label = '选项',
}) {
  return (
    <div
      role="tablist"
      aria-label={label}
      className={cn(
        'inline-flex items-center gap-0.5 rounded-full border border-border bg-card p-0.5',
        className,
      )}
    >
      {options.map((opt) => {
        const active = opt.value === value;
        const Icon = opt.icon;
        return (
          <button
            key={opt.value}
            type="button"
            role="tab"
            aria-selected={active}
            title={opt.hint || opt.label}
            onClick={() => onChange?.(opt.value)}
            className={cn(
              'inline-flex items-center justify-center gap-1.5 rounded-full font-semibold',
              'transition-colors duration-base ease-standard',
              'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[hsl(var(--ring))]',
              SIZES[size],
              active
                ? 'bg-secondary text-foreground'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {Icon && <Icon size={14} aria-hidden="true" />}
            <span>{opt.label}</span>
          </button>
        );
      })}
    </div>
  );
}
