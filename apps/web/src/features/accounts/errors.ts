/**
 * 本域的错误归一化：把任意抛出物转成 ApiError，保留上游业务错误与 WebUI 传输错误的区分。
 * 不在这里做重试决定，重试策略统一由 @/api/hooks 与调用方处理。
 */

import { ApiError } from '@/api/client';

export function toApiError(error: unknown, fallbackMessage = '请求失败：无法确认上游结果'): ApiError {
  if (error instanceof ApiError) return error;
  return new ApiError({
    status: 0,
    code: 'WEBUI_NETWORK_ERROR',
    source: 'network',
    message: fallbackMessage,
    retryable: true,
  });
}
