/**
 * TanStack Query 封装：查询/变更统一走 BFF 客户端，并落实文档要求的重试与轮询策略。
 *
 * 规则（实施文档 7.x / 11.2）：
 * - mutation 永不自动重试；写结果未知时提示刷新确认，不自动重发。
 * - query 只对短暂的传输类错误做有限重试（最多 2 次）。
 * - 轮询：只在页面可见时按间隔刷新，页面进入后台暂停或显著降频。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryKey,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import {
  ApiError,
  managementRequest,
  type ManagementResponse,
  type RequestOptions,
} from './client';
import { TRANSPORT_ERROR_CODES } from './error-codes';

export const DEFAULT_LIST_PAGE_SIZE = 20;

/** 页面可见性轮询：后台标签页停止高频轮询。 */
export function usePollingInterval(activeMs: number, options: { enabled?: boolean } = {}): number | false {
  const [visible, setVisible] = useState(() =>
    typeof document === 'undefined' ? true : document.visibilityState === 'visible',
  );

  useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    const onChange = () => setVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  }, []);

  if (options.enabled === false) return false;
  // 后台时降频到 5 分钟一次，只用于维持"上次成功刷新时间"，不做高频请求。
  return visible ? activeMs : 300_000;
}

/** 最近一次成功刷新的时间戳，用于"数据可能已过期"提示。 */
export function useLastSuccessAt(result: Pick<UseQueryResult, 'dataUpdatedAt'>): Date | null {
  const timestamp = result.dataUpdatedAt;
  return timestamp ? new Date(timestamp) : null;
}

export interface ApiQueryOptions {
  key: QueryKey;
  /** 相对管理前缀的路径，例如 /channels 或 /channels/abc */
  path: string;
  query?: Record<string, string | number | boolean | undefined | null>;
  enabled?: boolean;
  refetchInterval?: number | false;
  staleTimeMs?: number;
}

export function useApiQuery<T>(options: ApiQueryOptions): UseQueryResult<ManagementResponse<T>, ApiError> {
  return useQuery<ManagementResponse<T>, ApiError>({
    queryKey: options.key,
    enabled: options.enabled ?? true,
    refetchInterval: options.refetchInterval ?? false,
    staleTime: options.staleTimeMs ?? 5_000,
    retry: (failureCount, error) => {
      if (failureCount >= 2) return false;
      return TRANSPORT_ERROR_CODES.includes(error.code) && error.retryable;
    },
    retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 5000),
    // 管理读取：path 相对 /bff/management，前缀由 managementRequest 统一补上
    queryFn: ({ signal }) => managementRequest<T>(options.path, { query: options.query, signal }),
  });
}

export interface ApiMutationOptions<TInput, TResult> {
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** 由输入推导请求路径，注意对资源 ID 使用 encodeSegment */
  path: (input: TInput) => string;
  /** 成功需要刷新的查询键前缀，例如 [['channels'], ['overview']] */
  invalidate?: QueryKey[];
  body?: (input: TInput) => unknown;
  ifMatch?: (input: TInput) => string | undefined;
  idempotencyKey?: (input: TInput) => string | undefined;
}

export function useApiMutation<TInput, TResult>(
  options: ApiMutationOptions<TInput, TResult>,
): UseMutationResult<ManagementResponse<TResult>, ApiError, TInput> {
  const queryClient = useQueryClient();
  return useMutation<ManagementResponse<TResult>, ApiError, TInput>({
    // 文档要求：mutation 不得自动重试
    retry: false,
    mutationFn: (input: TInput) => {
      const requestOptions: RequestOptions = {
        method: options.method,
        body: options.body ? options.body(input) : input,
        ifMatch: options.ifMatch?.(input),
        idempotencyKey: options.idempotencyKey?.(input),
      };
      // 管理写入：同样走 managementRequest，绝不落到 /webui/<管理路径>
      return managementRequest<TResult>(options.path(input), requestOptions);
    },
    onSuccess: async () => {
      for (const key of options.invalidate ?? []) {
        await queryClient.invalidateQueries({ queryKey: key });
      }
    },
  });
}

/** 手动刷新一组查询键；用于"失败后保留上次快照并手动重试"。 */
export function useRefresh(): (keys: QueryKey[]) => Promise<void> {
  const queryClient = useQueryClient();
  return useCallback(
    async (keys: QueryKey[]) => {
      await Promise.all(keys.map((key) => queryClient.invalidateQueries({ queryKey: key })));
    },
    [queryClient],
  );
}

/** 清理全部查询缓存：注销或会话失效时必须调用，避免残留上一个会话的数据。 */
export function useClearAllQueries(): () => void {
  const queryClient = useQueryClient();
  return useCallback(() => queryClient.clear(), [queryClient]);
}

/** 表单字段错误映射：把上游 fields 转成 path -> message。 */
export function fieldErrors(error: ApiError | null | undefined): Record<string, string> {
  if (!error) return {};
  const map: Record<string, string> = {};
  for (const field of error.fields) {
    if (!map[field.path]) map[field.path] = field.message || field.code;
  }
  return map;
}

/** 供表单使用：把输入框值与远端字段错误合并。 */
export function useFieldErrorMap(error: ApiError | null | undefined): Record<string, string> {
  const ref = useRef<Record<string, string>>({});
  const next = fieldErrors(error);
  const nextKey = JSON.stringify(next);
  if (JSON.stringify(ref.current) !== nextKey) ref.current = next;
  return ref.current;
}

/** 提交中锁：只锁住当前提交动作，不长期锁住整页。 */
export function useSubmitLock(): [boolean, <T>(task: () => Promise<T>) => Promise<T | undefined>] {
  const [pending, setPending] = useState(false);
  const run = useCallback(async <T,>(task: () => Promise<T>) => {
    setPending(true);
    try {
      return await task();
    } finally {
      setPending(false);
    }
  }, []);
  return [pending, run];
}
