/**
 * 异步任务（operation）跟踪。
 *
 * 上游语义（实施文档 7.3）：202 只代表已受理；状态枚举
 * queued | running | succeeded | failed | cancelled；progress 可能为 null（不要伪造百分比）；
 * 只有 cancellable=true 才允许取消；404 表示任务记录已不可用（实例可能重启），
 * 此时刷新业务资源但绝不自动重做任务。
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError, encodeSegment, managementRequest } from './client';
import { useAuth } from '@/app/AuthProvider';
export type OperationStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'unavailable';

export interface OperationRecord {
  id: string;
  kind: string | null;
  status: OperationStatus;
  progress: number | null;
  cancellable: boolean;
  createdAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  result: unknown;
  error: { code?: string; message?: string } | null;
  /** 任务创建来源（页面上显示的上下文），仅本地内存。 */
  origin: string;
  /** 关联的资源刷新键，任务结束后失效。 */
  invalidate: readonly unknown[][];
  /** succeeded 但部分来源失败时的说明。 */
  partialNotice: string | null;
  lastError: { code: string; message: string } | null;
}

interface OperationContextValue {
  operations: OperationRecord[];
  track: (input: { operationId: string; kind?: string | null; origin: string; invalidate?: readonly unknown[][] }) => void;
  cancel: (operationId: string) => Promise<void>;
  dismiss: (operationId: string) => void;
  clearFinished: () => void;
}

const OperationContext = createContext<OperationContextValue | null>(null);

function normalizeStatus(raw: unknown): OperationStatus {
  const value = typeof raw === 'string' ? raw.toLowerCase() : '';
  switch (value) {
    case 'queued':
    case 'running':
    case 'succeeded':
    case 'failed':
    case 'cancelled':
      return value;
    default:
      return 'running';
  }
}

/** 从上游 result 中提取"部分成功"信息：succeeded 仍可能包含逐来源失败。 */
function detectPartial(result: unknown): string | null {
  if (!result || typeof result !== 'object') return null;
  const record = result as Record<string, unknown>;
  const failures = ['failures', 'failed', 'errors', 'skipped']
    .map((key) => record[key])
    .find((value) => Array.isArray(value) && value.length > 0) as unknown[] | undefined;
  if (!failures) return null;
  return `任务整体成功，但有 ${failures.length} 项来源未成功；详情见任务结果`;
}

const POLL_SEQUENCE = [1000, 2000, 5000];

