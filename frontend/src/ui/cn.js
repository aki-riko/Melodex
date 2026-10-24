// 极简 class 合并工具:只为拼接条件 class,不引入 clsx/tailwind-merge 依赖。
// 用法: cn('base', cond && 'x', ['a', 'b'])
export function cn(...parts) {
  const out = [];
  const push = (v) => {
    if (!v) return;
    if (Array.isArray(v)) { v.forEach(push); return; }
    if (typeof v === 'string') out.push(v);
  };
  parts.forEach(push);
  return out.join(' ');
}

export default cn;
