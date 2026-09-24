/**
 * 业务代理：把 /webui/bff/management/* 映射到上游 /api/management/v1/*。
 *
 * 安全边界（实施文档 5.2 / 5.3 / 5.4）：
 * - 目标 origin 只来自部署配置，浏览器无法提供任何目标地址。
 * - 只代理冻结允许清单中的 method + path 模板；/auth/* 由认证控制器独占。
 * - 请求头按白名单重建；Bearer 由 BFF 设置；不转发 Cookie/Origin/Host/X-Forwarded-*。
 * - 上游业务 JSON、状态码、requestId、revision 尽量保真；非 JSON 转为结构化错误。
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../context.js';
import { WebuiError } from '../errors.js';
import { assertCsrf, assertHost, assertJsonContentType, assertOrigin } from '../security/request-guard.js';
import { matchProxyRoute, sanitizeUpstreamQuery } from '../security/route-allowlist.js';
import { readSessionCookie, clearSessionCookie } from '../auth/cookies.js';
import { sessionPayload } from '../auth/controller.js';
import { approximateBodyBytes, parseByteSize } from '../util/bytes.js';
import { sanitizeRequestId } from '../util/crypto.js';
import { UPSTREAM_MANAGEMENT_PREFIX } from '@parrot-webui/contracts/routes';

const PROXY_PREFIX = '/webui/bff/management';
const FORWARD_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

interface RawPathParts {
  pathname: string;
  query: string;
}

function splitRawUrl(rawUrl: string): RawPathParts {
  const index = rawUrl.indexOf('?');
  if (index === -1) return { pathname: rawUrl, query: '' };
  return { pathname: rawUrl.slice(0, index), query: rawUrl.slice(index + 1) };
}

function buildForwardHeaders(request: FastifyRequest): Record<string, string> {
  const headers: Record<string, string> = { accept: 'application/json' };
  const contentType = request.headers['content-type'];
  if (typeof contentType === 'string' && contentType.trim()) headers['content-type'] = 'application/json';
  const ifMatch = request.headers['if-match'];
  if (typeof ifMatch === 'string' && ifMatch.trim()) headers['if-match'] = ifMatch.trim();
  const idempotencyKey = request.headers['idempotency-key'];
  if (typeof idempotencyKey === 'string' && idempotencyKey.trim().length <= 200) {
    headers['idempotency-key'] = idempotencyKey.trim();
  }
  headers['x-request-id'] = sanitizeRequestId(request.headers['x-request-id']) ?? String(request.id);
  return headers;
}

export function registerManagementProxy(app: FastifyInstance, ctx: AppContext): void {
  app.route({
    method: [...FORWARD_METHODS],
    url: `${PROXY_PREFIX}/*`,
    // 体积上限按路由单独判定（OAuth 导入 5 MiB，其余 1 MiB）；这里给足全局上限
    bodyLimit: ctx.config.oauthImportBodyLimitBytes,
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      assertHost(request, ctx.config);

      // 1) 会话：未登录不得触达上游任何业务接口
      const token = readSessionCookie(request, ctx.config);
      const session = ctx.store.getSession(token);
      if (!session) {
        if (token) clearSessionCookie(reply, ctx.config);
        throw new WebuiError('WEBUI_SESSION_REQUIRED');
      }

      // 2) 写操作的来源与 CSRF（登录也受同一套校验约束）
      if (request.method !== 'GET') {
        assertOrigin(request, ctx.config);
        assertJsonContentType(request);
        assertCsrf(request, session.csrfToken);
      }

      // 3) 路径与允许清单
      const { pathname, query } = splitRawUrl(request.raw.url ?? '');
      if (!pathname.startsWith(PROXY_PREFIX)) {
        throw new WebuiError('WEBUI_NOT_FOUND');
      }
      const remainder = pathname.slice(PROXY_PREFIX.length);
      const match = matchProxyRoute(request.method, remainder);
      const upstreamQuery = sanitizeUpstreamQuery(query);

      // 4) 体积上限（按允许清单里的路由定义）
      const limit = parseByteSize(match.route.bodyLimit, ctx.config.defaultBodyLimitBytes);
      if (request.method !== 'GET' && approximateBodyBytes(request.body) > limit) {
        throw new WebuiError('WEBUI_PAYLOAD_TOO_LARGE', {
          message: `请求体超过该操作的上限（${limit} 字节）`,
          details: { limit, operation: `${match.route.method} ${match.route.path}` },
        });
      }

      // 5) 转发：只重建允许的头部，Bearer 由 BFF 设置
      const body =
        request.method === 'GET' || request.body === undefined || request.body === null
          ? undefined
          : JSON.stringify(request.body);

      const upstreamResponse = await ctx.upstream.call({
        method: match.route.method,
        path: match.upstreamPath.startsWith(UPSTREAM_MANAGEMENT_PREFIX) ? match.upstreamPath : `${UPSTREAM_MANAGEMENT_PREFIX}${match.upstreamPath}`,
        query: upstreamQuery,
        headers: buildForwardHeaders(request),
        body,
        credential: session.upstreamCredential,
      });

      // 6) 上游判定会话失效：清理本地会话，响应按原样返回（前端据此转登录）
      if (upstreamResponse.status === 401 || upstreamResponse.status === 403) {
        const envelope = upstreamResponse.body.byteLength
          ? safeParse(upstreamResponse.body.toString('utf8'))
          : null;
        const code = envelope?.error?.code;
        if (upstreamResponse.status === 401 || code === 'SESSION_REQUIRED' || code === 'SESSION_EXPIRED') {
          ctx.store.destroySession(token);
          clearSessionCookie(reply, ctx.config);
        }
      }

      reply.header('cache-control', 'no-store');
      if (upstreamResponse.retryAfter) reply.header('retry-after', upstreamResponse.retryAfter);
      if (upstreamResponse.upstreamRequestId) reply.header('x-upstream-request-id', upstreamResponse.upstreamRequestId);
      // 标记该响应来自 Parrot（业务错误），前端据此与 WebUI 传输错误区分
      reply.header('x-webui-response-source', 'upstream');

      const contentType = upstreamResponse.contentType.toLowerCase();
      const isJson = contentType.includes('application/json') || upstreamResponse.body.byteLength === 0;

      if (!isJson) {
        // 上游 HTML 错误页不能按 HTML 插入前端：转成结构化错误
        throw new WebuiError('WEBUI_UPSTREAM_UNEXPECTED_CONTENT', {
          message: `Parrot 对 ${match.route.method} ${match.route.path} 返回了非 JSON 响应（HTTP ${upstreamResponse.status}）`,
          details: { upstreamStatus: upstreamResponse.status, operation: match.route.upstreamOperationId },
        });
      }

      // 204 或空响应体：保持原状态码，不强行 JSON.parse
      if (upstreamResponse.status === 204 || upstreamResponse.body.byteLength === 0) {
        reply.code(upstreamResponse.status).send();
        return;
      }

      reply.code(upstreamResponse.status).header('content-type', 'application/json; charset=utf-8');
      reply.send(upstreamResponse.body.toString('utf8'));
    },
  });

  // 会话摘要查询用于前端刷新时同步（与 /bff/auth/session 等价，但保持在同一前缀下）
  app.get(`${PROXY_PREFIX}/session-summary`, async (request, reply) => {
    assertHost(request, ctx.config);
    const token = readSessionCookie(request, ctx.config);
    const session = ctx.store.getSession(token);
    if (!session) throw new WebuiError('WEBUI_SESSION_REQUIRED');
    reply.header('cache-control', 'no-store');
    reply.send({ data: sessionPayload(session), meta: { requestId: String(request.id) } });
  });
}

interface ParsedEnvelope {
  error?: { code?: string } | null;
}

function safeParse(text: string): ParsedEnvelope | null {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? (parsed as ParsedEnvelope) : null;
  } catch {
    return null;
  }
}
