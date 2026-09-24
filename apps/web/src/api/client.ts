/**
 * 唯一的 BFF 客户端。所有页面必须通过这里访问后端，不要散落手写 fetch。
 *
 * 约定：
 * - 基址来自 Vite base（/webui/）；管理接口另有 /bff/management 前缀。
 * - requestJson() 的 path 相对 /webui（用于 /bff/* 这类 BFF 自带接口）；
 *   managementRequest() 的 path 相对 /bff/management（页面层的管理读写一律用它）。
 * - 写操作自动带上 X-CSRF-Token（只保存在内存，不进 localStorage）。
 * - 错误统一归一化为 ApiError，并保留"上游业务错误"与"WebUI 传输错误"的区分。
 */

import type { WebuiErrorCode } from './error-codes';

/** BFF 业务代理前缀（浏览器侧）；上游前缀由 BFF 负责拼接。 */
export const MANAGEMENT_PREFIX = '/bff/management';

export interface ApiFieldError {
  path: string;
  code: string;
  message: string;
}

export type ApiErrorSource = 'upstream' | 'webui' | 'network';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly source: ApiErrorSource;
  readonly retryable: boolean;
  readonly requestId: string | null;
  readonly retryAfterSeconds: number | null;
  readonly fields: ApiFieldError[];
  readonly operationId: string | null;
  readonly payload: unknown;

  constructor(init: {
    status: number;
    code: string;
    source: ApiErrorSource;
    message: string;
    retryable?: boolean;
    requestId?: string | null;
    retryAfterSeconds?: number | null;
    fields?: ApiFieldError[];
    operationId?: string | null;
    payload?: unknown;
  }) {
    super(init.message);
    this.name = 'ApiError';
    this.status = init.status;
    this.code = init.code;
    this.source = init.source;
    this.retryable = init.retryable ?? false;
    this.requestId = init.requestId ?? null;
    this.retryAfterSeconds = init.retryAfterSeconds ?? null;
    this.fields = init.fields ?? [];
    this.operationId = init.operationId ?? null;
    this.payload = init.payload;
  }

  /** 会话失效（本地或上游）：调用方应清理会话并跳转登录。 */
  get isSessionLost(): boolean {
    return (
      this.code === 'WEBUI_SESSION_REQUIRED' ||
      this.code === 'WEBUI_SESSION_EXPIRED' ||
      this.code === 'SESSION_REQUIRED' ||
      this.code === 'SESSION_EXPIRED' ||
      this.status === 401
    );
  }

  /** 上游业务错误（Parrot 返回），需要原样展示 Parrot 的 code/fields。 */
  get isUpstreamBusinessError(): boolean {
    return this.source === 'upstream';
  }
}

export interface ManagementResponse<T> {
  status: number;
  data: T | null;
  meta: Record<string, unknown>;
  /** 从 meta.revision 提取的版本号，写操作需原样回传 If-Match。 */
  revision: string | null;
  raw: unknown;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null>;
  ifMatch?: string | undefined;
  idempotencyKey?: string | undefined;
  signal?: AbortSignal;
  /** 覆盖默认超时（只有上游明确需要同步等待的少数操作才使用）。 */
  timeoutMs?: number;
  /**
   * 该请求自身的 401 不应触发全局「会话已失效」处理：登录时用错凭据返回的 401
   * 只代表这一次换票失败，不代表已有会话失效（否则登录页会显示误导性的失效提示）。
   */
  suppressSessionLost?: boolean;
}

interface ClientState {
  csrfToken: string | null;
  onSessionLost: (() => void) | null;
}

const state: ClientState = { csrfToken: null, onSessionLost: null };

export function setCsrfToken(token: string | null): void {
  state.csrfToken = token;
}

export function getCsrfToken(): string | null {
  return state.csrfToken;
}

export function setSessionLostHandler(handler: (() => void) | null): void {
  state.onSessionLost = handler;
}

/** 把相对管理路径（如 /channels/abc）拼成浏览器可访问的绝对 URL。 */
export function webuiUrl(path: string): string {
  const base = (import.meta.env.BASE_URL || '/webui/').replace(/\/+$/, '');
  return `${base}${path.startsWith('/') ? path : `/${path}`}`;
}

export function managementUrl(path: string): string {
  return webuiUrl(`${MANAGEMENT_PREFIX}${path.startsWith('/') ? path : `/${path}`}`);
}

/** 资源 ID 必须按路径分段编码；不要整体编码斜杠或拼接多个分段。 */
export function encodeSegment(value: string): string {
  return encodeURIComponent(value);
}

export function buildQueryString(query: Record<string, string | number | boolean | undefined | null> = {}): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    params.append(key, String(value));
  }
  const encoded = params.toString();
  return encoded ? `?${encoded}` : '';
}

