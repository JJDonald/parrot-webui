/**
 * 渲染错误兜底。
 *
 * 没有 ErrorBoundary 时，任意一处渲染期异常（例如上游字段为 null 而代码直接
 * 调 .toFixed()）都会让 React 卸载整棵树，用户看到纯白页面并丢失所有上下文，
 * 也没有恢复入口。这里给出：错误说明 + 最近一次路由位置 + "重试渲染"与"回首页"。
 *
 * 注意：错误边界只捕获渲染/生命周期阶段抛出的错误，不捕获事件处理器与
 * 异步 Promise 里的错误（那些由各页面的 ApiError 处理链覆盖）。
 */

import { Component, type ErrorInfo, type ReactNode } from 'react';

interface ErrorBoundaryProps {
  children: ReactNode;
  /** 展示用的场景名，例如「概览页」；仅用于文案与排查。 */
  scope: string;
  /** 变化时自动清除错误（用于路由切换后不残留上一页的崩溃状态）。 */
  resetKey?: string;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // 不打印 props/接口响应：错误信息本身可能带用户数据路径，只留在控制台排查。
    console.error(`[webui] ${this.props.scope} 渲染失败`, error, info.componentStack);
  }

  override componentDidUpdate(previous: ErrorBoundaryProps): void {
    if (this.state.error && previous.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  private handleRetry = (): void => {
    this.setState({ error: null });
  };

  private handleHome = (): void => {
    this.setState({ error: null });
    window.location.assign('/webui/');
  };

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="error-boundary" role="alert">
        <div className="error-boundary__card">
          <h2 className="error-boundary__title">{this.props.scope}渲染失败</h2>
          <p className="error-boundary__text">
            页面在渲染时抛出了异常，已停止渲染以避免白屏。你的登录状态没有受影响，可以重试或返回首页换个页面继续。
          </p>
          <pre className="error-boundary__detail mono">{error.message || String(error)}</pre>
          <div className="error-boundary__actions">
            <button type="button" className="btn btn--sm btn--primary" onClick={this.handleRetry}>
              重试渲染
            </button>
            <button type="button" className="btn btn--sm btn--ghost" onClick={this.handleHome}>
              返回首页
            </button>
          </div>
          <p className="error-boundary__hint text-secondary text-sm">
            如果反复出现，请打开浏览器控制台查看堆栈，并把该页面的接口响应一起反馈。
          </p>
        </div>
      </div>
    );
  }
}
