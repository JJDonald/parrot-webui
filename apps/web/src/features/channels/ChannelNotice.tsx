/**
 * 渠道页面内的结果提示。
 *
 * 规则（前端契约 §4 / 实施文档 7.3）：
 * - 202 只能显示"已受理"，并给出任务 ID，绝不能写成成功。
 * - 同步 200/201/204 的结果按真实字段展示。
 */

import type { ReactNode } from 'react';
import { operationStatusLabel } from '@/api/operations';
import type { AcceptedOperation } from './channelsApi';

export type NoticeTone = 'info' | 'success' | 'warning';

export interface ChannelNotice {
  tone: NoticeTone;
  text: ReactNode;
}

export function ChannelNoticeBox({ notice }: { notice: ChannelNotice }) {
  const className = notice.tone === 'warning' ? 'notice-box notice-box--warning' : 'notice-box';
  return (
    <div className={className} role="status">
      <span>{notice.text}</span>
    </div>
  );
}

/** 202 受理提示：只描述"已受理 + 任务 ID"，不宣布成功。 */
export function acceptedOperationNotice(label: string, accepted: AcceptedOperation): ChannelNotice {
  return {
    tone: 'warning',
    text: (
      <>
        {label}：上游<strong>已受理</strong>（HTTP 202），任务 ID <span className="mono">{accepted.operationId}</span>
        {accepted.kind ? (
          <>
            ，kind <span className="mono">{accepted.kind}</span>
          </>
        ) : null}
        ，受理时状态「{operationStatusLabel(accepted.status)}」。202 仅代表已受理，进度与结果请在「管理任务」页面查看；
        该动作如果失败，本页不会自动重做。
      </>
    ),
  };
}

/** 上游返回了与契约不符的同步结果时的提示（不冒充成功）。 */
export function unexpectedSyncResultNotice(label: string, status: number): ChannelNotice {
  return {
    tone: 'warning',
    text: (
      <>
        {label}：上游返回了 HTTP {status} 的同步响应。该端点在冻结契约里应为 202 异步受理，
        请核对本机 Parrot 版本与 WebUI 契约快照；下面的原始内容按上游真实字段展示。
      </>
    ),
  };
}
