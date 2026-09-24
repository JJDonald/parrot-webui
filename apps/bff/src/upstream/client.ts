/**
 * 固定的上游 HTTP 客户端。
 *
 * 约束（实施文档 5.2 / 5.5）：
 * - 目标 origin 只来自部署配置，调用方只能提供"已校验过的路径"，无法改变主机。
 * - 禁止自动跟随重定向，避免把 Authorization 带到其他主机（maxRedirections: 0）。
 * - 连接超时与总超时分开设置；响应体积有上限，超限转为结构化错误，不静默截断。
 * - 不复制浏览器的 Cookie/Origin/Authorization/Host/X-Forwarded-*；Bearer 由这里设置。
 */

import { Agent, request } from 'undici';
import type { WebuiConfig } from '../config.js';
import { WebuiError } from '../errors.js';

export interface UpstreamCall {
  readonly method: string;
  /** 已编码、且已通过允许清单校验的绝对路径（含 /api/management/v1 前缀）。 */
  readonly path: string;
  readonly query?: string;
  readonly headers?: Record<string, string>;
  readonly body?: string;
  readonly credential?: string;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
}

export interface UpstreamResponse {
  readonly status: number;
  readonly body: Buffer;
  readonly contentType: string;
  readonly upstreamRequestId: string | null;
  readonly retryAfter: string | null;
  readonly revision: string | null;
}

export interface UpstreamProbeResult {
  readonly configured: true;
  readonly reachable: boolean;
  readonly status: number | null;
  readonly managementApiDetected: boolean;
  readonly latencyMs: number | null;
  readonly errorCode: string | null;
  readonly checkedAt: number;
}

const FORBIDDEN_FORWARD_HEADERS = new Set([
  'cookie',
  'origin',
  'referer',
  'host',
  'authorization',
  'connection',
  'keep-alive',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'content-length',
]);

/** 允许从浏览器转发的请求头白名单（实施文档 5.3）。 */
export const FORWARDABLE_HEADERS = new Set(['accept', 'content-type', 'if-match', 'idempotency-key', 'x-request-id']);

export function assertForwardableHeader(name: string): void {
  const lowered = name.toLowerCase();
  if (FORBIDDEN_FORWARD_HEADERS.has(lowered) || !FORWARDABLE_HEADERS.has(lowered)) {
    throw new WebuiError('WEBUI_INVALID_REQUEST', { message: `请求头 ${name} 不允许转发给上游` });
  }
}

/**
 * 主动丢弃响应体（拒绝重定向 / 拒绝超大响应）时的统一入口。
 *
 * undici 的 BodyReadable.destroy() 会中止底层请求并抛出 AbortError；如果没有任何
 * 'error' 监听者，这个"预期内"的中止会变成进程级 uncaught exception，
 * 使"拒绝跟随重定向、拒绝超大响应"这条安全路径本身变成可被上游触发的拒绝服务。
 * 这里只吞掉丢弃动作自身产生的错误，上层已经构造好的 WEBUI_* 结构化错误不受影响。
 */
function discardResponseBody(body: { on(event: 'error', listener: () => void): unknown; destroy(): unknown }): void {
  body.on('error', () => {});
  body.destroy();
}

export class UpstreamClient {
  private readonly config: WebuiConfig;
  private readonly agent: Agent;
  private probeCache: UpstreamProbeResult | null = null;

  constructor(config: WebuiConfig) {
    this.config = config;
    this.agent = new Agent({
      connect: { timeout: config.connectTimeoutMs },
      headersTimeout: config.requestTimeoutMs,
      bodyTimeout: config.requestTimeoutMs,
      keepAliveTimeout: 10_000,
      keepAliveMaxTimeout: 60_000,
    });
  }

  get origin(): string {
    return this.config.upstreamOrigin;
  }

