/**
 * 健康检查与静态资源托管。
 *
 * 健康检查只用于容器/入口内部探活，不对公网转发（Nginx 片段直接 404），
 * 且不得泄露管理密钥或内部拓扑（实施文档 8.1 / 9.7）。
 */

import type { FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AppContext } from '../context.js';
import { assertHost } from '../security/request-guard.js';
import { WebuiError } from '../errors.js';

export function registerHealthRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/webui/health/live', async (request, reply) => {
    // 容器存活检查允许内部 Host（docker healthcheck 使用 127.0.0.1:3000）
    assertHost(request, ctx.config, true);
    reply.header('cache-control', 'no-store');
    reply.send({ status: 'ok', service: 'parrot-webui', uptimeSeconds: Math.round((Date.now() - ctx.startedAt) / 1000) });
  });

  app.get('/webui/health/ready', async (request, reply) => {
    assertHost(request, ctx.config, true);
    const probe = await ctx.upstream.probeManagement({ maxAgeMs: 10_000 });
    const staticReady = ctx.ready.staticAssetsPresent;
    const ready = staticReady;
    reply.header('cache-control', 'no-store');
    reply.code(ready ? 200 : 503).send({
      status: ready ? 'ready' : 'not-ready',
      staticAssetsPresent: staticReady,
      // 只给出最小上游可达状态，不含任何凭据或内部地址
      upstream: { reachable: probe.reachable, managementApiDetected: probe.managementApiDetected },
      webui: { basePath: ctx.config.basePath },
    });
  });
}

/**
 * 静态资源与 SPA fallback。
 * 只处理 /webui/ 下的页面导航：不吞掉 /webui/bff/*、/webui/health/*、缺失静态资源或 Parrot 原路径。
 */
export function registerStaticRoutes(app: FastifyInstance, ctx: AppContext): boolean {
  const root = ctx.config.staticDir;
  const indexFile = join(root, 'index.html');
  if (!existsSync(indexFile)) {
    ctx.ready.staticAssetsPresent = false;
    app.log.warn(
      { staticDir: root },
      '未找到前端构建产物（index.html）；API 与登录页仍可用，但页面不会渲染。请先执行 pnpm --filter @parrot-webui/web build',
    );
    return false;
  }
  ctx.ready.staticAssetsPresent = true;

  app.register(fastifyStatic, {
    root,
    prefix: '/webui/',
    index: ['index.html'],
    // 交给自定义 notFoundHandler 处理 SPA fallback
    wildcard: true,
    // 关闭插件自带的 Cache-Control 计算，缓存策略完全由 setHeaders 决定
    cacheControl: false,
    setHeaders(response, filePath) {
      if (filePath.endsWith('index.html')) {
        // index.html 必须重新验证，避免前端发版后仍指向旧资源
        response.setHeader('cache-control', 'no-cache, must-revalidate');
        return;
      }
      if (/[/\\]assets[/\\]/.test(filePath)) {
        // 带 hash 的静态资源可以长期缓存
        response.setHeader('cache-control', 'public, max-age=31536000, immutable');
        return;
      }
      response.setHeader('cache-control', 'public, max-age=3600');
    },
  });

  // /webui → /webui/（深链接与相对资源都依赖尾斜杠）
  app.get('/webui', async (_request, reply) => {
    reply.redirect('/webui/', 308);
  });

  return true;
}
/** SPA fallback：仅处理 /webui/ 下的页面导航，其余保持 JSON 404。 */
export function registerSpaFallback(app: FastifyInstance, ctx: AppContext): void {
  app.setNotFoundHandler(async (request, reply) => {
    const pathname = (request.raw.url ?? '').split('?')[0] ?? '';
    const acceptsHtml = String(request.headers.accept ?? '').includes('text/html');
    const isApi = pathname.startsWith('/webui/bff/') || pathname.startsWith('/webui/health/');
    const isAsset = pathname.startsWith('/webui/assets/') || /\.[a-z0-9]+$/i.test(pathname);

    if (isApi || isAsset || !pathname.startsWith('/webui')) {
      throw new WebuiError('WEBUI_NOT_FOUND', { message: `未找到 ${pathname}` });
    }

    if (!ctx.ready.staticAssetsPresent) {
      throw new WebuiError('WEBUI_NOT_READY', {
        message: '前端静态资源尚未构建；请在容器内完成 pnpm build，或使用开发服务器访问',
      });
    }

    if (!acceptsHtml) {
      throw new WebuiError('WEBUI_NOT_FOUND', { message: `未找到 ${pathname}` });
    }

    reply.header('cache-control', 'no-cache, must-revalidate');
    return reply.sendFile('index.html');
  });
}
