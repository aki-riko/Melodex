import React from 'react';
import { Loader2 } from 'lucide-react';
import { cn } from './cn';

// 统一按钮。此前全站「主按钮」有 8 种写法(px-5/px-6、rounded-md/rounded-full、
// hover:brightness-110/brightness-95/bg-secondary、有无 min-h、有无 disabled 态),
// 而且 hover/active/focus/disabled 四态没有一处是完整的。这里一次定义清楚。
//
// variant:
//   primary   —— 唯一主动作(播放全部、搜索)。全页通常只应出现一个。
//   secondary —— 次要动作(下载、缓存)。中性灰面。
//   ghost     —— 更低权重(取消、返回)。
//   danger    —— 破坏性(删除)。
//   link      —— 纯文本动作。
// size: sm(36) / md(40) / lg(44,默认,满足触控下限)

const VARIANTS = {
  primary:
    'bg-primary text-primary-foreground hover:brightness-110 active:brightness-95 shadow-sm',
  secondary:
    'bg-secondary text-secondary-foreground hover:bg-accent active:brightness-95',
  outline:
    'border border-border bg-transparent text-foreground hover:bg-secondary hover:border-muted-foreground/40 active:brightness-95',
  ghost:
    'bg-transparent text-muted-foreground hover:bg-secondary hover:text-foreground active:brightness-95',
  danger:
    'bg-destructive text-destructive-foreground hover:brightness-110 active:brightness-95',
  link:
    'bg-transparent text-muted-foreground hover:text-foreground underline-offset-4 hover:underline px-0',
};

const SIZES = {
  sm: 'h-9 px-3 text-xs gap-1.5',
  md: 'h-10 px-4 text-sm gap-2',
  lg: 'min-h-touch px-5 text-sm gap-2',
};

const ICON_ONLY_SIZES = {
  sm: 'h-8 w-8',
  md: 'h-10 w-10',
  lg: 'min-h-touch min-w-touch',
};

/**
 * @param {object} props
 * @param {'primary'|'secondary'|'outline'|'ghost'|'danger'|'link'} [props.variant]
 * @param {'sm'|'md'|'lg'} [props.size]
 * @param {boolean} [props.loading] 显示 spinner 并自动 disabled
 * @param {boolean} [props.block] 占满宽度
 * @param {boolean} [props.iconOnly] 方形图标按钮(必须给 aria-label)
 * @param {boolean} [props.pressed] 用于 aria-pressed 的切换按钮(已选中)
 */
const Button = React.forwardRef(function Button({
  variant = 'secondary',
  size = 'lg',
  loading = false,
  block = false,
  iconOnly = false,
  pressed,
  className = '',
  children,
  disabled,
  type = 'button',
  ...rest
}, ref) {
  const isDisabled = disabled || loading;
  return (
    <button
      ref={ref}
      type={type}
      disabled={isDisabled}
      aria-busy={loading || undefined}
      aria-pressed={pressed === undefined ? undefined : pressed}
      className={cn(
        // 基础:圆角、过渡、焦点环、禁用态、触控、禁选中
        'inline-flex items-center justify-center rounded-full font-semibold whitespace-nowrap',
        'transition-[background-color,color,filter,opacity,transform] duration-base ease-standard',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[hsl(var(--ring))]',
        'select-none',
        isDisabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer',
        // 触控下限:图标按钮在移动端也要够大(lg 已是 44px)
        iconOnly ? ICON_ONLY_SIZES[size] : SIZES[size],
        VARIANTS[variant],
        block && 'w-full',
        className,
      )}
      {...rest}
    >
      {loading && <Loader2 size={16} className="animate-spin flex-shrink-0" aria-hidden="true" />}
      {children}
    </button>
  );
});

export default Button;