export function OperationProvider({ children }: { children: ReactNode }) {
  const [operations, setOperations] = useState<OperationRecord[]>([]);
  const timers = useRef(new Map<string, number>());
  const attempts = useRef(new Map<string, number>());
  const queryClient = useQueryClient();

  const stop = useCallback((id: string) => {
    const timer = timers.current.get(id);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const poll = useCallback(
    async (id: string) => {
      const attempt = attempts.current.get(id) ?? 0;
      try {
        const response = await managementRequest<Record<string, unknown>>(`/operations/${encodeSegment(id)}`);
        const data = (response.data ?? {}) as Record<string, unknown>;
        const status = normalizeStatus(data.status);

        setOperations((previous) =>
          previous.map((operation) =>
            operation.id === id
              ? {
                  ...operation,
                  kind: typeof data.kind === 'string' ? data.kind : operation.kind,
                  status,
                  progress: typeof data.progress === 'number' ? data.progress : null,
                  cancellable: Boolean(data.cancellable),
                  createdAt: typeof data.createdAt === 'string' ? data.createdAt : operation.createdAt,
                  startedAt: typeof data.startedAt === 'string' ? data.startedAt : operation.startedAt,
                  finishedAt: typeof data.finishedAt === 'string' ? data.finishedAt : operation.finishedAt,
                  result: data.result ?? null,
                  error: (data.error as OperationRecord['error']) ?? null,
                  partialNotice: status === 'succeeded' ? detectPartial(data.result) : null,
                  lastError: null,
                }
              : operation,
          ),
        );

        if (status === 'queued' || status === 'running') {
          const delay = POLL_SEQUENCE[Math.min(attempt, POLL_SEQUENCE.length - 1)]!;
          attempts.current.set(id, attempt + 1);
          timers.current.set(
            id,
            window.setTimeout(() => void poll(id), delay),
          );
        } else {
          stop(id);
          attempts.current.delete(id);
          const record = operations.find((operation) => operation.id === id);
          for (const key of record?.invalidate ?? []) {
            await queryClient.invalidateQueries({ queryKey: key });
          }
        }
      } catch (error) {
        const apiError = error instanceof ApiError ? error : null;
        if (apiError?.status === 404) {
          stop(id);
          setOperations((previous) =>
            previous.map((operation) =>
              operation.id === id
                ? {
                    ...operation,
                    status: 'unavailable',
                    lastError: {
                      code: 'OPERATION_NOT_FOUND',
                      message: '任务记录不可用（可能已过期或原实例重启）；请刷新业务资源确认实际状态',
                    },
                  }
                : operation,
            ),
          );
          const record = operations.find((operation) => operation.id === id);
          for (const key of record?.invalidate ?? []) {
            await queryClient.invalidateQueries({ queryKey: key });
          }
          return;
        }
        // 中间失败采用有界退避，不放弃观察
        if (attempt < 6) {
          attempts.current.set(id, attempt + 1);
          const delay = Math.min(30_000, 2000 * 2 ** attempt);
          timers.current.set(
            id,
            window.setTimeout(() => void poll(id), delay),
          );
          setOperations((previous) =>
            previous.map((operation) =>
              operation.id === id
                ? {
                    ...operation,
                    lastError: {
                      code: apiError?.code ?? 'WEBUI_NETWORK_ERROR',
                      message: apiError?.message ?? '读取任务状态失败，正在重试',
                    },
                  }
                : operation,
            ),
          );
        } else {
          stop(id);
          setOperations((previous) =>
            previous.map((operation) =>
              operation.id === id
                ? {
                    ...operation,
                    status: 'unavailable',
                    lastError: {
                      code: apiError?.code ?? 'WEBUI_NETWORK_ERROR',
                      message: '长时间无法读取任务状态，已停止轮询；请手动刷新确认结果',
                    },
                  }
                : operation,
            ),
          );
        }
      }
    },
    [operations, queryClient, stop],
  );

  const track = useCallback<OperationContextValue['track']>(
    ({ operationId, kind, origin, invalidate }) => {
      setOperations((previous) => {
        const existing = previous.find((operation) => operation.id === operationId);
        if (existing) {
          return previous.map((operation) =>
            operation.id === operationId
              ? { ...operation, invalidate: invalidate ?? operation.invalidate }
              : operation,
          );
        }
        return [
          {
            id: operationId,
            kind: kind ?? null,
            status: 'queued' as OperationStatus,
            progress: null,
            cancellable: false,
            createdAt: new Date().toISOString(),
            startedAt: null,
            finishedAt: null,
            result: null,
            error: null,
            origin,
            invalidate: invalidate ?? [],
            partialNotice: null,
            lastError: null,
          },
          ...previous,
        ].slice(0, 30);
      });
      attempts.current.set(operationId, 0);
      stop(operationId);
      void poll(operationId);
    },
    [poll, stop],
  );

  const cancel = useCallback(
    async (operationId: string) => {
      // 只申请取消；终态仍以真实查询结果为准
      await managementRequest(`/operations/${encodeSegment(operationId)}`, { method: 'DELETE' });
      attempts.current.set(operationId, 0);
      void poll(operationId);
    },
    [poll],
  );

  const dismiss = useCallback(
    (operationId: string) => {
      stop(operationId);
      attempts.current.delete(operationId);
      setOperations((previous) => previous.filter((operation) => operation.id !== operationId));
    },
    [stop],
  );

  const clearFinished = useCallback(() => {
    setOperations((previous) =>
      previous.filter((operation) => operation.status === 'queued' || operation.status === 'running'),
    );
  }, []);

  // 注销或会话失效时清理全部任务关联（实施文档 6.9：退出时清理）
  const { status } = useAuth();
  useEffect(() => {
    if (status === 'anonymous') {
      for (const timer of timers.current.values()) window.clearTimeout(timer);
      timers.current.clear();
      attempts.current.clear();
      setOperations([]);
    }
  }, [status]);

  useEffect(
    () => () => {
      for (const timer of timers.current.values()) window.clearTimeout(timer);
      timers.current.clear();
    },
    [],
  );

  const value = useMemo<OperationContextValue>(
    () => ({ operations, track, cancel, dismiss, clearFinished }),
    [operations, track, cancel, dismiss, clearFinished],
  );

  return <OperationContext.Provider value={value}>{children}</OperationContext.Provider>;
}

export function useOperations(): OperationContextValue {
  const context = useContext(OperationContext);
  if (!context) throw new Error('useOperations 必须在 OperationProvider 内使用');
  return context;
}

const STATUS_LABEL: Record<OperationStatus, string> = {
  queued: '排队中',
  running: '执行中',
  succeeded: '成功',
  failed: '失败',
  cancelled: '已取消',
  unavailable: '状态不可用',
};

export function operationStatusLabel(status: OperationStatus): string {
  return STATUS_LABEL[status];
}

export function operationStatusTone(status: OperationStatus): 'primary' | 'success' | 'warning' | 'danger' | 'muted' {
  switch (status) {
    case 'running':
    case 'queued':
      return 'primary';
    case 'succeeded':
      return 'success';
    case 'cancelled':
      return 'warning';
    case 'failed':
      return 'danger';
    default:
      return 'muted';
  }
}

export function isTerminal(status: OperationStatus): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled' || status === 'unavailable';
}
