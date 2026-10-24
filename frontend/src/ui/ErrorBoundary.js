import React from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

// 全局错误边界。
// 此前全仓没有 ErrorBoundary:任何组件在渲染期抛错(历史上真发生过一次
// `pendingSources` ReferenceError)都会让 React 卸载整棵树 —— 用户看到的是一片白屏,
// 连"出错了"都没有,只能猜是不是网络断了。
// 现在:捕获 → 显示可读错误 + 重新加载按钮,并把错误留在 console 便于排查。

export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
    this.handleReload = this.handleReload.bind(this);
    this.handleReset = this.handleReset.bind(this);
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // 保留完整栈,方便用户截图或开发者从控制台取。
    console.error('[ErrorBoundary] 渲染失败', error, info?.componentStack);
  }

  handleReload() {
    window.location.reload();
  }

  handleReset() {
    this.setState({ error: null });
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    const message = String(error?.message || error || '未知错误');
    return (
      <div className="app-shell flex overflow-hidden bg-background text-foreground">
        <main className="flex flex-grow items-center justify-center p-6">
          <div className="w-full max-w-lg rounded-lg border border-destructive/40 bg-card p-6 text-center">
            <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-destructive/15 text-destructive">
              <AlertTriangle size={26} />
            </div>
            <h1 className="type-title text-foreground">界面出错了</h1>
            <p className="mt-2 type-body text-muted-foreground">
              这是前端渲染异常,不是你操作的问题。重新加载通常就能恢复。
            </p>
            <p className="mt-3 max-h-24 overflow-y-auto scroll-area rounded-md border border-border bg-background/60 p-2 text-left type-micro text-muted-foreground">
              {message}
            </p>
            <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
              <button
                type="button"
                onClick={this.handleReload}
                className="inline-flex min-h-touch items-center gap-2 rounded-full bg-primary px-5 font-semibold text-primary-foreground transition-[filter] duration-base hover:brightness-110"
              >
                <RefreshCw size={16} aria-hidden="true" />
                重新加载
              </button>
              <button
                type="button"
                onClick={this.handleReset}
                className="inline-flex min-h-touch items-center gap-2 rounded-full bg-secondary px-5 font-semibold text-secondary-foreground transition-colors duration-base hover:bg-accent"
              >
                再试一次
              </button>
            </div>
          </div>
        </main>
      </div>
    );
  }
}
