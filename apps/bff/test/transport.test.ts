/**
 * BFF 传输层与交付层回归测试。
 *
 * 覆盖评审中确认的五类"零覆盖"关键路径：
 *  1. 畸形 JSON 必须 400（曾因漏映射 FST_ERR_CTP_INVALID_JSON_BODY 而返回 500）
 *  2. login 路由级 16KB bodyLimit（曾必须先吃满 5MiB 全局上限才拒绝）
 *  3. 健康检查语义：ready 不因上游不可达而失败（上游不可达是正常运维状态）
 *  4. 生产模式 Cookie 属性（__Secure- / Secure / HttpOnly / SameSite / Path）与 HSTS
 *  5. 静态资源：sourcemap 一律不托管、预压缩产物按 Accept-Encoding 下发
 *
 * 全部走真实 `buildServer(config)` + `app.inject()`，不依赖网络。
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeConfig, sendJson, startFakeUpstream, UPSTREAM_META_PATH, type FakeUpstream } from './helpers.js';
import { buildServer } from '../src/server.js';
import { cookieNames } from '../src/auth/cookies.js';

interface Cleanup {
  close(): Promise<void>;
}

const cleanups: Cleanup[] = [];

afterEach(async () => {
  while (cleanups.length) {
    const item = cleanups.pop();
    if (item) await item.close();
  }
});

/** 造一个最小但真实的静态产物目录：index.html + 一个 assets 分块 + 一个 .map。 */
function makeStaticFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'webui-static-'));
  const assets = join(dir, 'assets');
  mkdirSync(assets, { recursive: true });
  writeFileSync(join(dir, 'index.html'), '<!doctype html><html><body>fixture</body></html>', 'utf8');
  writeFileSync(join(assets, 'index-abc123.js'), 'console.log("chunk");\n'.repeat(40), 'utf8');
  writeFileSync(join(assets, 'index-abc123.js.map'), '{"version":3,"sources":["secret-source.ts"]}', 'utf8');
  // 预压缩兄弟文件：内容差异足够明显，便于断言"下发的是压缩后的那份"
  writeFileSync(join(assets, 'index-abc123.js.br'), 'BROTLI-PAYLOAD', 'utf8');
  writeFileSync(join(assets, 'index-abc123.js.gz'), 'GZIP-PAYLOAD', 'utf8');
  const indexBr = join(dir, 'index.html.br');
  writeFileSync(indexBr, 'INDEX-BR', 'utf8');
  return dir;
}

interface Harness {
  app: ReturnType<typeof buildServer>;
  upstream: FakeUpstream;
  config: ReturnType<typeof makeConfig>;
}

async function build(overrides: Parameters<typeof makeConfig>[1] = {}, staticDir?: string): Promise<Harness> {
  const upstream = await startFakeUpstream((request, response) => {
    if (request.path === UPSTREAM_META_PATH) {
      sendJson(response, 401, { error: { code: 'SESSION_REQUIRED' } });
      return;
    }
    sendJson(response, 200, { data: {} });
  });
  const config = makeConfig(upstream.origin, { staticDir: staticDir ?? join(tmpdir(), '__missing__'), ...overrides });
  const app = buildServer(config);
  await app.ready();
  const harness: Harness = { app, upstream, config };
  cleanups.push({
    async close() {
      await app.close();
      await upstream.close();
    },
  });
  return harness;
}

function withHost(config: Harness['config'], extra: Record<string, string> = {}): Record<string, string> {
  return { host: config.publicHost, ...extra };
}

// ------------------------------------------------------------------ 1. 畸形 JSON

