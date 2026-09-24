/**
 * 错误展示与冲突处理。
 *
 * 要求（实施文档 7.4）：区分上游业务错误与 BFF 传输错误；把 fields 映射到表单；
 * 409 REVISION_CONFLICT 必须进入冲突处理而不是自动覆盖；
 * 429 显示等待时间；SAVED_RELOAD_UNCONFIRMED 提示"已保存但未确认重载"且禁止重放。
 */

import type { ReactNode } from 'react';
import { ApiError } from '@/api/client';
import { SAVED_RELOAD_UNCONFIRMED, UPSTREAM_CODE } from '@/api/error-codes';
import { isPermissionDenied, isTransportFailure } from './state';

export interface ErrorNoticeProps {
  error: ApiError;
  onRetry?: () => void;
  compact?: boolean;
  staleNotice?: ReactNode;
  /** 冲突处理回调：由页面提供"重新读取最新版本并重新确认"的动作 */
  onResolveConflict?: () => void;
}

function hasReloadUnconfirmed(error: ApiError): boolean {
  return error.fields.some((field) => field.code === SAVED_RELOAD_UNCONFIRMED);
}

export function ErrorNotice({ error, onRetry, compact, onResolveConflict, staleNotice }: ErrorNoticeProps) {
  const reloadUnconfirmed = hasReloadUnconfirmed(error);
  const permissionDenied = isPermissionDenied(error);
  const transport = isTransportFailure(error);
  // WebUI 自身拒绝（本地缺 CSRF、BFF 校验失败、需要重新登录等）：请求没有到达 Parrot，
  // 不能说成「上游权限判定」，否则会把排查方向带偏。
  const rejectedByWebui = !transport && error.source === 'webui';
  const conflict = error.code === UPSTREAM_CODE.REVISION_CONFLICT;

  const heading = reloadUnconfirmed
    ? '配置已保存，但运行时重载未确认'
    : permissionDenied
      ? '权限不足，无法执行该操作'
      : conflict
        ? '该资源已被其他管理端修改'
        : transport
          ? 'WebUI 与 Parrot 之间的连接异常'
          : rejectedByWebui
            ? 'WebUI 拒绝了该请求（未到达 Parrot）'
            : 'Parrot 返回了业务错误';

  const sourceLabel = transport
    ? 'WebUI 传输错误'
    : permissionDenied
      ? '上游权限判定'
      : rejectedByWebui
        ? 'WebUI 自身校验'
        : 'Parrot 业务错误';

  return (
    <div className="error-box" role="alert" data-compact={compact ? 'true' : 'false'}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
        <strong>{heading}</strong>
        <span>
          [{sourceLabel}] {error.code}：{error.message}
        </span>
        {error.fields.length ? (
          <ul style={{ margin: 0, paddingLeft: 16 }}>
            {error.fields.slice(0, 8).map((field) => (
              <li key={`${field.path}-${field.code}`}>
                <span className="mono">{field.path || '(整体)'}</span>：{field.message || field.code}
              </li>
            ))}
          </ul>
        ) : null}
        {error.retryAfterSeconds ? <span>请等待约 {error.retryAfterSeconds} 秒后再试（上游限流）。</span> : null}
        {error.retryable && !error.retryAfterSeconds && !reloadUnconfirmed ? (
          <span>该错误标记为可重试；读取类请求可稍后重试，写操作请先刷新确认结果。</span>
        ) : null}
        {reloadUnconfirmed ? <span>不要重放刚才的操作；请刷新状态确认实际生效情况。</span> : null}
        {staleNotice}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 2 }}>
          {onRetry && !reloadUnconfirmed ? (
            <button type="button" className="btn btn--sm btn--secondary" onClick={onRetry}>
              重试
            </button>
          ) : null}
          {conflict && onResolveConflict ? (
            <button type="button" className="btn btn--sm btn--secondary" onClick={onResolveConflict}>
              重新读取最新版本
            </button>
          ) : null}
          {error.requestId ? <span className="text-sm">请求ID：{error.requestId}</span> : null}
        </div>
      </div>
    </div>
  );
}

export function ConflictNotice({
  currentRevision,
  onReload,
  message,
}: {
  currentRevision?: string | null;
  onReload: () => void;
  message?: string;
}) {
  return (
    <div className="notice-box notice-box--warning" role="alert">
      <div className="stack" style={{ gap: 6 }}>
        <strong>{message ?? '资源版本冲突（REVISION_CONFLICT）：本页数据已被其他管理端修改。'}</strong>
        <span>你的非秘密编辑内容仍然保留；刷新后请重新确认再提交，WebUI 不会自动覆盖。</span>
        {currentRevision ? (
          <span className="mono text-sm">服务端最新 revision：{currentRevision}</span>
        ) : null}
        <div>
          <button type="button" className="btn btn--sm btn--secondary" onClick={onReload}>
            重新读取最新版本
          </button>
        </div>
      </div>
    </div>
  );
}