  async call(call: UpstreamCall): Promise<UpstreamResponse> {
    const url = `${this.config.upstreamOrigin}${call.path}${call.query ?? ''}`;
    const headers: Record<string, string> = { accept: 'application/json', ...(call.headers ?? {}) };
    if (call.credential) headers.authorization = `Bearer ${call.credential}`;
    if (call.body !== undefined) headers['content-type'] ??= 'application/json';

    const timeoutMs = call.timeoutMs ?? this.config.requestTimeoutMs;
    const maxBytes = call.maxResponseBytes ?? this.config.maxUpstreamResponseBytes;

    let response;
    try {
      response = await request(url, {
        method: call.method as 'GET',
        headers,
        body: call.body,
        dispatcher: this.agent,
        // undici 的 request 默认不跟随重定向；3xx 会作为响应返回，由下面统一拒绝。
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw this.mapTransportError(error);
    }

    const status = response.statusCode;
    const headerOf = (name: string): string | null => {
      const value = response.headers[name];
      if (value === undefined) return null;
      return Array.isArray(value) ? (value[0] ?? null) : String(value);
    };

    if (status >= 300 && status < 400) {
      discardResponseBody(response.body);
      throw new WebuiError('WEBUI_UPSTREAM_REDIRECT_BLOCKED', {
        message: `上游返回 ${status} 重定向，BFF 不携带凭据跟随`,
        details: { status, location: headerOf('location') ? '(已隐藏)' : null },
      });
    }

    const declaredLength = headerOf('content-length');
    if (declaredLength && Number(declaredLength) > maxBytes) {
      discardResponseBody(response.body);
      throw new WebuiError('WEBUI_RESPONSE_TOO_LARGE', {
        details: { declaredLength: Number(declaredLength), maxResponseBytes: maxBytes },
      });
    }

    const chunks: Buffer[] = [];
    let total = 0;
    try {
      for await (const chunk of response.body) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
        total += buffer.byteLength;
        if (total > maxBytes) {
          discardResponseBody(response.body);
          throw new WebuiError('WEBUI_RESPONSE_TOO_LARGE', {
            details: { bytesRead: total, maxResponseBytes: maxBytes },
          });
        }
        chunks.push(buffer);
      }
    } catch (error) {
      if (error instanceof WebuiError) throw error;
      throw this.mapTransportError(error);
    }

    const contentType = headerOf('content-type') ?? '';
    return {
      status,
      body: Buffer.concat(chunks),
      contentType,
      upstreamRequestId: headerOf('x-request-id') ?? headerOf('request-id'),
      retryAfter: headerOf('retry-after'),
      revision: headerOf('etag') ?? headerOf('x-resource-revision'),
    };
  }

  /**
   * 只用于登录页/诊断的轻量可达性探测：未认证访问 /meta。
   * 返回 401/403 说明"管理 API 存在但需要登录"，这既证明了可达性，也不泄露任何内容。
   */
  async probeManagement(options: { maxAgeMs?: number; now?: number } = {}): Promise<UpstreamProbeResult> {
    const now = options.now ?? Date.now();
    const maxAgeMs = options.maxAgeMs ?? 15_000;
    if (this.probeCache && now - this.probeCache.checkedAt < maxAgeMs) {
      return this.probeCache;
    }
    const startedAt = Date.now();
    try {
      const result = await this.call({
        method: 'GET',
        path: '/api/management/v1/meta',
        timeoutMs: Math.min(this.config.connectTimeoutMs * 2, 10_000),
        maxResponseBytes: 64 * 1024,
      });
      const detected = result.status === 200 || result.status === 401 || result.status === 403 || result.status === 400;
      this.probeCache = {
        configured: true,
        reachable: true,
        status: result.status,
        managementApiDetected: detected,
        latencyMs: Date.now() - startedAt,
        errorCode: null,
        checkedAt: Date.now(),
      };
    } catch (error) {
      const code = error instanceof WebuiError ? error.code : 'WEBUI_UPSTREAM_UNREACHABLE';
      this.probeCache = {
        configured: true,
        reachable: false,
        status: null,
        managementApiDetected: false,
        latencyMs: Date.now() - startedAt,
        errorCode: code,
        checkedAt: Date.now(),
      };
    }
    return this.probeCache;
  }

  private mapTransportError(error: unknown): WebuiError {
    const code = (error as { code?: string } | null)?.code;
    const name = (error as { name?: string } | null)?.name;
    if (name === 'AbortError' || name === 'TimeoutError') {
      return new WebuiError('WEBUI_UPSTREAM_TIMEOUT', { cause: error });
    }
    switch (code) {
      case 'UND_ERR_CONNECT_TIMEOUT':
      case 'UND_ERR_HEADERS_TIMEOUT':
      case 'UND_ERR_BODY_TIMEOUT':
        return new WebuiError('WEBUI_UPSTREAM_TIMEOUT', { cause: error });
      case 'ECONNREFUSED':
      case 'ENOTFOUND':
      case 'EAI_AGAIN':
      case 'ECONNRESET':
      case 'EHOSTUNREACH':
      case 'ENETUNREACH':
      case 'UND_ERR_SOCKET':
      case 'UND_ERR_CONNECT_ERROR':
      case 'UND_ERR_HEADERS_OVERFLOW':
        return new WebuiError('WEBUI_UPSTREAM_UNREACHABLE', { cause: error });
      default:
        return new WebuiError('WEBUI_UPSTREAM_UNREACHABLE', {
          cause: error,
          details: code ? { transportCode: code } : undefined,
        });
    }
  }

  async close(): Promise<void> {
    await this.agent.close();
  }
}
