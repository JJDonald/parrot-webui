/**
 * BFF 自有错误模型。
 *
 * 关键区分（实施文档 5.4 / 7.4）：上游返回的业务错误原样透传（保留 Parrot 的 code/fields/requestId），
 * BFF 自己的传输与安全错误使用独立的 WEBUI_* code，并带 `source: "webui"` 标记，
 * 前端据此区分"Parrot 业务失败"与"WebUI 到 Parrot 的传输失败"。
 */

export type WebuiErrorCode =
  | 'WEBUI_SESSION_REQUIRED'
  | 'WEBUI_SESSION_EXPIRED'
  | 'WEBUI_CSRF_REJECTED'
  | 'WEBUI_ORIGIN_REJECTED'
  | 'WEBUI_HOST_REJECTED'
  | 'WEBUI_METHOD_NOT_ALLOWED'
  | 'WEBUI_ROUTE_NOT_ALLOWED'
  | 'WEBUI_UNSUPPORTED_CONTENT_TYPE'
  | 'WEBUI_INVALID_REQUEST'
  | 'WEBUI_PAYLOAD_TOO_LARGE'
  | 'WEBUI_RATE_LIMITED'
  | 'WEBUI_CAPACITY_EXCEEDED'
  | 'WEBUI_UPSTREAM_UNREACHABLE'
  | 'WEBUI_UPSTREAM_TIMEOUT'
  | 'WEBUI_UPSTREAM_UNEXPECTED_CONTENT'
  | 'WEBUI_UPSTREAM_REDIRECT_BLOCKED'
  | 'WEBUI_RESPONSE_TOO_LARGE'
  | 'WEBUI_NOT_FOUND'
  | 'WEBUI_NOT_READY'
  | 'WEBUI_INTERNAL';

const STATUS_BY_CODE: Record<WebuiErrorCode, number> = {
  WEBUI_SESSION_REQUIRED: 401,
  WEBUI_SESSION_EXPIRED: 401,
  WEBUI_CSRF_REJECTED: 403,
  WEBUI_ORIGIN_REJECTED: 403,
  WEBUI_HOST_REJECTED: 421,
  WEBUI_METHOD_NOT_ALLOWED: 405,
  WEBUI_ROUTE_NOT_ALLOWED: 404,
  WEBUI_UNSUPPORTED_CONTENT_TYPE: 415,
  WEBUI_INVALID_REQUEST: 400,
  WEBUI_PAYLOAD_TOO_LARGE: 413,
  WEBUI_RATE_LIMITED: 429,
  WEBUI_CAPACITY_EXCEEDED: 429,
  WEBUI_UPSTREAM_UNREACHABLE: 502,
  WEBUI_UPSTREAM_TIMEOUT: 504,
  WEBUI_UPSTREAM_UNEXPECTED_CONTENT: 502,
  WEBUI_UPSTREAM_REDIRECT_BLOCKED: 502,
  WEBUI_RESPONSE_TOO_LARGE: 502,
  WEBUI_NOT_FOUND: 404,
  WEBUI_NOT_READY: 503,
  WEBUI_INTERNAL: 500,
};

const RETRYABLE_BY_CODE: Partial<Record<WebuiErrorCode, boolean>> = {
  WEBUI_RATE_LIMITED: true,
  WEBUI_CAPACITY_EXCEEDED: true,
  WEBUI_UPSTREAM_UNREACHABLE: true,
  WEBUI_UPSTREAM_TIMEOUT: true,
  WEBUI_NOT_READY: true,
};

export interface WebuiErrorOptions {
  readonly message?: string;
  readonly retryable?: boolean;
  readonly retryAfterSeconds?: number;
  readonly details?: Record<string, unknown>;
  readonly cause?: unknown;
}

export class WebuiError extends Error {
  readonly code: WebuiErrorCode;
  readonly status: number;
  readonly retryable: boolean;
  readonly retryAfterSeconds?: number;
  readonly details?: Record<string, unknown>;

  constructor(code: WebuiErrorCode, options: WebuiErrorOptions = {}) {
    super(options.message ?? defaultMessage(code));
    this.name = 'WebuiError';
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    this.retryable = options.retryable ?? RETRYABLE_BY_CODE[code] ?? false;
    if (options.retryAfterSeconds !== undefined) this.retryAfterSeconds = options.retryAfterSeconds;
    if (options.details) this.details = options.details;
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

function defaultMessage(code: WebuiErrorCode): string {
  switch (code) {
    case 'WEBUI_SESSION_REQUIRED':
      return '需要先登录管理台';
    case 'WEBUI_SESSION_EXPIRED':
      return '本地会话已过期或被上游判定失效，请重新登录';
    case 'WEBUI_CSRF_REJECTED':
      return 'CSRF 校验未通过，请刷新页面后重试';
    case 'WEBUI_ORIGIN_REJECTED':
      return '请求来源不被信任';
    case 'WEBUI_HOST_REJECTED':
      return '请求 Host 与部署域名不一致';
    case 'WEBUI_METHOD_NOT_ALLOWED':
      return '该管理操作不允许使用此 HTTP 方法';
    case 'WEBUI_ROUTE_NOT_ALLOWED':
      return '该管理操作不在 WebUI 允许清单内';
    case 'WEBUI_UNSUPPORTED_CONTENT_TYPE':
      return '请求内容类型不受支持';
    case 'WEBUI_INVALID_REQUEST':
      return '请求参数不合法';
    case 'WEBUI_PAYLOAD_TOO_LARGE':
      return '请求体超过限制';
    case 'WEBUI_RATE_LIMITED':
      return '请求过于频繁，请稍后重试';
    case 'WEBUI_CAPACITY_EXCEEDED':
      return '当前登录/预登录数量已达上限，请稍后重试';
    case 'WEBUI_UPSTREAM_UNREACHABLE':
      return '无法连接本机 Parrot 管理 API';
    case 'WEBUI_UPSTREAM_TIMEOUT':
      return '等待 Parrot 管理 API 响应超时；写操作结果未知，请刷新确认';
    case 'WEBUI_UPSTREAM_UNEXPECTED_CONTENT':
      return 'Parrot 返回了非 JSON 内容，已被 WebUI 转换为结构化错误';
    case 'WEBUI_UPSTREAM_REDIRECT_BLOCKED':
      return 'Parrot 返回了重定向，BFF 不会携带凭据跟随';
    case 'WEBUI_RESPONSE_TOO_LARGE':
      return '上游响应超过 WebUI 允许的体积上限';
    case 'WEBUI_NOT_FOUND':
      return '请求的页面或接口不存在';
    case 'WEBUI_NOT_READY':
      return 'WebUI 尚未就绪';
    default:
      return 'WebUI 内部错误';
  }
}

export interface WebuiErrorBody {
  error: {
    code: WebuiErrorCode;
    message: string;
    retryable: boolean;
    requestId: string;
    source: 'webui';
    details?: Record<string, unknown>;
  };
}

export function webuiErrorBody(error: WebuiError, requestId: string): WebuiErrorBody {
  return {
    error: {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      requestId,
      source: 'webui',
      ...(error.details ? { details: error.details } : {}),
    },
  };
}

/** 响应头：显式标注错误来源，前端不依赖字符串猜测。 */
export const ERROR_SOURCE_HEADER = 'x-webui-error-source';
