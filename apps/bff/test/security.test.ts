/**
 * BFF 安全边界测试（对应实施文档 5.1–5.5 与 11.1 BFF 必需清单）。
 *
 * 全部通过 `app.inject()` 走真实 Fastify 路由，并用本地假上游记录"是否被触达"。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UPSTREAM_MANAGEMENT_PREFIX } from '@parrot-webui/contracts/routes';
import { WebuiError } from '../src/errors.js';
import { assertSafeRequestPath, matchProxyRoute, sanitizeUpstreamQuery } from '../src/security/route-allowlist.js';
import {
  createHarness,
  findCookie,
  sendJson,
  sleep,
  startFakeUpstream,
  TEST_MANAGEMENT_KEY,
  UPSTREAM_LOGIN_PATH,
  UPSTREAM_META_PATH,
  type FakeUpstream,
  type Harness,
  type HarnessOptions,
} from './helpers.js';

const opened: Harness[] = [];

async function open(options?: HarnessOptions): Promise<Harness> {
  const harness = await createHarness(options);
  opened.push(harness);
  return harness;
}

/** 假上游收到的全部请求（method + path + query），用于断言"没有触达上游"。 */
function traffic(upstream: FakeUpstream): string[] {
  return upstream.requests.map((item) => `${item.method} ${item.path}${item.query ? `?${item.query}` : ''}`);
}

interface ErrorEnvelope {
  error?: { code?: string; message?: string; source?: string };
}

function codeOf(res: { json: () => unknown }): string {
  return (res.json() as ErrorEnvelope).error?.code ?? '';
}

/** 正向登录（断言成功），返回会话 Cookie、CSRF 与上游凭证。 */
async function loggedIn(h: Harness): Promise<{ cookie: string; csrfToken: string; credential: string }> {
  const result = await h.login();
  expect(result.res.statusCode).toBe(200);
  const credential = h.issuedCredentials.at(-1) ?? '';
  expect(credential).not.toBe('');
  return { cookie: result.sessionCookie, csrfToken: result.csrfToken, credential };
}

function expectWebuiError(run: () => unknown, code: string): void {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(WebuiError);
  expect((caught as WebuiError).code).toBe(code);
}

