import React, { useId } from 'react';
import { cn } from './cn';

// 统一输入框 + 字段包装。
// 此前 14 处输入框有三种聚焦策略(ring-2 / ring-1 / 仅 border),
// 全部用 placeholder 当标签(输入后标签消失),且无错误态与 aria 关联。
//
// 用法:
//   <Field label="歌单名" hint="回车创建" error={err}>
//     <Input value={...} onChange={...} />
//   </Field>

const BASE_INPUT =
  'w-full rounded-md border bg-card px-3 text-foreground placeholder:text-muted-foreground/70 ' +
  'transition-colors duration-base ease-standard focus:border-primary focus:outline-none ' +
  'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[hsl(var(--ring))] ' +
  'disabled:cursor-not-allowed disabled:opacity-60';

export const Input = React.forwardRef(function Input({
  className = '',
  invalid = false,
  size = 'md',
  ...rest
}, ref) {
  const heights = { sm: 'h-9 text-sm', md: 'min-h-touch text-sm', lg: 'h-12 text-base' };
  return (
    <input
      ref={ref}
      aria-invalid={invalid || undefined}
      className={cn(
        BASE_INPUT,
        heights[size],
        invalid ? 'border-destructive focus:border-destructive' : 'border-border',
        className,
      )}
      {...rest}
    />
  );
});

export const Textarea = React.forwardRef(function Textarea({
  className = '',
  invalid = false,
  ...rest
}, ref) {
  return (
    <textarea
      ref={ref}
      aria-invalid={invalid || undefined}
      className={cn(
        BASE_INPUT,
        'min-h-24 py-2 text-sm scroll-area',
        invalid ? 'border-destructive focus:border-destructive' : 'border-border',
        className,
      )}
      {...rest}
    />
  );
});

export const Select = React.forwardRef(function Select({ className = '', ...rest }, ref) {
  return (
    <select
      ref={ref}
      className={cn(
        BASE_INPUT,
        'min-h-touch pr-8 text-sm',
        className,
      )}
      {...rest}
    />
  );
});

/**
 * 字段容器:label + 控件 + hint/error,并自动把 label/描述/错误串上 aria。
 * 传 id 可覆盖自动 id;也可把 <Input id={...}/> 显式对齐。
 */
export function Field({
  label,
  hint,
  error,
  required = false,
  htmlFor,
  className = '',
  children,
}) {
  const autoId = useId();
  const id = htmlFor || autoId;
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [error ? errorId : null, hint ? hintId : null].filter(Boolean).join(' ');

  // 把 id / aria-describedby 透传给唯一的子元素
  const child = React.isValidElement(children)
    ? React.cloneElement(children, {
      id: children.props.id || id,
      'aria-describedby': [children.props['aria-describedby'], describedBy]
        .filter(Boolean)
        .join(' ') || undefined,
    })
    : children;

  return (
    <div className={cn('block', className)}>
      {label && (
        <label htmlFor={id} className="mb-1.5 block type-caption text-muted-foreground">
          {label}
          {required && <span className="ml-0.5 text-destructive" aria-hidden="true">*</span>}
          {required && <span className="sr-only">(必填)</span>}
        </label>
      )}
      {child}
      {error ? (
        <p id={errorId} role="alert" className="mt-1 type-micro text-destructive">{error}</p>
      ) : hint ? (
        <p id={hintId} className="mt-1 type-micro text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}

export default Input;
