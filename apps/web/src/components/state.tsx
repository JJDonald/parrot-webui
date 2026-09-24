/**
 * 列表/查询的六类状态展示：加载中、正常、空数据、加载失败、权限不足、连接中断。
 * 空数据不得伪装成零统计；失败也不得被吞成空数组（实施文档 6.1 / 11.2）。
 */

import type { ReactNode } from 'react';
import { ApiError } from '@/api/client';
import { TRANSPORT_ERROR_CODES, UPSTREAM_CODE } from '@/api/error-codes';
import { ErrorNotice } from './feedback';

export function LoadingBlock({ label = '加载中…' }: { label?: string }) {
  return (
    <div className="loading-block" role="status" aria-live="polite">
      <span className="loading-spinner" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <div className="empty-state__content">
        <span className="empty-state__icon" aria-hidden="true">
          ∅
        </span>
        <div>
          <div className="empty-state__title">{title}</div>
          {description ? <div className="empty-state__desc">{description}</div> : null}
        </div>
      </div>
      {action}
    </div>
  );
}

export interface AsyncStateProps<T> {
  isLoading: boolean;
  error: ApiError | null | undefined;
  data: T | undefined;
  /** 判断是否为空数据；只有真正查询成功且结果为空时才使用 */
  isEmpty?: (data: T) => boolean;
  emptyTitle?: string;
  emptyDescription?: ReactNode;
  emptyAction?: ReactNode;
  onRetry?: () => void;
  loadingLabel?: string;
  /** 有上一次成功快照时，用旧数据继续渲染并在顶部提示可能过期 */
  isStale?: boolean;
  staleNotice?: ReactNode;
  children: (data: T) => ReactNode;
}

export function isEmptyData(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of ['items', 'list', 'records', 'rows']) {
      const candidate = record[key];
      if (Array.isArray(candidate)) return candidate.length === 0;
    }
    return Object.keys(record).length === 0;
  }
  return false;
}

export function AsyncState<T>({
  isLoading,
  error,
  data,
  isEmpty = isEmptyData,
  emptyTitle = '暂无数据',
  emptyDescription,
  emptyAction,
  onRetry,
  loadingLabel,
  isStale,
  staleNotice,
  children,
}: AsyncStateProps<T>) {
  const hasData = data !== undefined && data !== null;
  const empty = hasData && isEmpty(data as T);

  if (isLoading && !hasData) {
    return <LoadingBlock label={loadingLabel ?? '加载中…'} />;
  }

  if (error && !hasData) {
    // 权限不足 / 连接中断 / 业务失败都保留具体 code，不做统一模糊提示
    return <ErrorNotice error={error} onRetry={onRetry} />;
  }

  if (!hasData) {
    return <EmptyState title={emptyTitle} description={emptyDescription ?? '上游没有返回可展示的数据。'} action={emptyAction} />;
  }

  if (empty) {
    return <EmptyState title={emptyTitle} description={emptyDescription} action={emptyAction} />;
  }

  return (
    <>
      {error && hasData ? (
        <div style={{ marginBottom: 12 }}>
          <ErrorNotice error={error} onRetry={onRetry} compact staleNotice={staleNotice} />
        </div>
      ) : null}
      {isStale ? (
        <div className="notice-box notice-box--warning" style={{ marginBottom: 12 }} role="status">
          显示的是上一次成功刷新的快照，当前刷新失败，数据可能已过期。
        </div>
      ) : null}
      {children(data as T)}
    </>
  );
}

/** 权限不足：保留登录状态，禁用相关功能并说明（而不是伪装成失败） */
export function isPermissionDenied(error: ApiError | null | undefined): boolean {
  if (!error) return false;
  // 只有「确实由上游判定」的 403 才算权限不足。
  // WebUI 自己产生的 403（本地缺少 CSRF Token、服务端 CSRF 校验拒绝、需要重新登录等）
  // 以及 network 错误都不能说成「上游权限判定」，否则会把排查方向带偏。
  if (error.source !== 'upstream') return false;
  return error.code === UPSTREAM_CODE.CAPABILITY_DENIED || error.status === 403;
}

/** 连接中断：WebUI 到 Parrot 的传输问题，不是业务失败 */
export function isTransportFailure(error: ApiError | null | undefined): boolean {
  if (!error) return false;
  return error.source === 'network' || TRANSPORT_ERROR_CODES.includes(error.code);
}