describe('BFF 业务代理安全边界', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await open();
  });

  afterEach(async () => {
    while (opened.length) {
      const harness = opened.pop();
      if (harness) await harness.close();
    }
  });

  it('未登录访问业务接口返回 401，且完全不触达上游', async () => {
    for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
      const res = await h.inject({ method, url: '/webui/bff/management/channels' });
      expect(res.statusCode, method).toBe(401);
      expect(codeOf(res), method).toBe('WEBUI_SESSION_REQUIRED');
      expect((res.json() as ErrorEnvelope).error?.source).toBe('webui');
    }
    expect(traffic(h.upstream)).toEqual([]);
  });

  it('Host 与部署域名不一致时拒绝，且不触达上游', async () => {
    const res = await h.inject({
      url: '/webui/bff/management/channels',
      headers: { host: 'attacker.test' },
    });
    expect(res.statusCode).toBe(421);
    expect(codeOf(res)).toBe('WEBUI_HOST_REJECTED');
    expect(traffic(h.upstream)).toEqual([]);
  });

  it('写请求缺 Origin / Origin:null / Origin 错误一律 403 WEBUI_ORIGIN_REJECTED', async () => {
    const { cookie, csrfToken } = await loggedIn(h);
    const before = traffic(h.upstream);

    const missing = await h.inject({
      method: 'POST',
      url: '/webui/bff/management/channels',
      cookies: [cookie],
      json: { name: 'test-channel' },
      headers: h.writeHeaders({ cookies: [cookie], csrfToken, origin: null }),
    });
    const nullOrigin = await h.inject({
      method: 'POST',
      url: '/webui/bff/management/channels',
      cookies: [cookie],
      json: { name: 'test-channel' },
      headers: h.writeHeaders({ cookies: [cookie], csrfToken, origin: 'null' }),
    });
    const otherOrigin = await h.inject({
      method: 'POST',
      url: '/webui/bff/management/channels',
      cookies: [cookie],
      json: { name: 'test-channel' },
      headers: h.writeHeaders({ cookies: [cookie], csrfToken, origin: 'https://attacker.test' }),
    });
    const wrongScheme = await h.inject({
      method: 'POST',
      url: '/webui/bff/management/channels',
      cookies: [cookie],
      json: { name: 'test-channel' },
      headers: h.writeHeaders({ cookies: [cookie], csrfToken, origin: 'https://webui.test' }),
    });

    for (const [label, res] of [
      ['缺 Origin', missing],
      ['Origin:null', nullOrigin],
      ['Origin 错误', otherOrigin],
      ['Origin 协议不匹配', wrongScheme],
    ] as const) {
      expect(res.statusCode, label).toBe(403);
      expect(codeOf(res), label).toBe('WEBUI_ORIGIN_REJECTED');
    }
    expect(traffic(h.upstream)).toEqual(before);

    // 正向对照：正确 Origin + 正确 CSRF 才允许转发
    const ok = await h.inject({
      method: 'POST',
      url: '/webui/bff/management/channels',
      cookies: [cookie],
      json: { name: 'test-channel' },
      headers: h.writeHeaders({ cookies: [cookie], csrfToken }),
    });
    expect(ok.statusCode).toBe(200);
    expect(traffic(h.upstream)).toEqual([...before, 'POST /api/management/v1/channels']);
  });

  it('缺 CSRF 或 CSRF 错误一律 403 WEBUI_CSRF_REJECTED，且不触达上游', async () => {
    const { cookie, csrfToken } = await loggedIn(h);
    const before = traffic(h.upstream);

    const missing = await h.inject({
      method: 'PATCH',
      url: '/webui/bff/management/channels/ch-1',
      cookies: [cookie],
      json: { enabled: false },
      headers: h.writeHeaders({ cookies: [cookie] }),
    });
    const wrong = await h.inject({
      method: 'PATCH',
      url: '/webui/bff/management/channels/ch-1',
      cookies: [cookie],
      json: { enabled: false },
      headers: h.writeHeaders({ cookies: [cookie], csrfToken: 'not-the-session-csrf-token' }),
    });
    const fromPrelogin = await h.inject({
      method: 'PATCH',
      url: '/webui/bff/management/channels/ch-1',
      cookies: [cookie],
      json: { enabled: false },
      headers: h.writeHeaders({ cookies: [cookie], csrfToken: 'x'.repeat(43) }),
    });

    for (const [label, res] of [
      ['缺 CSRF', missing],
      ['CSRF 错误', wrong],
      ['CSRF 长度相同但内容错误', fromPrelogin],
    ] as const) {
      expect(res.statusCode, label).toBe(403);
      expect(codeOf(res), label).toBe('WEBUI_CSRF_REJECTED');
    }
    expect(traffic(h.upstream)).toEqual(before);

    const ok = await h.inject({
      method: 'PATCH',
      url: '/webui/bff/management/channels/ch-1',
      cookies: [cookie],
      json: { enabled: false },
      headers: h.writeHeaders({ cookies: [cookie], csrfToken }),
    });
    expect(ok.statusCode).toBe(200);
  });

  it('登录接口同样受 Origin / CSRF 保护，失败时不触达上游', async () => {
    const noOrigin = await h.inject({
      method: 'POST',
      url: '/webui/bff/auth/login',
      json: { managementKey: TEST_MANAGEMENT_KEY },
    });
    expect(noOrigin.statusCode).toBe(403);
    expect(codeOf(noOrigin)).toBe('WEBUI_ORIGIN_REJECTED');

    const noPrelogin = await h.inject({
      method: 'POST',
      url: '/webui/bff/auth/login',
      json: { managementKey: TEST_MANAGEMENT_KEY },
      headers: { origin: h.config.publicOrigin, 'x-csrf-token': 'a'.repeat(43) },
    });
    expect(noPrelogin.statusCode).toBe(403);
    expect(codeOf(noPrelogin)).toBe('WEBUI_CSRF_REJECTED');
    expect(traffic(h.upstream)).toEqual([]);

    // 有预登录 Cookie，但 CSRF 与预登录会话不匹配 → 仍然 403
    const boot = await h.bootstrap();
    const wrongPreloginCsrf = await h.inject({
      method: 'POST',
      url: '/webui/bff/auth/login',
      json: { managementKey: TEST_MANAGEMENT_KEY },
      cookies: [boot.preloginCookie],
      headers: { origin: h.config.publicOrigin, 'x-csrf-token': 'b'.repeat(43) },
    });
    expect(wrongPreloginCsrf.statusCode).toBe(403);
    expect(codeOf(wrongPreloginCsrf)).toBe('WEBUI_CSRF_REJECTED');
    expect(h.upstream.requestsFor(UPSTREAM_LOGIN_PATH)).toEqual([]);

    // 正向对照：Origin + 预登录 Cookie + 正确 CSRF 才换票
    const ok = await h.login();
    expect(ok.res.statusCode).toBe(200);
    expect(h.upstream.requestsFor(UPSTREAM_LOGIN_PATH)).toHaveLength(1);
  });

  it('路径穿越、编码斜杠/反斜杠、协议相对 URL 与未列入清单的路径都被拒绝且不触达上游', async () => {
    const { cookie } = await loggedIn(h);
    const before = traffic(h.upstream);

    const attacks = [
      '/webui/bff/management/channels/../../meta',
      '/webui/bff/management/logs/../../../../updates/check',
      '/webui/bff/management/channels%2f..%2f..%2fmeta',
      '/webui/bff/management/channels%2F..%2F..%2Fmeta',
      '/webui/bff/management/channels%5c..%5c..%5cmeta',
      '/webui/bff/management/channels\\..\\..\\meta',
      '/webui/bff/management//channels',
      '//attacker.test/webui/bff/management/channels',
      '/webui/bff/management/%252e%252e/%252e%252e/meta',
      '/webui/bff/management/%252f%252fmeta',
      '/webui/bff/management/updates/check',
      '/webui/bff/management/updates/actions/apply',
      '/webui/bff/management/system/info',
      '/webui/bff/management/system/restart',
    ];

    for (const url of attacks) {
      const res = await h.inject({ url, cookies: [cookie] });
      expect([400, 404], `攻击路径 ${url} 的状态码为 ${res.statusCode}`).toContain(res.statusCode);
      const code = codeOf(res);
      expect(code.startsWith('WEBUI_'), `攻击路径 ${url} 返回 code=${code}`).toBe(true);
      expect(code, `攻击路径 ${url} 不得返回成功`).not.toBe('');
    }
    expect(traffic(h.upstream)).toEqual(before);
  });

  it('路径规范化函数拒绝越界、编码斜杠/反斜杠、协议相对与非法编码', () => {
    const rejected = [
      '/channels/../../meta',
      '/channels/%2e%2e/meta',
      '/channels/./meta',
      '/channels%2f..%2fmeta',
      '/channels%5c..%5cmeta',
      '/channels/%zz',
      '\\..\\..\\meta',
      '//attacker.test/channels',
      '/channels/',
    ];
    for (const raw of rejected) {
      expectWebuiError(() => assertSafeRequestPath(raw), 'WEBUI_INVALID_REQUEST');
    }

    // 正常资源标识仍然可用（不因为安全校验而关闭全部带特殊字符的 ID）
    expect(assertSafeRequestPath('/channels/ch-1')).toEqual(['channels', 'ch-1']);
    expect(assertSafeRequestPath('/models/openai%20gpt-4o')).toEqual(['models', 'openai gpt-4o']);

    // query 里的目标地址、越界内容与危险键都被拒绝
    expectWebuiError(() => sanitizeUpstreamQuery('url=http://attacker.test'), 'WEBUI_INVALID_REQUEST');
    expectWebuiError(() => sanitizeUpstreamQuery('q=../../etc/passwd'), 'WEBUI_INVALID_REQUEST');
    expectWebuiError(() => sanitizeUpstreamQuery('target=%2F%2Fattacker.test'), 'WEBUI_INVALID_REQUEST');
    expect(sanitizeUpstreamQuery('limit=20&cursor=abc')).toBe('?limit=20&cursor=abc');
    expect(sanitizeUpstreamQuery('')).toBe('');
  });

  it('允许清单匹配：未知路径 404、方法不支持 405、auth 路由不进入业务代理', () => {
    expectWebuiError(() => matchProxyRoute('GET', '/updates/check'), 'WEBUI_ROUTE_NOT_ALLOWED');
    expectWebuiError(() => matchProxyRoute('GET', '/system/info'), 'WEBUI_ROUTE_NOT_ALLOWED');
    expectWebuiError(() => matchProxyRoute('DELETE', '/channels'), 'WEBUI_METHOD_NOT_ALLOWED');
    expectWebuiError(() => matchProxyRoute('GET', '/auth/session'), 'WEBUI_ROUTE_NOT_ALLOWED');
    expectWebuiError(() => matchProxyRoute('POST', '/auth/sessions'), 'WEBUI_ROUTE_NOT_ALLOWED');
    expectWebuiError(() => matchProxyRoute('DELETE', '/auth/session'), 'WEBUI_ROUTE_NOT_ALLOWED');

    const match = matchProxyRoute('GET', '/channels/ch-1');
    expect(match.route.method).toBe('GET');
    expect(match.route.upstreamOperationId).toBe('getChannel');
    expect(match.params).toEqual({ channelId: 'ch-1' });
    expect(match.upstreamPath).toBe(`${UPSTREAM_MANAGEMENT_PREFIX}/channels/ch-1`);
  });

  it('上游 auth 类路由不能通过业务代理访问，且不触达上游', async () => {
    const { cookie, csrfToken } = await loggedIn(h);
    const before = traffic(h.upstream);

    const getSession = await h.inject({ url: '/webui/bff/management/auth/session', cookies: [cookie] });
    expect(getSession.statusCode).toBe(404);
    expect(codeOf(getSession)).toBe('WEBUI_ROUTE_NOT_ALLOWED');

    const postSessions = await h.inject({
      method: 'POST',
      url: '/webui/bff/management/auth/sessions',
      cookies: [cookie],
      json: { grantType: 'managementKey', managementKey: TEST_MANAGEMENT_KEY },
      headers: h.writeHeaders({ cookies: [cookie], csrfToken }),
    });
    expect(postSessions.statusCode).toBe(404);
    const deleteSession = await h.inject({
      method: 'DELETE',
      url: '/webui/bff/management/auth/session',
      cookies: [cookie],
      headers: h.writeHeaders({ cookies: [cookie], csrfToken }),
    });
    expect(deleteSession.statusCode).toBe(404);
    expect(codeOf(deleteSession)).toBe('WEBUI_ROUTE_NOT_ALLOWED');

    expect(traffic(h.upstream)).toEqual(before);
  });

  it('上游 302 不被携带凭据跟随：502 WEBUI_UPSTREAM_REDIRECT_BLOCKED', async () => {
    const { cookie } = await loggedIn(h);
    const redirectTarget = await startFakeUpstream((_request, response) => {
      sendJson(response, 200, { data: 'should-never-be-called' });
    });
    try {
      h.upstream.setResponder((request, response) => {
        if (request.path === UPSTREAM_META_PATH) {
          sendJson(response, 401, { error: { code: 'SESSION_REQUIRED' } });
          return;
        }
        response.writeHead(302, { location: `${redirectTarget.origin}/steal-credential` });
        response.end();
      });

      const res = await h.inject({ url: '/webui/bff/management/channels', cookies: [cookie] });
      expect(res.statusCode).toBe(502);
      expect(codeOf(res)).toBe('WEBUI_UPSTREAM_REDIRECT_BLOCKED');

      await sleep(100);
      expect(redirectTarget.requests).toEqual([]);
    } finally {
      await redirectTarget.close();
    }
  });

  it('上游返回 HTML（非 JSON）转成 502 WEBUI_UPSTREAM_UNEXPECTED_CONTENT', async () => {
    const { cookie } = await loggedIn(h);
    h.upstream.setResponder((request, response) => {
      if (request.path === UPSTREAM_META_PATH) {
        sendJson(response, 401, { error: { code: 'SESSION_REQUIRED' } });
        return;
      }
      response.writeHead(500, { 'content-type': 'text/html; charset=utf-8' });
      response.end('<!doctype html><html><body><h1>Internal Server Error</h1></body></html>');
    });

    const res = await h.inject({ url: '/webui/bff/management/channels', cookies: [cookie] });
    expect(res.statusCode).toBe(502);
    expect(codeOf(res)).toBe('WEBUI_UPSTREAM_UNEXPECTED_CONTENT');
    expect(res.body).not.toContain('<html>');
    expect(res.headers['content-type']).toContain('application/json');
  });

  it('上游拒绝连接：502 WEBUI_UPSTREAM_UNREACHABLE', async () => {
    const unreachable = await open();
    const { cookie } = await loggedIn(unreachable);
    await unreachable.upstream.close();

    const res = await unreachable.inject({ url: '/webui/bff/management/channels', cookies: [cookie] });
    expect(res.statusCode).toBe(502);
    expect(codeOf(res)).toBe('WEBUI_UPSTREAM_UNREACHABLE');
  });

  it('上游响应超过 requestTimeoutMs：504 WEBUI_UPSTREAM_TIMEOUT，且不自动重放写请求', async () => {
    const slow = await open({ config: { connectTimeoutMs: 200, requestTimeoutMs: 300 } });
    const { cookie, csrfToken } = await loggedIn(slow);
    const before = slow.upstream.requests.length;

    slow.upstream.setResponder(async (_request, response) => {
      await sleep(1500);
      if (!response.destroyed && !response.writableEnded) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{"data":{"ok":true}}');
      }
    });

    const read = await slow.inject({ url: '/webui/bff/management/channels', cookies: [cookie] });
    expect(read.statusCode).toBe(504);
    expect(codeOf(read)).toBe('WEBUI_UPSTREAM_TIMEOUT');
    expect((read.json() as ErrorEnvelope).error?.message).toContain('写操作结果未知');

    const write = await slow.inject({
      method: 'POST',
      url: '/webui/bff/management/channels',
      cookies: [cookie],
      json: { name: 'slow-channel' },
      headers: slow.writeHeaders({ cookies: [cookie], csrfToken }),
    });
    expect(write.statusCode).toBe(504);
    expect(codeOf(write)).toBe('WEBUI_UPSTREAM_TIMEOUT');

    // 只发送一次，不自动重发：超时请求各自只在上游出现一次
    expect(slow.upstream.requests.length - before).toBe(2);
    await sleep(1500);
    expect(slow.upstream.requests.length - before).toBe(2);
  });

  it('上游响应超过 maxUpstreamResponseBytes：502 WEBUI_RESPONSE_TOO_LARGE（声明长度与流式两种）', async () => {
    const small = await open({ config: { maxUpstreamResponseBytes: 4096 } });
    const { cookie } = await loggedIn(small);
    const huge = JSON.stringify({ data: { blob: 'x'.repeat(200_000) } });

    small.upstream.setResponder((request, response) => {
      if (request.path === UPSTREAM_META_PATH) {
        sendJson(response, 401, { error: { code: 'SESSION_REQUIRED' } });
        return;
      }
      response.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': String(Buffer.byteLength(huge)),
      });
      response.end(huge);
    });

    const declared = await small.inject({ url: '/webui/bff/management/channels', cookies: [cookie] });
    expect(declared.statusCode).toBe(502);
    expect(codeOf(declared)).toBe('WEBUI_RESPONSE_TOO_LARGE');
    expect(declared.body).not.toContain('xxxxx');

    small.upstream.setResponder((request, response) => {
      if (request.path === UPSTREAM_META_PATH) {
        sendJson(response, 401, { error: { code: 'SESSION_REQUIRED' } });
        return;
      }
      // 不声明长度 → chunked，走累计体积判断
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      for (let index = 0; index < 40; index += 1) response.write(`{"data":"${'y'.repeat(1000)}"}\n`);
      response.end();
    });

    const streamed = await small.inject({ url: '/webui/bff/management/channels', cookies: [cookie] });
    expect(streamed.statusCode).toBe(502);
    expect(codeOf(streamed)).toBe('WEBUI_RESPONSE_TOO_LARGE');
  });

  it('204 / 409 信封 / 429+Retry-After / revision / query 原样保留', async () => {
    const { cookie, csrfToken } = await loggedIn(h);
    h.upstream.setResponder((request, response) => {
      if (request.path === UPSTREAM_META_PATH) {
        sendJson(response, 401, { error: { code: 'SESSION_REQUIRED' } });
        return;
      }
      if (request.method === 'DELETE') {
        response.writeHead(204);
        response.end();
        return;
      }
      if (request.method === 'PATCH') {
        sendJson(
          response,
          409,
          {
            error: { code: 'REVISION_CONFLICT', message: '资源已被其他人修改', fields: { revision: 'rev-2' } },
            meta: { requestId: 'upstream-request-409' },
          },
          { 'x-request-id': 'upstream-request-409' },
        );
        return;
      }
      sendJson(response, 429, { error: { code: 'RATE_LIMITED', message: '上游限流' } }, { 'retry-after': '7' });
    });

    const removed = await h.inject({
      method: 'DELETE',
      url: '/webui/bff/management/channels/ch-1',
      cookies: [cookie],
      headers: h.writeHeaders({ cookies: [cookie], csrfToken }),
    });
    expect(removed.statusCode).toBe(204);
    expect(removed.body).toBe('');
    expect(removed.headers['x-webui-response-source']).toBe('upstream');

    const conflict = await h.inject({
      method: 'PATCH',
      url: '/webui/bff/management/channels/ch-1',
      cookies: [cookie],
      json: { enabled: false },
      headers: h.writeHeaders({ cookies: [cookie], csrfToken, extra: { 'if-match': 'rev-1' } }),
    });
    expect(conflict.statusCode).toBe(409);
    const conflictBody = conflict.json() as { error: { code: string; fields: { revision: string } }; meta: { requestId: string } };
    expect(conflictBody.error.code).toBe('REVISION_CONFLICT');
    expect(conflictBody.error.fields.revision).toBe('rev-2');
    expect(conflictBody.meta.requestId).toBe('upstream-request-409');
    expect(conflict.headers['x-upstream-request-id']).toBe('upstream-request-409');
    expect(h.upstream.requestsFor('/api/management/v1/channels/ch-1').at(-1)?.headers['if-match']).toBe('rev-1');

    const limited = await h.inject({ url: '/webui/bff/management/logs?limit=20', cookies: [cookie] });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBe('7');
    expect((limited.json() as ErrorEnvelope).error?.code).toBe('RATE_LIMITED');
    expect(h.upstream.requests.at(-1)?.query).toBe('limit=20');
  });

  it('转发头白名单：不转发浏览器 Cookie/Origin/Referer/Host/XFF，Bearer 由 BFF 设置', async () => {
    const { cookie, csrfToken, credential } = await loggedIn(h);

    const res = await h.inject({
      method: 'POST',
      url: '/webui/bff/management/channels',
      json: { name: 'test-channel' },
      headers: h.writeHeaders({
        cookies: [cookie],
        csrfToken,
        extra: {
          'if-match': 'rev-1',
          'idempotency-key': 'idem-1',
          'x-request-id': 'browser-request-1',
          authorization: 'Bearer browser-supplied-token',
          referer: 'https://attacker.test/',
          'x-forwarded-for': '198.51.100.66',
          'x-forwarded-host': 'attacker.test',
          'x-forwarded-proto': 'https',
          'x-real-ip': '198.51.100.66',
          'proxy-authorization': 'Basic dGVzdDp0ZXN0',
        },
      }),
    });
    expect(res.statusCode).toBe(200);

    const received = h.upstream.requests.at(-1);
    expect(received).toBeDefined();
    expect(received?.method).toBe('POST');
    expect(received?.path).toBe('/api/management/v1/channels');
    expect(received?.body).toBe(JSON.stringify({ name: 'test-channel' }));
    expect(received?.headers.authorization).toBe(`Bearer ${credential}`);
    expect(received?.headers.authorization).not.toContain('browser-supplied-token');
    expect(received?.headers['if-match']).toBe('rev-1');
    expect(received?.headers['idempotency-key']).toBe('idem-1');
    expect(received?.headers['x-request-id']).toBe('browser-request-1');
    expect(received?.headers['content-type']).toBe('application/json');

    const forbidden = [
      'cookie',
      'origin',
      'referer',
      'x-forwarded-for',
      'x-forwarded-host',
      'x-forwarded-proto',
      'x-real-ip',
      'proxy-authorization',
    ];
    for (const name of forbidden) {
      expect(received?.headers[name], `不得转发 ${name}`).toBeUndefined();
    }
    // Host 是上游自己的地址，不是浏览器的 Host
    expect(received?.headers.host).toBe(h.upstream.host);
    expect(received?.headers.host).not.toBe(h.config.publicHost);

    const allowed = new Set([
      'accept',
      'content-type',
      'if-match',
      'idempotency-key',
      'x-request-id',
      'authorization',
      'host',
      'connection',
      'content-length',
      'accept-encoding',
      'transfer-encoding',
    ]);
    for (const name of Object.keys(received!.headers)) {
      expect(allowed.has(name), `上游收到未白名单化的请求头 ${name}`).toBe(true);
    }
  });

  it('bootstrap 单来源限流：超过上限返回 429 且带 retry-after，不影响其他来源', async () => {
    const limited = await open({ config: { bootstrapPerSourcePerMinute: 3, bootstrapGlobalPerMinute: 100 } });

    for (let index = 0; index < 3; index += 1) {
      const res = await limited.inject({ url: '/webui/bff/bootstrap' });
      expect(res.statusCode, `第 ${index + 1} 次 bootstrap`).toBe(200);
    }

    const blocked = await limited.inject({ url: '/webui/bff/bootstrap' });
    expect(blocked.statusCode).toBe(429);
    expect(codeOf(blocked)).toBe('WEBUI_RATE_LIMITED');
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    // 被限流的请求不会建立新的预登录会话
    expect(findCookie(blocked, limited.preloginCookieName)).toBeUndefined();

    // 不同来源（可信代理给出不同客户端地址）不受影响，避免所有用户共享同一额度
    const otherSource = await limited.inject({ url: '/webui/bff/bootstrap', remoteAddress: '198.51.100.9' });
    expect(otherSource.statusCode).toBe(200);
    expect(findCookie(otherSource, limited.preloginCookieName)).toBeDefined();
  });
});