function extractRequestId(payload: unknown, response: Response): string | null {
  const header = response.headers.get('x-request-id');
  if (header) return header;
  if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>;
    const meta = record.meta as Record<string, unknown> | undefined;
    if (meta && typeof meta.requestId === 'string') return meta.requestId;
    const error = record.error as Record<string, unknown> | undefined;
    if (error && typeof error.requestId === 'string') return error.requestId;
  }
  return null;
}

function parseRetryAfter(response: Response): number | null {
  const raw = response.headers.get('retry-after');
  if (!raw) return null;
  const seconds = Number(raw);
  return Number.isFinite(seconds) ? seconds : null;
}

async function toApiError(response: Response, rawText: string, suppressSessionLost = false): Promise<ApiError> {
  let payload: unknown = null;
  if (rawText) {
    try {
      payload = JSON.parse(rawText);
    } catch {
      payload = rawText;
    }
  }
  const record = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
  const errorBlock = (record.error ?? {}) as Record<string, unknown>;
  const code = typeof errorBlock.code === 'string' ? errorBlock.code : `HTTP_${response.status}`;
  const source: ApiErrorSource =
    errorBlock.source === 'webui' || response.headers.get('x-webui-error-source') === 'webui'
      ? 'webui'
      : 'upstream';
  const message =
    typeof errorBlock.message === 'string'
      ? errorBlock.message
      : rawText && typeof payload === 'string'
        ? '上游返回了非 JSON 错误内容'
        : `请求失败（HTTP ${response.status}）`;
  const fields = Array.isArray(errorBlock.fields)
    ? (errorBlock.fields as Array<Record<string, unknown>>).map((field) => ({
        path: String(field.path ?? ''),
        code: String(field.code ?? ''),
        message: String(field.message ?? ''),
      }))
    : [];

  const apiError = new ApiError({
    status: response.status,
    code,
    source,
    message,
    retryable: Boolean(errorBlock.retryable),
    requestId: extractRequestId(payload, response),
    retryAfterSeconds: parseRetryAfter(response),
    fields,
    operationId: typeof errorBlock.operationId === 'string' ? errorBlock.operationId : null,
    payload,
  });

  if (apiError.isSessionLost && !suppressSessionLost) state.onSessionLost?.();
  return apiError;
}

/** 低层请求：所有 BFF / 管理调用最终都经过这里；url 已是浏览器可直接访问的地址。 */
async function performRequest<T>(url: string, options: RequestOptions = {}): Promise<ManagementResponse<T>> {
  const method = options.method ?? 'GET';
  const isWrite = method !== 'GET';

  const headers: Record<string, string> = { accept: 'application/json' };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (isWrite) {
    if (!state.csrfToken) {
      throw new ApiError({
        status: 403,
        code: 'WEBUI_CSRF_REJECTED',
        source: 'webui',
        message: '当前会话缺少 CSRF Token，请刷新页面后重试',
      });
    }
    headers['x-csrf-token'] = state.csrfToken;
  }
  if (options.ifMatch) headers['if-match'] = options.ifMatch;
  if (options.idempotencyKey) headers['idempotency-key'] = options.idempotencyKey;

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers,
      credentials: 'same-origin',
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
    });
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw error;
    throw new ApiError({
      status: 0,
      code: 'WEBUI_NETWORK_ERROR',
      source: 'network',
      message: '无法连接 WebUI 后端（BFF）；请检查容器与反向代理状态',
      retryable: true,
    });
  }

  const text = response.status === 204 ? '' : await response.text();

  if (!response.ok) throw await toApiError(response, text, options.suppressSessionLost === true);

  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      // 2xx 非 JSON：明确报错，不能静默返回空数据
      throw new ApiError({
        status: response.status,
        code: 'WEBUI_UPSTREAM_UNEXPECTED_CONTENT',
        source: 'webui',
        message: '后端返回了非 JSON 内容，无法解析为管理结果',
        payload: text.slice(0, 4096),
      });
    }
  }

  const record = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
  const meta = (record.meta && typeof record.meta === 'object' ? record.meta : {}) as Record<string, unknown>;
  const revision = typeof meta.revision === 'string' ? meta.revision : typeof meta.etag === 'string' ? meta.etag : null;

  return {
    status: response.status,
    data: 'data' in record ? (record.data as T) : null,
    meta,
    revision,
    raw: payload,
  };
}

/**
 * BFF 自带接口（/bff/*）：path 相对 WebUI 基址 /webui/，例如 /bff/bootstrap。
 * 管理接口不要用这个函数，否则请求会落到 /webui/<管理路径>，被 BFF 以
 * WEBUI_NOT_FOUND 拒绝（永远到不了 Parrot）。
 */
