/**
 * BFF 服务器装配。
 *
 * 统一在此处完成：Cookie、安全响应头、结构化错误处理、脱敏日志、路由注册。
 * 任何页面/接口都不应绕过这些统一策略。
 */

import Fastify, { LogController, type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import type { WebuiConfig } from './config.js';
import { createContext, type AppContext } from './context.js';
import { ERROR_SOURCE_HEADER, WebuiError, webuiErrorBody } from './errors.js';
import { newRequestId, sanitizeRequestId } from './util/crypto.js';
import { registerManagementProxy } from './routes/management-proxy.js';
import { registerHealthRoutes, registerSpaFallback, registerStaticRoutes } from './routes/health.js';
import {
  handleBootstrap,
  handleDiagnostics,
  handleLogin,
  handleLogout,
  handleSession,
} from './auth/controller.js';

/** CSP：脚本只允许同源（不允许 inline script）；样式允许 inline 以兼容 Ant Design 的 CSS-in-JS。 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
].join('; ');

/**
 * login 路由级请求体上限。
 * 与 controller.ts 内的 LOGIN_BODY_LIMIT_BYTES 保持一致：那边是业务校验（返回 400），
 * 这里是传输层早拒（返回 413），两者都不能省。
 */
const LOGIN_ROUTE_BODY_LIMIT_BYTES = 16 * 1024;

export interface BuildServerOptions {
  context?: AppContext;
}

export function buildServer(config: WebuiConfig, options: BuildServerOptions = {}): FastifyInstance {
  const ctx = options.context ?? createContext(config);

  const app = Fastify({
    logger: {
      level: config.logLevel,
      // 只保留脱敏字段：不打印请求体、Cookie、Authorization
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.headers["x-csrf-token"]',
          'res.headers["set-cookie"]',
        ],
        remove: true,
      },
    },
    // 请求/响应日志由下面的 onResponse 钩子以脱敏字段自行输出
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: config.oauthImportBodyLimitBytes,
    trustProxy: false, // 由 resolveClientIp 按 WEBUI_TRUST_PROXY 自行判定来源
    genReqId: (request) => sanitizeRequestId(request.headers['x-request-id']) ?? newRequestId(),
  });

  app.decorate('webui', ctx);

  void app.register(cookie);

  // 安全响应头（所有响应，包括错误）
  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('content-security-policy', CONTENT_SECURITY_POLICY);
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('x-frame-options', 'DENY');
    reply.header('cross-origin-opener-policy', 'same-origin');
    reply.header('cross-origin-resource-policy', 'same-origin');
    reply.header('permissions-policy', 'accelerometer=(), camera=(), geolocation=(), microphone=(), payment=()');
    reply.header('x-request-id', String(request.id));
    if (config.isProduction) {
      reply.header('strict-transport-security', 'max-age=31536000; includeSubDomains');
    }
    return payload;
  });

  // 脱敏访问日志：只记录方法、允许清单内的路由模板、状态、耗时与 requestId
  app.addHook('onResponse', async (request, reply) => {
    const routeTemplate = request.routeOptions?.url ?? 'unmatched';
    app.log.info(
      {
        method: request.method,
        route: routeTemplate,
        status: reply.statusCode,
        durationMs: Math.round(reply.elapsedTime),
        requestId: String(request.id),
      },
      'request',
    );
  });

  app.setErrorHandler(async (error, request, reply) => {
    const requestId = String(request.id);

    if (error instanceof WebuiError) {
      if (error.retryAfterSeconds) reply.header('retry-after', String(error.retryAfterSeconds));
      reply
        .code(error.status)
        .header(ERROR_SOURCE_HEADER, 'webui')
        .header('cache-control', 'no-store')
        .send(webuiErrorBody(error, requestId));
      return;
    }

    const code = (error as { code?: string }).code;
    switch (code) {
      case 'FST_ERR_CTP_BODY_TOO_LARGE':
        reply
          .code(413)
          .header(ERROR_SOURCE_HEADER, 'webui')
          .header('cache-control', 'no-store')
          .send(
            webuiErrorBody(
              new WebuiError('WEBUI_PAYLOAD_TOO_LARGE', { message: '请求体超过 WebUI 允许的上限' }),
              requestId,
            ),
          );
        return;
      case 'FST_ERR_CTP_INVALID_MEDIA_TYPE':
        reply
          .code(415)
          .header(ERROR_SOURCE_HEADER, 'webui')
          .header('cache-control', 'no-store')
          .send(webuiErrorBody(new WebuiError('WEBUI_UNSUPPORTED_CONTENT_TYPE'), requestId));
        return;
      case 'FST_ERR_CTP_EMPTY_JSON_BODY':
      // 畸形 JSON（如 `{bad`）在 Fastify 5 里是 FST_ERR_CTP_INVALID_JSON_BODY、状态 400。
      // 漏掉它会让任何未认证客户端用一行坏 JSON 触发 500 并污染 error 日志。
      case 'FST_ERR_CTP_INVALID_JSON_BODY':
      case 'FST_ERR_VALIDATION':
        reply
          .code(400)
          .header(ERROR_SOURCE_HEADER, 'webui')
          .header('cache-control', 'no-store')
          .send(webuiErrorBody(new WebuiError('WEBUI_INVALID_REQUEST', { message: '请求格式不合法' }), requestId));
        return;
      default:
        break;
    }

    // 未知错误：不回显原始报文，只记录 code/status 与请求方法、路由模板
    app.log.error(
      { code: code ?? 'UNKNOWN', status: (error as { statusCode?: number }).statusCode ?? 500, route: request.routeOptions?.url },
      'unhandled error',
    );
    reply
      .code(500)
      .header(ERROR_SOURCE_HEADER, 'webui')
      .header('cache-control', 'no-store')
      .send(webuiErrorBody(new WebuiError('WEBUI_INTERNAL'), requestId));
  });

  registerHealthRoutes(app, ctx);

  // 认证与元信息接口（BFF 自有契约）
  app.get('/webui/bff/bootstrap', (request, reply) => handleBootstrap(request, reply, ctx));
  // login 的合法请求体只有 {"managementKey": "..."}，16 KB 绰绰有余。
  // 必须在路由级设 bodyLimit，否则 5 MiB 的全局上限会先把请求体整个读进内存，
  // 再由 handler 内的 16 KB 检查拒绝——容器只有 32 MiB tmpfs，属于内存放大点。
  app.post('/webui/bff/auth/login', { bodyLimit: LOGIN_ROUTE_BODY_LIMIT_BYTES }, (request, reply) =>
    handleLogin(request, reply, ctx),
  );
  app.get('/webui/bff/auth/session', (request, reply) => handleSession(request, reply, ctx));
  app.post('/webui/bff/auth/logout', (request, reply) => handleLogout(request, reply, ctx));
  app.get('/webui/bff/diagnostics', (request, reply) => handleDiagnostics(request, reply, ctx));

  registerManagementProxy(app, ctx);
  registerStaticRoutes(app, ctx);
  registerSpaFallback(app, ctx);

  app.addHook('onClose', async () => {
    await ctx.dispose();
  });

  return app;
}

declare module 'fastify' {
  interface FastifyInstance {
    webui: AppContext;
  }
}
