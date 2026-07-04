import React, { createContext, useCallback, useContext, useRef, useState } from 'react';
import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react';

const FeedbackContext = createContext(null);

const TOAST_ICON = {
  success: CheckCircle2,
  error: AlertCircle,
  info: Info,
};

export const FeedbackProvider = ({ children }) => {
  const [toasts, setToasts] = useState([]);
  const [dialog, setDialog] = useState(null);
  const idRef = useRef(1);

  const removeToast = useCallback((id) => {
    setToasts((items) => items.filter((item) => item.id !== id));
  }, []);

  const notify = useCallback((message, type = 'info') => {
    if (!message) return;
    const id = idRef.current++;
    setToasts((items) => [...items, { id, message, type }].slice(-4));
    window.setTimeout(() => removeToast(id), 3600);
  }, [removeToast]);

  const confirm = useCallback((options) => new Promise((resolve) => {
    setDialog({
      kind: 'confirm',
      title: options?.title || '确认操作',
      body: options?.body || '',
      confirmLabel: options?.confirmLabel || '确认',
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
      confirmLabel: options?.confirmLabel || '确认',
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
      info: (message) => notify(message, 'info'),
      confirm,
      prompt,
    }}>
      {children}
      <ToastStack items={toasts} onClose={removeToast} />
      {dialog && <FeedbackDialog dialog={dialog} onDone={finishDialog} />}
    </FeedbackContext.Provider>
  );
};

const ToastStack = ({ items, onClose }) => (
  <div className="fixed right-4 top-4 z-[90] flex w-[min(22rem,calc(100vw-2rem))] flex-col gap-2">
    {items.map((item) => {
      const Icon = TOAST_ICON[item.type] || Info;
      const tone = item.type === 'error'
        ? 'border-destructive/40 bg-destructive/15 text-destructive'
        : item.type === 'success'
          ? 'border-primary/30 bg-primary/15 text-primary'
          : 'border-border bg-card text-muted-foreground';
      return (
        <div key={item.id} className={`flex items-start gap-3 rounded-md border px-3 py-2 shadow-xl ${tone}`}>
          <Icon size={18} className="mt-0.5 flex-shrink-0" />
          <p className="min-w-0 flex-grow text-sm text-foreground">{item.message}</p>
          <button
            type="button"
            onClick={() => onClose(item.id)}
            className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
            aria-label="关闭提示"
          >
            <X size={15} />
          </button>
        </div>
      );
    })}
  </div>
);

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
    <div className="fixed inset-0 z-[85] flex items-center justify-center bg-black/60 p-4" onMouseDown={(e) => {
      if (e.target === e.currentTarget) onDone(isPrompt ? null : false);
    }}>
      <form onSubmit={submit} className="w-full max-w-sm rounded-lg border border-border bg-card p-4 shadow-xl">
        <div className="mb-4">
          <h2 className="text-lg font-semibold text-foreground">{dialog.title}</h2>
          {dialog.body && <p className="mt-1 text-sm text-muted-foreground">{dialog.body}</p>}
        </div>
        {isPrompt && (
          <label className="mb-4 block">
            {dialog.label && <span className="mb-1 block text-sm text-muted-foreground">{dialog.label}</span>}
            <input
              autoFocus
              type={dialog.inputType}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onBlur={() => setTouched(true)}
              placeholder={dialog.placeholder}
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-foreground outline-none transition-colors focus:border-primary"
            />
            {invalid && <span className="mt-1 block text-xs text-destructive">这里不能为空</span>}
          </label>
        )}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={() => onDone(isPrompt ? null : false)}
            className="min-h-11 rounded-full px-4 py-2 text-sm font-semibold text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
          >
            {dialog.cancelLabel}
          </button>
          <button
            type="submit"
            className={`min-h-11 rounded-full px-4 py-2 text-sm font-semibold transition-colors ${
              dialog.danger
                ? 'bg-destructive text-destructive-foreground hover:brightness-110'
                : 'bg-primary text-primary-foreground hover:brightness-110'
            }`}
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