export function requestJson<T>(path: string, options: RequestOptions = {}): Promise<ManagementResponse<T>> {
  return performRequest<T>(`${webuiUrl(path)}${buildQueryString(options.query)}`, options);
}

/**
 * 管理接口（/bff/management/*）：path 是「相对 /bff/management 的管理路径」，
 * 例如 /channels、/channels/{id}/compatibility、/operations/{operationId}。
 * 管理前缀只在这里拼一次，页面层不要自己写 /webui 或 /bff。
 */
export function managementRequest<T>(path: string, options: RequestOptions = {}): Promise<ManagementResponse<T>> {
  // 编程错误（手工带上 BFF 前缀）会让地址变成 /webui/bff/management/bff/...：
  // 这里直接抛出明确错误，避免它伪装成一个难查的 404 WEBUI_NOT_FOUND。
  if (path.startsWith('/bff') || path.startsWith('/webui')) {
    throw new Error(
      `managementRequest 的 path 必须是相对 /bff/management 的管理路径（例如 /channels），收到：${path}`,
    );
  }
  return performRequest<T>(`${managementUrl(path)}${buildQueryString(options.query)}`, options);
}

// ------------------------------------------------------------------ BFF 自带接口

export interface BootstrapResponse {
  instanceName: string;
  basePath: string;
  loginMethods: string[];
  contract: {
    repository: string;
    commit: string;
    release: string;
    operationCount: number;
    pathCount: number;
    routerCount: number;
    snapshotSha256: string;
  };
  upstream: {
    configured: boolean;
    reachable: boolean;
    managementApiDetected: boolean;
    status: number | null;
    errorCode: string | null;
    latencyMs: number | null;
    checkedAt: number;
  };
  sessionPolicy: { idleSeconds: number; maxSeconds: number };
  csrfToken: string;
  preloginExpiresAt: string;
}

export interface SessionSummary {
  sessionId?: string;
  subjectId?: string;
  authMethod?: string;
  roles?: string[];
  capabilities?: string[];
  issuedAt?: string;
  expiresAt?: string;
  idleExpiresAt?: string;
}

export interface SessionResponse {
  authenticated: boolean;
  session: {
    summary: SessionSummary;
    localExpiresAt: string;
    localIdleExpiresAt: string;
    upstreamIdleExpiresAt: string | null;
    createdAt: string;
    lastUpstreamRefreshAt: string;
  } | null;
  csrfToken: string | null;
  capabilities: string[];
  upstream: {
    reachable: boolean;
    managementApiDetected: boolean;
    status: number | null;
    errorCode: string | null;
    checkedAt: number;
  };
}

export interface LoginResponse {
  session: SessionResponse['session'];
  csrfToken: string;
  upstream: SessionResponse['upstream'];
}

export interface LogoutResponse {
  localSessionDestroyed: boolean;
  upstreamRevocation: 'revoked' | 'unconfirmed' | 'not-attempted';
  message?: string;
}

export interface DiagnosticsResponse {
  webui: {
    version: string;
    nodeVersion: string;
    startedAt: string;
    uptimeSeconds: number;
    basePath: string;
    publicOrigin: string;
    instanceName: string;
    cookieSecure: boolean;
  };
  upstream: {
    origin: string;
    reachable: boolean;
    managementApiDetected: boolean;
    status: number | null;
    errorCode: string | null;
    latencyMs: number | null;
    checkedAt: number;
  };
  contract: BootstrapResponse['contract'];
  allowlist: { routeCount: number; authRouteCount: number; notes: Array<{ method: string; path: string; note: string | null }> };
  session: SessionResponse['session'];
  sessions: { active: number; prelogin: number; maxSessions: number; maxPrelogin: number };
  limits: Record<string, number>;
}

export const bff = {
  bootstrap: (signal?: AbortSignal) => requestJson<BootstrapResponse>('/bff/bootstrap', { signal }),
  login: (managementKey: string) =>
    requestJson<LoginResponse>('/bff/auth/login', {
      method: 'POST',
      body: { managementKey },
      // 登录请求自身的 401（凭据不对）不是「会话已失效」，不应触发全局失效处理
      suppressSessionLost: true,
    }),
  session: (signal?: AbortSignal) => requestJson<SessionResponse>('/bff/auth/session', { signal }),
  logout: () => requestJson<LogoutResponse>('/bff/auth/logout', { method: 'POST', body: {} }),
  diagnostics: (signal?: AbortSignal) => requestJson<DiagnosticsResponse>('/bff/diagnostics', { signal }),
};

export function isWebuiCode(code: string): code is WebuiErrorCode {
  return code.startsWith('WEBUI_');
}
