import React, { createContext, useCallback, useContext, useRef, useState } from 'react';
import { AlertCircle, CheckCircle2, Info, TriangleAlert, X } from 'lucide-react';
import { cn } from '../ui/cn';

// 全站反馈通道。本轮改造要点:
//  1. 可访问性:容器加 role/aria-live —— 否则这是全站唯一的成功/失败反馈,
//     读屏用户却完全收不到(此前 0 处 aria-live)。
//  2. 层级:用语义 z-toast,不再 z-[90] 与睡眠定时面板撞层。
//  3. 可读性:悬停/聚焦时暂停自动消失(长文案读得完),支持手动关闭。
//  4. 语义色:error 用 destructive、success 用 success、warning 用 warning,
//     不再让"成功"和"品牌主色"抢同一个绿。

const FeedbackContext = createContext(null);

const TOAST_CONF = {
  success: { icon: CheckCircle2, accent: 'text-success', ring: 'border-success/35' },
  error: { icon: AlertCircle, accent: 'text-destructive', ring: 'border-destructive/45' },
  warning: { icon: TriangleAlert, accent: 'text-warning', ring: 'border-warning/40' },
  info: { icon: Info, accent: 'text-info', ring: 'border-border' },
};

const TOAST_TTL = 3600;

export const FeedbackProvider = ({ children }) => {
  const [toasts, setToasts] = useState([]);
  const [dialog, setDialog] = useState(null);
  const idRef = useRef(1);
  const timersRef = useRef(new Map());

  const clearTimer = useCallback((id) => {
    const timer = timersRef.current.get(id);
    if (timer) {
      window.clearTimeout(timer);
      timersRef.current.delete(id);
    }
  }, []);

  const removeToast = useCallback((id) => {
    clearTimer(id);
    setToasts((items) => items.filter((item) => item.id !== id));
  }, [clearTimer]);

  const notify = useCallback((message, type = 'info') => {
    if (!message) return;
    const id = idRef.current++;
    setToasts((items) => [...items, { id, message, type }].slice(-4));
    // 悬停暂停:鼠标进入时 clearTimeout,离开时重新计时(见 ToastItem)。
    timersRef.current.set(id, window.setTimeout(() => removeToast(id), TOAST_TTL));
  }, [removeToast]);

  const pauseToast = useCallback((id) => clearTimer(id), [clearTimer]);
  const resumeToast = useCallback((id) => {
    if (timersRef.current.has(id)) return;
    timersRef.current.set(id, window.setTimeout(() => removeToast(id), TOAST_TTL));
  }, [removeToast]);

  const confirm = useCallback((options) => new Promise((resolve) => {
    setDialog({
      kind: 'confirm',
      title: options?.title || '确认操作',
      body: options?.body || '',
      confirmLabel: options?.confirmLabel || '确定',
      cancelLabel: options?.cancelLabel || '取消',
      danger: !!options?.danger,
      resolve,
    });
  }), []);

  const prompt = useCallback((options) => new Promise((resolve) => {
    setDialog({
      kind: 'prompt',
      title: options?.title || '输入内容',
      body: options?.body || '',
      label: options?.label || '',
      placeholder: options?.placeholder || '',
      inputType: options?.inputType || 'text',
      defaultValue: options?.defaultValue || '',
      confirmLabel: options?.confirmLabel || '确定',
      cancelLabel: options?.cancelLabel || '取消',
      required: options?.required !== false,
      resolve,
    });
  }), []);

  const finishDialog = useCallback((value) => {
    setDialog((current) => {
      if (current?.resolve) current.resolve(value);
      return null;
    });
  }, []);

  return (
    <FeedbackContext.Provider value={{
      notify,
      success: (message) => notify(message, 'success'),
      error: (message) => notify(message, 'error'),
      warning: (message) => notify(message, 'warning'),
      info: (message) => notify(message, 'info'),
      confirm,
      prompt,
    }}>
      {children}
      <ToastStack
        items={toasts}
        onClose={removeToast}
        onPause={pauseToast}
        onResume={resumeToast}
      />
      {dialog && <FeedbackDialog dialog={dialog} onDone={finishDialog} />}
    </FeedbackContext.Provider>
  );
};

