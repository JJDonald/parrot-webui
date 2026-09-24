/**
 * 任务中心面板：展示本浏览器已发起或已获知 ID 的任务。
 *
 * 约束（实施文档 6.9）：没有全局任务列表接口时，不显示"所有历史任务"；
 * 只在 cancellable=true 时允许取消；终态后停止轮询；404 时不自动重做任务。
 */

import { useState } from 'react';
import {
  isTerminal,
  operationStatusLabel,
  operationStatusTone,
  useOperations,
  type OperationRecord,
} from '@/api/operations';
import { JsonBlock, Pill, RelativeTime } from './bits';
import { EmptyState } from './state';

function progressText(operation: OperationRecord): string {
  if (operation.progress === null) return '无进度上报';
  return `${Math.round(operation.progress * 100)}%`;
}

function OperationRow({ operation }: { operation: OperationRecord }) {
  const { cancel, dismiss } = useOperations();
  const [expanded, setExpanded] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const tone = operationStatusTone(operation.status);

  return (
    <div className="keeper-table">
      <div className="keeper-table__row" style={{ borderTop: 0, cursor: 'default' }}>
        <div className="cell" style={{ justifyContent: 'space-between' }}>
          <div className="cell">
            <Pill tone={tone}>{operationStatusLabel(operation.status)}</Pill>
            <span className="mono text-sm">{operation.id}</span>
            {operation.kind ? <Pill>{operation.kind}</Pill> : null}
            <span className="text-secondary text-sm">来源：{operation.origin}</span>
          </div>
          <div className="cell">
            <span className="text-sm text-secondary">{progressText(operation)}</span>
            <span className="text-sm text-secondary">
              创建 <RelativeTime value={operation.createdAt} />
            </span>
            <button type="button" className="btn btn--sm btn--ghost" onClick={() => setExpanded((value) => !value)}>
              {expanded ? '收起' : '详情'}
            </button>
            {operation.cancellable && !isTerminal(operation.status) ? (
              <button
                type="button"
                className="btn btn--sm btn--secondary"
                disabled={cancelling}
                onClick={async () => {
                  setCancelling(true);
                  try {
                    await cancel(operation.id);
                  } finally {
                    setCancelling(false);
                  }
                }}
              >
                申请取消
              </button>
            ) : null}
            {isTerminal(operation.status) ? (
              <button type="button" className="btn btn--sm btn--ghost" onClick={() => dismiss(operation.id)}>
                移除
              </button>
            ) : null}
          </div>
        </div>
        {operation.partialNotice ? (
          <div className="notice-box notice-box--warning" style={{ marginTop: 8 }}>
            {operation.partialNotice}
          </div>
        ) : null}
        {operation.lastError ? (
          <div className="error-box" style={{ marginTop: 8 }} role="alert">
            [{operation.lastError.code}] {operation.lastError.message}
          </div>
        ) : null}
        {operation.error ? (
          <div className="error-box" style={{ marginTop: 8 }} role="alert">
            [{operation.error.code ?? 'OPERATION_FAILED'}] {operation.error.message ?? '任务失败'}
          </div>
        ) : null}
        {expanded ? (
          <div style={{ marginTop: 10 }}>
            <div className="row text-sm text-secondary" style={{ marginBottom: 6 }}>
              <span>
                开始：<RelativeTime value={operation.startedAt} />
              </span>
              <span>
                结束：<RelativeTime value={operation.finishedAt} />
              </span>
              <span>可取消：{operation.cancellable ? '是' : '否'}</span>
            </div>
            <JsonBlock value={operation.result} maxHeight={240} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function OperationTrackerPanel({ limit = 20 }: { limit?: number }) {
  const { operations, clearFinished } = useOperations();
  const visible = operations.slice(0, limit);

  if (!visible.length) {
    return (
      <EmptyState
        title="当前没有进行中的任务"
        description="这里只显示本浏览器通过管理台发起或已知 ID 的任务；上游没有提供全局任务列表接口，因此不展示其他端的历史任务。"
      />
    );
  }

  const hasFinished = visible.some((operation) => isTerminal(operation.status));

  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="row row--between">
        <span className="text-secondary text-sm">
          仅本浏览器可见，共 {operations.length} 条（保留最近 30 条）；离开页面后不再跟踪。
        </span>
        {hasFinished ? (
          <button type="button" className="btn btn--sm btn--ghost" onClick={clearFinished}>
            清理已结束
          </button>
        ) : null}
      </div>
      {visible.map((operation) => (
        <OperationRow key={operation.id} operation={operation} />
      ))}
    </div>
  );
}

/** 顶栏用的紧凑指示：有进行中任务时显示数量。 */
export function OperationIndicator() {
  const { operations } = useOperations();
  const active = operations.filter((operation) => !isTerminal(operation.status)).length;
  if (!active) return null;
  return <Pill tone="primary">{active} 个任务进行中</Pill>;
}
