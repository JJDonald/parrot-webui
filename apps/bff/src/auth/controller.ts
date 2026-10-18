/**
 * 认证控制器：bootstrap / login / session / logout / diagnostics。
 *
 * 关键约束（实施文档 4.x / 8.1）：
 * - 管理主密钥只在这一个请求内存在，不写日志、不写磁盘、不进环境变量。
 * - 上游 credential 只存在 BFF 内存，绝不返回浏览器。
 * - 任何上游会话失效响应都必须清理本地会话。
 * - 注销无论上游是否可达都要销毁本地会话并清除 Cookie。
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../context.js';
import { WebuiError } from '../errors.js';
import { UPSTREAM_CONTRACT_SOURCE } from '@parrot-webui/contracts/routes';
import { assertCsrf, assertHost, assertJsonContentType, assertOrigin } from '../security/request-guard.js';
import { isTrustedAddress, normalizeIp, resolveClientIp } from '../security/ip.js';
import { proxyRouteCount, frozenRouteTable } from '../security/route-allowlist.js';
import {
  clearPreloginCookie,
  clearSessionCookie,
  readPreloginCookie,
  readSessionCookie,
  setPreloginCookie,
  setSessionCookie,
} from './cookies.js';
import type { UpstreamSessionSummary, WebSession } from './session-store.js';
import { approximateBodyBytes } from '../util/bytes.js';
import { sanitizeRequestId } from '../util/crypto.js';
import { WEBUI_VERSION } from '../version.js';

const LOGIN_BODY_LIMIT_BYTES = 16 * 1024;
/** 上游 idle 摘要刷新间隔：避免每次请求都打上游，同时不把 stale idle 当永久有效。 */
const UPSTREAM_SESSION_REFRESH_INTERVAL_MS = 60_000;
const LOGIN_UPSTREAM_TIMEOUT_MS = 15_000;
const LOGOUT_UPSTREAM_TIMEOUT_MS = 5_000;

export interface UpstreamPublicState {
  configured: true;
  reachable: boolean;
  managementApiDetected: boolean;
  status: number | null;
  errorCode: string | null;
  latencyMs: number | null;
  checkedAt: number;
}

export function clientIpOf(request: FastifyRequest, ctx: AppContext): string {
  return resolveClientIp(
    {
      remoteAddress: request.raw.socket?.remoteAddress ?? '',
      forwardedFor: request.headers['x-forwarded-for'],
    },
    ctx.config.trustProxy,
  );
}

/**
 * 把"这一次请求的来源是怎么判定的"显式暴露给诊断页面。
 *
 * WEBUI_TRUST_PROXY 填错的典型表现是完全静默的：直连对端（例如 Docker 网桥网关
 * 172.x.0.1）不在可信列表里时，X-Forwarded-For 会被整体忽略，所有用户退化成同一个
 * 限流键。运维只能从"限流不生效"这种间接现象去猜。这里直接给出判定过程。
 */
function describeRequestSource(request: FastifyRequest, ctx: AppContext) {
  const remoteAddress = normalizeIp(request.raw.socket?.remoteAddress ?? 'unknown');
  const rawForwarded = request.headers['x-forwarded-for'];
  const forwardedFor = Array.isArray(rawForwarded) ? rawForwarded.join(',') : (rawForwarded ?? null);
  const remoteTrusted = isTrustedAddress(remoteAddress, ctx.config.trustProxy);
  const clientIp = resolveClientIp(
    { remoteAddress: request.raw.socket?.remoteAddress ?? '', forwardedFor: rawForwarded },
    ctx.config.trustProxy,
  );
  return {
    remoteAddress,
    forwardedFor,
    /** 直连对端是否落在 WEBUI_TRUST_PROXY 内；false 表示 XFF 被整体忽略。 */
    remoteTrusted,
    /** 最终用于限流与审计的客户端来源。 */
    clientIp,
    trustProxy: ctx.config.trustProxy,
    /**
     * 常见错配提示（不阻断请求，只在诊断页明示）：
     * 有 XFF 但直连对端不可信 → 说明 WEBUI_TRUST_PROXY 与真实入口网络不一致。
     */
    warning:
      forwardedFor && !remoteTrusted
        ? `直连地址 ${remoteAddress} 不在 WEBUI_TRUST_PROXY 内，X-Forwarded-For 被忽略；所有请求会共用 ${remoteAddress} 这一限流键`
        : null,
  };
}