describe('畸形 JSON 请求体', () => {
  it('语法错误的 JSON 返回 400 WEBUI_INVALID_REQUEST（不是 500）', async () => {
    const h = await build();
    const boot = await h.app.inject({ method: 'GET', url: '/webui/bff/bootstrap', headers: withHost(h.config) });
    expect(boot.statusCode).toBe(200);
    const csrfToken = boot.json<{ data: { csrfToken: string } }>().data.csrfToken;
    const cookie = boot.cookies.find((item) => item.name === cookieNames(h.config).prelogin);
    expect(cookie).toBeDefined();

    const res = await h.app.inject({
      method: 'POST',
      url: '/webui/bff/auth/login',
      headers: withHost(h.config, {
        origin: h.config.publicOrigin,
        'content-type': 'application/json',
        'x-csrf-token': csrfToken,
        cookie: `${cookie!.name}=${cookie!.value}`,
      }),
      payload: '{"managementKey": bad}',
    });

    expect(res.statusCode).toBe(400);
    const body = res.json<{ error: { code: string; source: string } }>();
    expect(body.error.code).toBe('WEBUI_INVALID_REQUEST');
    expect(body.error.source).toBe('webui');
    // 错误响应同样不能缓存（内容可能随后续重试变化）
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('空 JSON 体同样返回 400', async () => {
    const h = await build();
    const res = await h.app.inject({
      method: 'POST',
      url: '/webui/bff/auth/logout',
      headers: withHost(h.config, {
        origin: h.config.publicOrigin,
        'content-type': 'application/json',
      }),
      payload: '',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('WEBUI_INVALID_REQUEST');
  });
});

// ------------------------------------------------------------------ 2. login 体积

describe('login 请求体上限', () => {
  it('超过 16KB 直接在传输层 413，不进入业务校验', async () => {
    const h = await build();
    const res = await h.app.inject({
      method: 'POST',
      url: '/webui/bff/auth/login',
      headers: withHost(h.config, {
        origin: h.config.publicOrigin,
        'content-type': 'application/json',
      }),
      payload: JSON.stringify({ managementKey: 'x'.repeat(64 * 1024) }),
    });
    expect(res.statusCode).toBe(413);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('WEBUI_PAYLOAD_TOO_LARGE');
    // 传输层早拒：上游一次都不该被触达
    expect(h.upstream.requestsFor('/api/management/v1/auth/sessions')).toHaveLength(0);
  });

  it('未超限的合法请求体仍可正常进入业务逻辑', async () => {
    const h = await build();
    const res = await h.app.inject({
      method: 'POST',
      url: '/webui/bff/auth/login',
      headers: withHost(h.config, {
        origin: h.config.publicOrigin,
        'content-type': 'application/json',
      }),
      payload: JSON.stringify({ managementKey: 'short-key' }),
    });
    // 没有预登录 CSRF，应当被 403 挡下；关键是没有 413
    expect(res.statusCode).not.toBe(413);
    expect([400, 403]).toContain(res.statusCode);
  });
});

// ------------------------------------------------------------------ 3. 健康检查

describe('健康检查语义', () => {
  it('live 不依赖上游，永远 200', async () => {
    const h = await build();
    const res = await h.app.inject({ method: 'GET', url: '/webui/health/live', headers: withHost(h.config) });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ status: string }>().status).toBe('ok');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('上游不可达时 ready 仍是 200，只在 upstream 字段里体现（不触发容器重启）', async () => {
    const staticDir = makeStaticFixture();
    const h = await build({}, staticDir);
    await h.upstream.close();

    const res = await h.app.inject({ method: 'GET', url: '/webui/health/ready', headers: withHost(h.config) });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      status: string;
      staticAssetsPresent: boolean;
      upstream: { reachable: boolean };
    }>();
    expect(body.status).toBe('ready');
    expect(body.staticAssetsPresent).toBe(true);
    expect(body.upstream.reachable).toBe(false);

    rmSync(staticDir, { recursive: true, force: true });
  });

  it('静态产物缺失时 ready 返回 503 not-ready', async () => {
    const h = await build();
    const res = await h.app.inject({ method: 'GET', url: '/webui/health/ready', headers: withHost(h.config) });
    expect(res.statusCode).toBe(503);
    expect(res.json<{ status: string }>().status).toBe('not-ready');
  });
});

// ------------------------------------------------------------------ 4. 生产模式

describe('生产模式 Cookie 与安全头', () => {
  const productionOverrides = {
    nodeEnv: 'production',
    isProduction: true,
    cookieSecure: true,
    cookiePrefix: '__Secure-',
    allowInsecurePublicOrigin: false,
    publicOrigin: 'https://webui.example.com',
    publicHost: 'webui.example.com',
  };

  it('Cookie 必须是 __Secure- + Secure + HttpOnly + SameSite=Lax + Path=/webui/ 且不带 Domain', async () => {
    const h = await build(productionOverrides);
    const res = await h.app.inject({
      method: 'GET',
      url: '/webui/bff/bootstrap',
      headers: { host: 'webui.example.com' },
    });
    expect(res.statusCode).toBe(200);

    const raw = res.headers['set-cookie'];
    const serialized = Array.isArray(raw) ? raw.join('\n') : String(raw);
    expect(serialized).toContain('__Secure-parrot_webui_prelogin=');
    expect(serialized).toContain('Secure');
    expect(serialized).toContain('HttpOnly');
    expect(serialized).toContain('SameSite=Lax');
    expect(serialized).toContain('Path=/webui/');
    expect(serialized).not.toContain('Domain=');
  });

  it('生产模式下发 HSTS，且安全头齐全', async () => {
    const h = await build(productionOverrides);
    const res = await h.app.inject({ method: 'GET', url: '/webui/bff/bootstrap', headers: { host: 'webui.example.com' } });
    expect(res.headers['strict-transport-security']).toBe('max-age=31536000; includeSubDomains');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['cross-origin-opener-policy']).toBe('same-origin');
    expect(String(res.headers['content-security-policy'])).toContain("script-src 'self'");
    expect(String(res.headers['content-security-policy'])).toContain("frame-ancestors 'none'");
  });

  it('开发模式不下发 HSTS（避免本地 http 调试被浏览器强制升级）', async () => {
    const h = await build();
    const res = await h.app.inject({ method: 'GET', url: '/webui/health/live', headers: withHost(h.config) });
    expect(res.headers['strict-transport-security']).toBeUndefined();
  });
});

// ------------------------------------------------------------------ 5. 静态资源

describe('静态资源托管边界', () => {
  it('sourcemap 一律 404 —— 即使文件真实存在于 dist 里', async () => {
    const staticDir = makeStaticFixture();
    const h = await build({}, staticDir);

    const mapRes = await h.app.inject({
      method: 'GET',
      url: '/webui/assets/index-abc123.js.map',
      headers: withHost(h.config, { accept: 'application/json' }),
    });
    expect(mapRes.statusCode).toBe(404);
    expect(mapRes.json<{ error: { code: string } }>().error.code).toBe('WEBUI_NOT_FOUND');

    // 同一个目录下的 js 必须照常可取，证明 404 是定向规则而不是整体失效
    const jsRes = await h.app.inject({
      method: 'GET',
      url: '/webui/assets/index-abc123.js',
      headers: withHost(h.config),
    });
    expect(jsRes.statusCode).toBe(200);

    rmSync(staticDir, { recursive: true, force: true });
  });

  it('按 Accept-Encoding 下发预压缩产物，并正确标注 content-encoding', async () => {
    const staticDir = makeStaticFixture();
    const h = await build({}, staticDir);

    const brRes = await h.app.inject({
      method: 'GET',
      url: '/webui/assets/index-abc123.js',
      headers: withHost(h.config, { 'accept-encoding': 'br' }),
    });
    expect(brRes.statusCode).toBe(200);
    expect(brRes.headers['content-encoding']).toBe('br');
    expect(brRes.body).toBe('BROTLI-PAYLOAD');
    expect(String(brRes.headers['cache-control'])).toContain('immutable');

    const gzRes = await h.app.inject({
      method: 'GET',
      url: '/webui/assets/index-abc123.js',
      headers: withHost(h.config, { 'accept-encoding': 'gzip' }),
    });
    expect(gzRes.statusCode).toBe(200);
    expect(gzRes.headers['content-encoding']).toBe('gzip');
    expect(gzRes.body).toBe('GZIP-PAYLOAD');

    const plainRes = await h.app.inject({
      method: 'GET',
      url: '/webui/assets/index-abc123.js',
      headers: withHost(h.config, { 'accept-encoding': 'identity' }),
    });
    expect(plainRes.statusCode).toBe(200);
    expect(plainRes.headers['content-encoding']).toBeUndefined();
    expect(plainRes.body).toContain('console.log');

    rmSync(staticDir, { recursive: true, force: true });
  });

  it('index.html 必须 no-cache，assets 必须长期 immutable 缓存', async () => {
    const staticDir = makeStaticFixture();
    const h = await build({}, staticDir);

    const indexRes = await h.app.inject({ method: 'GET', url: '/webui/', headers: withHost(h.config) });
    expect(indexRes.statusCode).toBe(200);
    expect(indexRes.headers['cache-control']).toBe('no-cache, must-revalidate');

    const assetRes = await h.app.inject({
      method: 'GET',
      url: '/webui/assets/index-abc123.js',
      headers: withHost(h.config),
    });
    expect(assetRes.headers['cache-control']).toBe('public, max-age=31536000, immutable');

    rmSync(staticDir, { recursive: true, force: true });
  });

  it('SPA 深链接回退到 index.html，但 API/资源路径仍然 404', async () => {
    const staticDir = makeStaticFixture();
    const h = await build({}, staticDir);

    const spa = await h.app.inject({
      method: 'GET',
      url: '/webui/channels',
      headers: withHost(h.config, { accept: 'text/html' }),
    });
    expect(spa.statusCode).toBe(200);
    expect(spa.headers['cache-control']).toBe('no-cache, must-revalidate');

    const api = await h.app.inject({
      method: 'GET',
      url: '/webui/bff/unknown',
      headers: withHost(h.config, { accept: 'text/html' }),
    });
    expect(api.statusCode).toBe(404);

    const asset = await h.app.inject({
      method: 'GET',
      url: '/webui/assets/missing-xyz.js',
      headers: withHost(h.config, { accept: 'text/html' }),
    });
    expect(asset.statusCode).toBe(404);

    rmSync(staticDir, { recursive: true, force: true });
  });
});
