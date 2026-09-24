/**
 * 请求日志页的提示条：敏感正文声明、体积上限（未完整展示）、权限/连接状态说明。
 *
 * 说明（实施文档 6.8）：
 * - 原始正文可能包含敏感字段，WebUI 不保证上游已全部脱敏，也不做自动全量导出；
 * - 命中体积上限时必须明确说"未完整展示"，不能假称已完整展示。
 */

import type { ReactNode } from 'react';
import type { ApiError } from '@/api/client';
import { ErrorNotice } from '@/components/feedback';
import { isPermissionDenied, isTransportFailure } from '@/components/state';
import { LOG_BODY_CAPABILITY, LOG_LIST_CAPABILITY, isSizeLimitError, sizeLimitReason } from './logTypes';
import styles from './logs.module.scss';

/** 敏感数据与 XSS 口径的固定声明：页面与详情抽屉都会展示。 */
export function SensitiveBodyNotice({ compact = false }: { compact?: boolean }) {
  return (
    <div className="notice-box notice-box--warning" role="note" data-compact={compact ? 'true' : 'false'}>
      <div className="stack" style={{ gap: 4 }}>
        <strong>请谨慎查看原始正文</strong>
        <span>
          请求/响应正文与原始 JSON 可能包含敏感字段（Authorization、API Key、提示词、用户内容等）。
          WebUI 不会自动脱敏，也无法保证上游已全部脱敏；正文默认不加载，只在你主动展开时按需读取，
          且一律作为<strong>纯文本/受控 JSON</strong>渲染，其中的 HTML 或 <code>&lt;script&gt;</code> 只会显示为文字。
        </span>
        <span>本页面不提供自动全量导出，请按时间范围、筛选条件与分页查看。</span>
      </div>
    </div>
  );
}

/** 体积上限：明确"未完整展示"，并给出缩小范围的建议。 */
export function TruncationNotice({ reason, title = '未完整展示' }: { reason: ReactNode; title?: string }) {
  return (
    <div className={`notice-box notice-box--warning ${styles.truncation}`} role="alert">
      <div className="stack" style={{ gap: 4 }}>
        <strong>{title}</strong>
        <span>{reason}</span>
      </div>
    </div>
  );
}

/** 正文读取能力被上游能力清单排除时的说明（不发起请求）。 */
export function CapabilityNotice({ reason }: { reason: string }) {
  return (
    <div className="notice-box notice-box--warning" role="status">
      <div className="stack" style={{ gap: 4 }}>
        <strong>只读受限：正文读取已禁用</strong>
        <span>{reason}</span>
        <span>日志摘要（创建时间、状态、渠道、模型、Token 等）仍可查看。</span>
      </div>
    </div>
  );
}

/**
 * 列表状态说明：把"权限不足"与"连接中断"和普通业务失败区分开，
 * 具体错误码/字段仍由 ErrorNotice 展示（这里只补充原因与下一步）。
 */
export function LogListStateNotice({ error }: { error: ApiError | null | undefined }) {
  if (!error) return null;

  if (isPermissionDenied(error)) {
    return (
      <div className="notice-box notice-box--warning" role="status">
        <div className="stack" style={{ gap: 4 }}>
          <strong>权限不足：无法读取请求日志</strong>
          <span>
            上游返回 {error.code}（HTTP {error.status}）。当前会话仍然有效，但缺少读取日志所需的能力
            （{LOG_LIST_CAPABILITY}）；请让实例管理员为该管理凭据授权后重试，WebUI 不会绕过上游校验。
          </span>
          <span>页面保留登录状态，未做任何自动重试或降级伪装。</span>
        </div>
      </div>
    );
  }

  if (isTransportFailure(error)) {
    return (
      <div className="notice-box notice-box--warning" role="status">
        <div className="stack" style={{ gap: 4 }}>
          <strong>连接中断：WebUI 与 Parrot 之间的链路异常</strong>
          <span>
            错误码 {error.code}（HTTP {error.status}）。这属于 WebUI 到本机 Parrot 管理 API 的传输问题，
            不是"没有日志"；请确认原实例仍在运行与可达，然后手动重试。
          </span>
        </div>
      </div>
    );
  }

  if (isSizeLimitError(error)) {
    return <TruncationNotice reason={sizeLimitReason(error)} title="未完整展示：日志列表响应超过体积上限" />;
  }

  return null;
}

/** 日志正文（body / item / raw-body）加载失败时的统一展示：ErrorNotice + 体积上限提示。 */
export function BodyErrorNotice({ error, onRetry }: { error: ApiError; onRetry?: () => void }) {
  return (
    <div className="stack" style={{ gap: 8 }}>
      {isSizeLimitError(error) ? <TruncationNotice reason={sizeLimitReason(error)} /> : null}
      <ErrorNotice error={error} onRetry={onRetry} />
    </div>
  );
}

/** 提示：正文读取使用的能力码，方便排错。 */
export function bodyCapabilityHint(): string {
  return `正文接口需要上游能力 ${LOG_BODY_CAPABILITY}。`;
}