function forwardedRequestId(request: FastifyRequest): string {
  return sanitizeRequestId(request.headers['x-request-id']) ?? String(request.id);
}

async function publicUpstreamState(ctx: AppContext): Promise<UpstreamPublicState> {
  const probe = await ctx.upstream.probeManagement();
  return {
    configured: true,
    reachable: probe.reachable,
    managementApiDetected: probe.managementApiDetected,
    status: probe.status,
    errorCode: probe.errorCode,
    latencyMs: probe.latencyMs,
    checkedAt: probe.checkedAt,
  };
}

function contractSummary() {
  return {
    repository: UPSTREAM_CONTRACT_SOURCE.repository,
    commit: UPSTREAM_CONTRACT_SOURCE.commit,
    release: UPSTREAM_CONTRACT_SOURCE.release,
    operationCount: UPSTREAM_CONTRACT_SOURCE.operationCount,
    pathCount: UPSTREAM_CONTRACT_SOURCE.pathCount,
    routerCount: UPSTREAM_CONTRACT_SOURCE.routerCount,
    snapshotSha256: UPSTREAM_CONTRACT_SOURCE.snapshotSha256,
  };
}

/**
 * 会话摘要：只返回可展示字段，绝不包含 upstreamCredential。
 *
 * `idleSeconds` 由调用方从 `ctx.config` 显式传入——早期版本用模块级可变变量
 * `configureSessionPayload()` 注入，同一进程内多次 `buildServer()`（测试、多实例）
 * 会互相污染，这里改回纯函数。
 */
export function sessionPayload(session: WebSession, idleSeconds: number) {
  return {
    summary: session.upstreamSessionSummary as UpstreamSessionSummary,
    localExpiresAt: new Date(session.absoluteExpiresAt).toISOString(),
    localIdleExpiresAt: new Date(session.lastSeenAt + idleSeconds * 1000).toISOString(),
    upstreamIdleExpiresAt: session.upstreamIdleExpiresAt ? new Date(session.upstreamIdleExpiresAt).toISOString() : null,
    createdAt: new Date(session.createdAt).toISOString(),
    lastUpstreamRefreshAt: new Date(session.lastUpstreamSessionRefreshAt).toISOString(),
  };
}

/**
 * 取出会话（含 Cookie 清理）。
 *
 * 未登录抛 WEBUI_SESSION_REQUIRED；带着会话 Cookie 但会话已不存在/已过期
 * （空闲超时、绝对超时、登出、容量驱逐）抛 WEBUI_SESSION_EXPIRED。
 * 两者都是 401，前端 `isSessionLost` 并入同一个转登录流程，区别只在提示文案
 * 与可观测性：运维能从错误码看出"真有人之前登录过、只是过期了"。
 */
export function requireSession(request: FastifyRequest, reply: FastifyReply, ctx: AppContext): WebSession {
  const token = readSessionCookie(request, ctx.config);
  const session = ctx.store.getSession(token);
  if (!session) {
    if (token) {
      clearSessionCookie(reply, ctx.config);
      throw new WebuiError('WEBUI_SESSION_EXPIRED');
    }
    throw new WebuiError('WEBUI_SESSION_REQUIRED');
  }
  return session;
}

/** 上游可能返回 HTML 或非 JSON；这里统一转换为本地结构化错误。 */
function upstreamUnexpected(status: number): WebuiError {
  return new WebuiError('WEBUI_UPSTREAM_UNEXPECTED_CONTENT', {
    message: `Parrot 返回了非 JSON 响应（HTTP ${status}），已转换为结构化错误；请查看原实例日志`,
    details: { upstreamStatus: status },
  });
}