// 提示条位置: 桌面在右上角; 移动端要避开顶栏(顶栏常驻在最上方, 高约 3.9rem),
// 否则提示会盖住全局搜索框。移动端满宽(左右各留 1rem), 桌面固定 22rem。
const ToastStack = ({ items, onClose, onPause, onResume }) => {
  const hasError = items.some((item) => item.type === 'error');
  return (
    <div
      // 错误用 assertive(立即播报),其余 polite(排队播报)
      role={hasError ? 'alert' : 'status'}
      aria-live={hasError ? 'assertive' : 'polite'}
      aria-atomic="false"
      className="pointer-events-none fixed inset-x-4 top-[4.5rem] z-toast flex flex-col gap-2 md:inset-x-auto md:right-4 md:top-4 md:w-[min(22rem,calc(100vw-2rem))]"
    >
      {items.map((item) => (
        <ToastItem
          key={item.id}
          item={item}
          onClose={onClose}
          onPause={onPause}
          onResume={onResume}
        />
      ))}
    </div>
  );
};

const ToastItem = ({ item, onClose, onPause, onResume }) => {
  const conf = TOAST_CONF[item.type] || TOAST_CONF.info;
  const Icon = conf.icon;
  return (
    <div
      className={cn(
        'pointer-events-auto flex items-start gap-2.5 rounded-md border bg-popover px-3 py-2.5 shadow-popover',
        'animate-pop-in',
        conf.ring,
      )}
      onMouseEnter={() => onPause(item.id)}
      onMouseLeave={() => onResume(item.id)}
      onFocus={() => onPause(item.id)}
      onBlur={() => onResume(item.id)}
    >
      <Icon size={17} className={cn('mt-0.5 flex-shrink-0', conf.accent)} aria-hidden="true" />
      <p className="min-w-0 flex-grow type-body text-foreground">{item.message}</p>
      <button
        type="button"
        onClick={() => onClose(item.id)}
        className="-mr-1 -mt-1 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors duration-base hover:bg-secondary hover:text-foreground"
        aria-label="关闭提示"
      >
        <X size={15} />
      </button>
    </div>
  );
};

const FeedbackDialog = ({ dialog, onDone }) => {
  const [value, setValue] = useState(dialog.defaultValue || '');
  const [touched, setTouched] = useState(false);
  const isPrompt = dialog.kind === 'prompt';
  const invalid = isPrompt && dialog.required && touched && !value.trim();

  const submit = (e) => {
    e.preventDefault();
    if (isPrompt) {
      setTouched(true);
      if (dialog.required && !value.trim()) return;
      onDone(value);
      return;
    }
    onDone(true);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="feedback-dialog-title"
      className="fixed inset-0 z-modal flex items-center justify-center bg-black/60 p-4 animate-fade-in"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onDone(isPrompt ? null : false);
      }}
    >
      <form
        onSubmit={submit}
        className="w-full max-w-sm rounded-lg border border-border bg-popover p-4 shadow-dialog animate-pop-in"
      >
        <div className="mb-4">
          <h2 id="feedback-dialog-title" className="type-section text-foreground">{dialog.title}</h2>
          {dialog.body && <p className="mt-1 type-caption text-muted-foreground">{dialog.body}</p>}
        </div>
        {isPrompt && (
          <label className="mb-4 block">
            {dialog.label && <span className="mb-1 block type-caption text-muted-foreground">{dialog.label}</span>}
            <input
              autoFocus
              type={dialog.inputType}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onBlur={() => setTouched(true)}
              placeholder={dialog.placeholder}
              aria-invalid={invalid || undefined}
              className={cn(
                'min-h-touch w-full rounded-md border bg-background px-3 text-foreground',
                'transition-colors duration-base focus:outline-none focus:ring-2 focus:ring-primary',
                invalid ? 'border-destructive' : 'border-border',
              )}
            />
            {invalid && (
              <span role="alert" className="mt-1 block type-micro text-destructive">这里不能为空</span>
            )}
          </label>
        )}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={() => onDone(isPrompt ? null : false)}
            className="min-h-touch rounded-full px-4 type-body font-semibold text-muted-foreground transition-colors duration-base hover:bg-secondary hover:text-foreground"
          >
            {dialog.cancelLabel}
          </button>
          <button
            type="submit"
            className={cn(
              'min-h-touch rounded-full px-4 type-body font-semibold transition-[filter] duration-base hover:brightness-110',
              dialog.danger
                ? 'bg-destructive text-destructive-foreground'
                : 'bg-primary text-primary-foreground',
            )}
          >
            {dialog.confirmLabel}
          </button>
        </div>
      </form>
    </div>
  );
};

export const useFeedback = () => {
  const ctx = useContext(FeedbackContext);
  if (!ctx) throw new Error('useFeedback 必须在 FeedbackProvider 内使用');
  return ctx;
};
