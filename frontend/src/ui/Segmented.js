import React from 'react';
import { cn } from './cn';

// 分段控件。替代此前搜索页那三张「推荐排序 / 高音质优先 / 文件更小」大卡片 ——
// 每张卡约 60px 高、占满一行、物重与搜索结果同级,把页面切成"一坨一坨"。
// 排序是次要控件,应该压成一行紧凑分段。
//
// 用法:
//   <Segmented value={sort} onChange={setSort}
//     options={[{value:'recommended',label:'推荐'}, ...]} />
//
// ⚠️ 选项的标识字段必须叫 `value`。
// 曾经有一个调用方写成 `{ key: 'search', … }`,而这里只读 `opt.value`,结果是三重静默失效:
//   · 选中态永远不亮(undefined 不等于任何 value)
//   · key 全是 undefined(React 重复 key 警告)
//   · 点击回传 undefined → 父组件 setTab(undefined) → 内容区直接空白
// 构建、类型检查、门禁都抓不到。所以这里做两件事:兼容 `key` 作为兜底 + 开发期显式告警,
// 让同样的误用下一次至少在控制台喊出来。
const optionKeyOf = (opt) => opt.value ?? opt.key;

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
  if (process.env.NODE_ENV !== 'production') {
    const missing = options.filter((opt) => optionKeyOf(opt) === undefined);
    if (missing.length > 0) {
      console.error(
        '[Segmented] 选项缺少 value 字段，会导致选中态丢失且切换失效：',
        missing,
      );
    }
  }

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
        const optKey = optionKeyOf(opt);
        const active = optKey === value;
        const Icon = opt.icon;
        return (
          <button
            key={optKey ?? opt.label}
            type="button"
            role="tab"
            aria-selected={active}
            title={opt.hint || opt.label}
            onClick={() => onChange?.(optKey)}
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
