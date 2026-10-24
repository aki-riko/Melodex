import React from 'react';
import { cn } from './cn';

// 统一卡片/面板。此前"卡片"在 6 个文件里有 6 种写法
// (rounded-md/lg + border-border + bg-card/bg-card\/70 + p-2/3/4),层级无从分辨。
//
// variant:
//   plain    —— 无边框无底色,纯内容分组(用于列表块)
//   card     —— 一张卡(底色 + 边框)
//   surface  —— 低对比面板(背景层,用来包住一组卡片)
//   inset    —— 内嵌块(比父级更深一档,用于进度/统计块)

const VARIANTS = {
  plain: '',
  card: 'rounded-lg border border-border bg-card',
  surface: 'rounded-lg border border-border bg-card/60',
  inset: 'rounded-md border border-border/70 bg-background/50',
};

/** 卡片容器 */
export function Card({ variant = 'card', interactive = false, className = '', children, ...rest }) {
  return (
    <div
      className={cn(
        VARIANTS[variant],
        interactive &&
          'cursor-pointer transition-colors duration-base ease-standard hover:border-muted-foreground/40 hover:bg-secondary/60',
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}

/**
 * 分区标题:一个页面里的每个内容区都应该有,让"这一坨是什么"一眼可读。
 * 支持右侧 actions 与副标题。
 */
export function SectionHeader({ title, count, hint, actions, className = '', id }) {
  return (
    <div className={cn('mb-3 flex flex-wrap items-end justify-between gap-x-3 gap-y-1', className)}>
      <div className="min-w-0">
        <h2 id={id} className="type-section text-foreground">
          {title}
          {count != null && (
            <span className="ml-2 type-caption font-normal text-muted-foreground nums">{count}</span>
          )}
        </h2>
        {hint && <p className="mt-0.5 type-micro text-muted-foreground">{hint}</p>}
      </div>
      {actions && <div className="flex flex-shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

/** 页面主标题(每页一个,替代此前 h2/h3 混用与 28/30/36px 混用) */
export function PageHeader({ title, subtitle, actions, className = '' }) {
  return (
    <header className={cn('mb-5 flex flex-wrap items-end justify-between gap-3', className)}>
      <div className="min-w-0">
        <h1 className="type-hero text-foreground">{title}</h1>
        {subtitle && <p className="mt-1 type-caption text-muted-foreground">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-shrink-0 items-center gap-2">{actions}</div>}
    </header>
  );
}

export default Card;