function parseJsonEnvelope(body: Buffer): Record<string, unknown> | null {
  if (!body.byteLength) return null;
  try {
    const parsed = JSON.parse(body.toString('utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// --------------------------------------------------------------- bootstrap

export async function handleBootstrap(request: FastifyRequest, reply: FastifyReply, ctx: AppContext): Promise<void> {
  assertHost(request, ctx.config);

  const ip = clientIpOf(request, ctx);
  const globalVerdict = ctx.limiters.bootstrapGlobal.check('global');
  if (!globalVerdict.allowed) {
    throw new WebuiError('WEBUI_RATE_LIMITED', {
      message: 'bootstrap 请求过于频繁，请稍后重试',
      retryAfterSeconds: globalVerdict.retryAfterSeconds,
    });
  }
  const perSourceVerdict = ctx.limiters.bootstrapPerSource.check(ip);
  if (!perSourceVerdict.allowed) {
    throw new WebuiError('WEBUI_RATE_LIMITED', {
      message: 'bootstrap 请求过于频繁，请稍后重试',
      retryAfterSeconds: perSourceVerdict.retryAfterSeconds,
    });
  }
  if (!ctx.gates.bootstrap.tryEnter()) {
    throw new WebuiError('WEBUI_CAPACITY_EXCEEDED', {
      message: '并发 bootstrap 请求已达上限，请稍后重试',
    });
  }

  try {
    const existingToken = readPreloginCookie(request, ctx.config);
    const { prelogin, token } = ctx.store.getOrCreatePrelogin(existingToken, ip);
    // 复用时不延长 TTL：按剩余时间重新下发
    const remainingSeconds = Math.max(1, Math.ceil((prelogin.expiresAt - Date.now()) / 1000));
    setPreloginCookie(reply, ctx.config, token);
    reply.header('cache-control', 'no-store');

    const upstream = await publicUpstreamState(ctx);
    reply.code(200).send({
      data: {
        instanceName: ctx.config.instanceName,
        basePath: ctx.config.basePath,
        loginMethods: ['managementKey'],
        contract: contractSummary(),
        upstream,
        sessionPolicy: {
          idleSeconds: ctx.config.sessionIdleSeconds,
          maxSeconds: ctx.config.sessionMaxSeconds,
        },
        csrfToken: prelogin.csrfToken,
        preloginExpiresAt: new Date(prelogin.expiresAt).toISOString(),
        preloginTtlSeconds: remainingSeconds,
      },
      meta: { requestId: forwardedRequestId(request) },
    });
  } finally {
    ctx.gates.bootstrap.leave();
  }
}

// ------------------------------------------------------------------- login

export async function handleLogin(request: FastifyRequest, reply: FastifyReply, ctx: AppContext): Promise<void> {
  assertHost(request, ctx.config);
  assertOrigin(request, ctx.config);
  assertJsonContentType(request);

  const ip = clientIpOf(request, ctx);
  const globalVerdict = ctx.limiters.loginGlobal.check('global');
  const perSourceVerdict = ctx.limiters.loginPerSource.check(ip);
  if (!globalVerdict.allowed || !perSourceVerdict.allowed) {
    const retryAfterSeconds = Math.max(globalVerdict.retryAfterSeconds, perSourceVerdict.retryAfterSeconds, 1);
    reply.header('retry-after', String(retryAfterSeconds));
    throw new WebuiError('WEBUI_RATE_LIMITED', {
      message: '登录尝试过于频繁，请稍后重试',
      retryAfterSeconds,
    });
  }

  // 预登录 Cookie + 预登录 CSRF 必须同时有效
  const preloginToken = readPreloginCookie(request, ctx.config);
  const prelogin = ctx.store.getPrelogin(preloginToken);
  if (!prelogin) {
    throw new WebuiError('WEBUI_CSRF_REJECTED', {
      message: '预登录会话缺失或已过期，请刷新登录页后重试',
    });
  }
  assertCsrf(request, prelogin.csrfToken);

  const body = (request.body ?? {}) as Record<string, unknown>;
  if (approximateBodyBytes(request.body) > LOGIN_BODY_LIMIT_BYTES) {
    throw new WebuiError('WEBUI_PAYLOAD_TOO_LARGE', { message: '登录请求体过大' });
  }
  const managementKey = body.managementKey;
  if (typeof managementKey !== 'string' || managementKey.trim() === '') {
    throw new WebuiError('WEBUI_INVALID_REQUEST', { message: '必须提供字符串类型的 managementKey' });
  }
  for (const key of Object.keys(body)) {
    if (key !== 'managementKey') {
      throw new WebuiError('WEBUI_INVALID_REQUEST', {
        message: `登录请求包含不支持的字段 ${key}；上游 schema 拒绝多余字段`,
      });
    }
  }

  if (!ctx.gates.login.tryEnter()) {
    throw new WebuiError('WEBUI_CAPACITY_EXCEEDED', { message: '并发登录请求已达上限，请稍后重试' });
  }

  try {
    // 管理主密钥只在这一处使用，且不写入任何日志
    const upstream = await ctx.upstream.call({
      method: 'POST',
      path: '/api/management/v1/auth/sessions',
      body: JSON.stringify({ grantType: 'managementKey', managementKey }),
      headers: { 'x-request-id': forwardedRequestId(request) },
      timeoutMs: LOGIN_UPSTREAM_TIMEOUT_MS,
    });

    if (upstream.status !== 201) {
      // 上游业务错误原样透传（保留 code/fields/requestId/Retry-After）
      const envelope = parseJsonEnvelope(upstream.body);
      if (!envelope) throw upstreamUnexpected(upstream.status);
      if (upstream.retryAfter) reply.header('retry-after', upstream.retryAfter);
      reply
        .code(upstream.status)
        .header('cache-control', 'no-store')
        .header('content-type', 'application/json; charset=utf-8')
        .send(upstream.body.toString('utf8'));
      return;
    }

    const envelope = parseJsonEnvelope(upstream.body);
    const data = (envelope?.data ?? null) as Record<string, unknown> | null;
    const credential = data && typeof data.credential === 'string' ? data.credential : null;
    const sessionSummary = data && data.session && typeof data.session === 'object' ? (data.session as UpstreamSessionSummary) : null;
    if (!credential || !sessionSummary) {
      throw new WebuiError('WEBUI_UPSTREAM_UNEXPECTED_CONTENT', {
        message: '上游登录响应缺少 credential 或 session 字段',
      });
    }

    const created = ctx.store.createSession({
      upstreamCredential: credential,
      upstreamSessionSummary: sessionSummary,
      clientIp: ip,
    });
    // 登录成功：轮换会话 ID 与 CSRF，销毁预登录会话
    ctx.store.dropPrelogin(preloginToken);
    setSessionCookie(reply, ctx.config, created.token);
    clearPreloginCookie(reply, ctx.config);
    reply.header('cache-control', 'no-store');

    const upstreamState = await publicUpstreamState(ctx);
    reply.code(200).send({
      data: {
        session: sessionPayload(created.session, ctx.config.sessionIdleSeconds),
        csrfToken: created.session.csrfToken,
        upstream: upstreamState,
      },
      meta: { requestId: forwardedRequestId(request) },
    });
  } finally {
    ctx.gates.login.leave();
  }
}

// ----------------------------------------------------------------- session

export async function handleSession(request: FastifyRequest, reply: FastifyReply, ctx: AppContext): Promise<void> {
  assertHost(request, ctx.config);
  reply.header('cache-control', 'no-store');

  const token = readSessionCookie(request, ctx.config);
  let session = ctx.store.getSession(token);

  if (!session) {
    if (token) clearSessionCookie(reply, ctx.config);
    const upstream = await publicUpstreamState(ctx);
    reply.code(200).send({
      data: {
        authenticated: false,
        session: null,
        csrfToken: null,
        capabilities: [],
        upstream,
      },
      meta: { requestId: forwardedRequestId(request) },
    });
    return;
  }

  // 需要时用真实 GET /auth/session 刷新上游 idle 截止时间（有界，不假定成功读取即产生新截止时间）
  let upstream = await publicUpstreamState(ctx);
  if (Date.now() - session.lastUpstreamSessionRefreshAt > UPSTREAM_SESSION_REFRESH_INTERVAL_MS) {
    try {
      const response = await ctx.upstream.call({
        method: 'GET',
        path: '/api/management/v1/auth/session',
        credential: session.upstreamCredential,
        headers: { 'x-request-id': forwardedRequestId(request) },
        timeoutMs: Math.min(ctx.config.requestTimeoutMs, 10_000),
      });
      const envelope = parseJsonEnvelope(response.body);
      if (response.status === 200 && envelope?.data && typeof envelope.data === 'object') {
        const data = envelope.data as Record<string, unknown>;
        const summary = (data.session && typeof data.session === 'object' ? data.session : data) as UpstreamSessionSummary;
        ctx.store.applyUpstreamSessionSummary(session, summary);
      } else if (response.status === 401 || response.status === 403) {
        // 上游判定失效：清理本地会话，转登录
        ctx.store.destroySession(token);
        clearSessionCookie(reply, ctx.config);
        upstream = { ...upstream, errorCode: 'SESSION_EXPIRED' };
        reply.code(200).send({
          data: {
            authenticated: false,
            session: null,
            csrfToken: null,
            capabilities: [],
            upstream,
          },
          meta: { requestId: forwardedRequestId(request) },
        });
        return;
      } else {
        // 其他情况保持本地会话，但不把 stale idleExpiresAt 当永久有效
        session.lastUpstreamSessionRefreshAt = Date.now();
      }
    } catch {
      // 上游暂时不可达：不注销本地会话，只记录时间戳避免打爆上游
      session.lastUpstreamSessionRefreshAt = Date.now();
    }
    const refreshed = ctx.store.getSession(token);
    if (!refreshed) {
      reply.code(200).send({
        data: { authenticated: false, session: null, csrfToken: null, capabilities: [], upstream },
        meta: { requestId: forwardedRequestId(request) },
      });
      return;
    }
    session = refreshed;
  }

  const capabilities = Array.isArray(session.upstreamSessionSummary.capabilities)
    ? (session.upstreamSessionSummary.capabilities as string[])
    : [];

  reply.code(200).send({
    data: {
      authenticated: true,
      session: sessionPayload(session, ctx.config.sessionIdleSeconds),
      csrfToken: session.csrfToken,
      capabilities,
      upstream,
    },
    meta: { requestId: forwardedRequestId(request) },
  });
}

// ------------------------------------------------------------------ logout

export async function handleLogout(request: FastifyRequest, reply: FastifyReply, ctx: AppContext): Promise<void> {
  assertHost(request, ctx.config);
  assertOrigin(request, ctx.config);
  assertJsonContentType(request);
  reply.header('cache-control', 'no-store');

  const token = readSessionCookie(request, ctx.config);
  const session = ctx.store.getSession(token);

  if (!session) {
    // 没有本地会话时也保持幂等：清理 Cookie，返回本地已退出。
    // 这里不需要 CSRF：请求带不出任何状态变更（Cookie 反正会被清掉），
    // 而文档声称"无 CSRF 例外"时应该把这个分支写清楚。
    clearSessionCookie(reply, ctx.config);
    clearPreloginCookie(reply, ctx.config);
    reply.code(200).send({
      data: { localSessionDestroyed: true, upstreamRevocation: 'not-attempted' },
      meta: { requestId: forwardedRequestId(request) },
    });
    return;
  }

  assertCsrf(request, session.csrfToken);

  let upstreamRevocation: 'revoked' | 'unconfirmed' = 'unconfirmed';
  try {
    const response = await ctx.upstream.call({
      method: 'DELETE',
      path: '/api/management/v1/auth/session',
      credential: session.upstreamCredential,
      timeoutMs: LOGOUT_UPSTREAM_TIMEOUT_MS,
    });
    upstreamRevocation = response.status === 204 || (response.status >= 200 && response.status < 300) ? 'revoked' : 'unconfirmed';
  } catch {
    // 上游不可达：本地必须退出，但不声称已远程吊销
    upstreamRevocation = 'unconfirmed';
  }

  ctx.store.destroySession(token);
  clearSessionCookie(reply, ctx.config);
  clearPreloginCookie(reply, ctx.config);

  reply.code(200).send({
    data: {
      localSessionDestroyed: true,
      upstreamRevocation,
      ...(upstreamRevocation === 'unconfirmed'
        ? { message: '本地已退出登录；上游会话注销未确认（可能上游暂时不可达或该会话已失效）' }
        : {}),
    },
    meta: { requestId: forwardedRequestId(request) },
  });
}

// ------------------------------------------------------------- diagnostics

export async function handleDiagnostics(request: FastifyRequest, reply: FastifyReply, ctx: AppContext): Promise<void> {
  assertHost(request, ctx.config);
  const session = requireSession(request, reply, ctx);
  reply.header('cache-control', 'no-store');

  const probe = await ctx.upstream.probeManagement({ maxAgeMs: 5_000 });
  const stats = ctx.store.stats();
  const allowlist = frozenRouteTable();
  const authRoutes = allowlist.filter((route) => route.routeClass === 'auth');
  const requestSource = describeRequestSource(request, ctx);

  reply.code(200).send({
    data: {
      webui: {
        version: WEBUI_VERSION,
        nodeVersion: process.version,
        startedAt: new Date(ctx.startedAt).toISOString(),
        uptimeSeconds: Math.round((Date.now() - ctx.startedAt) / 1000),
        basePath: ctx.config.basePath,
        publicOrigin: ctx.config.publicOrigin,
        instanceName: ctx.config.instanceName,
        cookieSecure: ctx.config.cookieSecure,
      },
      upstream: {
        origin: ctx.config.upstreamOriginDisplay,
        reachable: probe.reachable,
        managementApiDetected: probe.managementApiDetected,
        status: probe.status,
        errorCode: probe.errorCode,
        latencyMs: probe.latencyMs,
        checkedAt: probe.checkedAt,
      },
      contract: contractSummary(),
      allowlist: {
        routeCount: proxyRouteCount(),
        authRouteCount: authRoutes.length,
        notes: allowlist
          .filter((route) => route.note)
          .slice(0, 40)
          .map((route) => ({ method: route.method, path: route.path, note: route.note })),
      },
      session: sessionPayload(session, ctx.config.sessionIdleSeconds),
      /** 本请求的来源判定结果：用于验证 WEBUI_TRUST_PROXY 是否真的生效。 */
      requestSource,
      sessions: {
        active: stats.sessions,
        prelogin: stats.prelogins,
        maxSessions: stats.maxSessions,
        maxPrelogin: stats.maxPrelogins,
      },
      limits: {
        loginPerSourcePerMinute: ctx.config.loginPerSourcePerMinute,
        loginGlobalPerMinute: ctx.config.loginGlobalPerMinute,
        bootstrapPerSourcePerMinute: ctx.config.bootstrapPerSourcePerMinute,
        bootstrapGlobalPerMinute: ctx.config.bootstrapGlobalPerMinute,
        defaultBodyLimitBytes: ctx.config.defaultBodyLimitBytes,
        oauthImportBodyLimitBytes: ctx.config.oauthImportBodyLimitBytes,
        maxUpstreamResponseBytes: ctx.config.maxUpstreamResponseBytes,
        connectTimeoutMs: ctx.config.connectTimeoutMs,
        requestTimeoutMs: ctx.config.requestTimeoutMs,
      },
    },
    meta: { requestId: forwardedRequestId(request) },
  });
}
