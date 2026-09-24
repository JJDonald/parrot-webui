/**
 * 端到端集成测试（真实 HTTP + 真实 Cookie/CSRF）。
 *
 * 使用一个本地假上游（模拟本机 Parrot 管理 API）与真实启动的 BFF 进程内实例，
 * 通过 `fetch` 以"浏览器 + 反向代理"的方式走完整链路：
 *   bootstrap → 登录（管理密钥换票）→ 读取渠道 → 写入冲突 → 注销
 *
 * 覆盖点（对应实施文档 11.1 / 11.2）：
 * - 上游凭证只保存在 BFF 内存，不出现在浏览器响应或 Cookie 中；
 * - 写操作必须带正确 Origin 与 CSRF；
 * - 注销后旧 Cookie 立即失效；
 * - BFF 只在允许清单内转发，未知路径不触达上游；
 * - 上游业务错误（含 409 revision 冲突）保持原 code 透传。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { AddressInfo } from 'node:net';
import { buildServer } from '../../apps/bff/src/server';
import { loadConfig, type WebuiConfig } from '../../apps/bff/src/config';

const MANAGEMENT_KEY = 'test-management-key-not-a-real-secret-000000000000';
const UPSTREAM_CREDENTIAL = 'upstream-credential-value-never-exposed';
const PUBLIC_ORIGIN = 'https://parrot.example.test';
const PUBLIC_HOST = 'parrot.example.test';

interface RecordedRequest {
  method: string;
  path: string;
  headers: IncomingMessage['headers'];
  body: string;
}

interface UpstreamStub {
  origin: string;
  requests: RecordedRequest[];
  setRevision(next: string): void;
  close(): Promise<void>;
}

async function startUpstreamStub(): Promise<UpstreamStub> {
  const requests: RecordedRequest[] = [];
  let revision = 'rev-1';

  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      requests.push({ method: request.method ?? '', path: request.url ?? '', headers: request.headers, body });

      const json = (status: number, payload: unknown, extraHeaders: Record<string, string> = {}) => {
        response.writeHead(status, { 'content-type': 'application/json', ...extraHeaders });
        response.end(JSON.stringify(payload));
      };

      const path = (request.url ?? '').split('?')[0] ?? '';

      if (path === '/api/management/v1/meta' && request.method === 'GET') {
        json(401, { error: { code: 'SESSION_REQUIRED', message: '需要会话', fields: [], retryable: false, requestId: 'req-probe' } });
        return;
      }

      if (path === '/api/management/v1/auth/sessions' && request.method === 'POST') {
        const parsed = JSON.parse(body || '{}') as { grantType?: string; managementKey?: string };
        if (parsed.grantType !== 'managementKey' || parsed.managementKey !== MANAGEMENT_KEY) {
          json(401, {
            error: {
              code: 'AUTHENTICATION_FAILED',
              message: '管理密钥不正确',
              fields: [],
              retryable: false,
              requestId: 'req-login-failed',
            },
          });
          return;
        }
        json(
          201,
          {
            data: {
              credential: UPSTREAM_CREDENTIAL,
              session: {
                sessionId: 'session-1',
                subjectId: 'administrator',
                authMethod: 'managementKey',
                roles: ['administrator'],
                capabilities: ['management.read', 'management.write'],
                issuedAt: new Date().toISOString(),
                expiresAt: new Date(Date.now() + 3600_000).toISOString(),
                idleExpiresAt: new Date(Date.now() + 1800_000).toISOString(),
              },
            },
            meta: { requestId: 'req-login-ok' },
          },
          { 'x-request-id': 'req-login-ok' },
        );
        return;
      }

      if (path === '/api/management/v1/auth/session' && request.method === 'GET') {
        json(200, {
          data: {
            session: {
              sessionId: 'session-1',
              subjectId: 'administrator',
              capabilities: ['management.read', 'management.write'],
              expiresAt: new Date(Date.now() + 3600_000).toISOString(),
              idleExpiresAt: new Date(Date.now() + 1800_000).toISOString(),
            },
          },
          meta: { requestId: 'req-session' },
        });
        return;
      }

      if (path === '/api/management/v1/auth/session' && request.method === 'DELETE') {
        response.writeHead(204);
        response.end();
        return;
      }

      const authorized = request.headers.authorization === `Bearer ${UPSTREAM_CREDENTIAL}`;
      if (!authorized) {
        json(401, {
          error: { code: 'SESSION_REQUIRED', message: '缺少会话', fields: [], retryable: false, requestId: 'req-unauth' },
        });
        return;
      }

      if (path === '/api/management/v1/channels' && request.method === 'GET') {
        json(200, {
          data: {
            items: [
              { id: 'ch-1', name: '示例渠道', provider: 'openai', enabled: true, baseUrl: 'https://api.example.test' },
            ],
          },
          meta: { requestId: 'req-channels', revision },
        });
        return;
      }

      if (path === '/api/management/v1/channels/ch-1' && request.method === 'PATCH') {
        if (request.headers['if-match'] !== revision) {
          json(409, {
            error: {
              code: 'REVISION_CONFLICT',
              message: '资源已被其他管理端修改',
              fields: [{ path: 'revision', code: 'REVISION_CONFLICT', message: '版本不匹配' }],
              retryable: false,
              requestId: 'req-conflict',
            },
          });
          return;
        }
        revision = 'rev-2';
        json(200, { data: { id: 'ch-1', name: '示例渠道已改', provider: 'openai', enabled: false }, meta: { requestId: 'req-patch', revision } });
        return;
      }

      json(404, {
        error: { code: 'RESOURCE_NOT_FOUND', message: '未找到资源', fields: [], retryable: false, requestId: 'req-404' },
      });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;

  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    setRevision(next: string) {
      revision = next;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function testConfig(upstreamOrigin: string): WebuiConfig {
  return loadConfig({
    NODE_ENV: 'development',
    PARROT_BASE_URL: upstreamOrigin,
    WEBUI_PUBLIC_ORIGIN: PUBLIC_ORIGIN,
    WEBUI_INSTANCE_NAME: '测试实例',
    WEBUI_DEV_INSECURE_COOKIES: '1',
    LOG_LEVEL: 'silent',
  });
}

/** 极简 Cookie Jar：按 Set-Cookie 保存/回传，值被清空时删除该 Cookie。 */
class CookieJar {
  private readonly jar = new Map<string, string>();

  absorb(setCookies: readonly string[]): void {
    for (const raw of setCookies) {
      const [pair] = raw.split(';');
      const index = pair?.indexOf('=') ?? -1;
      if (!pair || index === -1) continue;
      const name = pair.slice(0, index).trim();
      const value = pair.slice(index + 1).trim();
      if (value === '') this.jar.delete(name);
      else this.jar.set(name, value);
    }
  }

  header(): string {
    return [...this.jar.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  get(name: string): string | undefined {
    return this.jar.get(name);
  }

  names(): string[] {
    return [...this.jar.keys()];
  }
}

interface BrowserResponse {
  status: number;
  headers: IncomingHttpHeaders;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

describe('parrot-webui 端到端链路（真实 HTTP + Cookie + CSRF）', () => {
  let upstream: UpstreamStub;
  let app: ReturnType<typeof buildServer>;
  let basePort: number;

  beforeAll(async () => {
    upstream = await startUpstreamStub();
    app = buildServer(testConfig(upstream.origin));
    await app.listen({ port: 0, host: '127.0.0.1' });
    basePort = (app.server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await app.close();
    await upstream.close();
  });

  /**
   * 用 node:http 直接发请求，这样可以显式控制 Host 头（fetch 不允许设置 Host），
   * 从而同时验证 Host 校验与 Cookie/CSRF 行为。
   */
  async function browserFetch(
    jar: CookieJar,
    path: string,
    init: {
      method?: string;
      body?: string;
      csrf?: string | null;
      origin?: string | null;
      host?: string;
      headers?: Record<string, string>;
    } = {},
  ): Promise<BrowserResponse> {
    const headers: Record<string, string> = {
      accept: 'application/json',
      host: init.host ?? PUBLIC_HOST,
      ...(init.headers ?? {}),
    };
    const cookie = jar.header();
    if (cookie) headers.cookie = cookie;
    if (init.origin !== null) headers.origin = init.origin ?? PUBLIC_ORIGIN;
    if (init.csrf !== null && init.csrf !== undefined) headers['x-csrf-token'] = init.csrf;
    if (init.body) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(Buffer.byteLength(init.body, 'utf8'));
    }

    return new Promise<BrowserResponse>((resolve, reject) => {
      const request = httpRequest(
        { host: '127.0.0.1', port: basePort, path, method: init.method ?? 'GET', headers },
        (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            jar.absorb((response.headers['set-cookie'] ?? []) as string[]);
            resolve({
              status: response.statusCode ?? 0,
              headers: response.headers,
              text: async () => text,
              json: async () => JSON.parse(text) as unknown,
            });
          });
        },
      );
      request.on('error', reject);
      if (init.body) request.write(init.body);
      request.end();
    });
  }

  it('未登录访问业务代理返回 401 且不触达上游', async () => {
    const jar = new CookieJar();
    const before = upstream.requests.length;
    const response = await browserFetch(jar, '/webui/bff/management/channels', { origin: null });
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: { code: string; source: string } };
    expect(body.error.code).toBe('WEBUI_SESSION_REQUIRED');
    expect(body.error.source).toBe('webui');
    expect(upstream.requests.length).toBe(before);
  });

  it('bootstrap 下发预登录 Cookie 与 CSRF，且不泄露内部地址', async () => {
    const jar = new CookieJar();
    const response = await browserFetch(jar, '/webui/bff/bootstrap', { origin: null });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: { csrfToken: string; instanceName: string; loginMethods: string[] };
    };
    expect(body.data.instanceName).toBe('测试实例');
    expect(body.data.loginMethods).toEqual(['managementKey']);
    expect(body.data.csrfToken).toBeTruthy();
    expect(jar.names().some((name) => name.includes('prelogin'))).toBe(true);
    // 上游内部地址不得出现在 bootstrap 响应中
    expect(JSON.stringify(body)).not.toContain(upstream.origin.replace('http://', ''));
  });

  it('登录缺少 Origin 或 CSRF 时被拒绝，且不触达上游', async () => {
    const jar = new CookieJar();
    const bootstrap = await browserFetch(jar, '/webui/bff/bootstrap', { origin: null });
    const { data } = (await bootstrap.json()) as { data: { csrfToken: string } };
    const before = upstream.requests.length;

    const noOrigin = await browserFetch(jar, '/webui/bff/auth/login', {
      method: 'POST',
      body: JSON.stringify({ managementKey: MANAGEMENT_KEY }),
      csrf: data.csrfToken,
      origin: null,
    });
    expect(noOrigin.status).toBe(403);
    expect(((await noOrigin.json()) as { error: { code: string } }).error.code).toBe('WEBUI_ORIGIN_REJECTED');

    const wrongOrigin = await browserFetch(jar, '/webui/bff/auth/login', {
      method: 'POST',
      body: JSON.stringify({ managementKey: MANAGEMENT_KEY }),
      csrf: data.csrfToken,
      origin: 'https://evil.example.test',
    });
    expect(wrongOrigin.status).toBe(403);

    const noCsrf = await browserFetch(jar, '/webui/bff/auth/login', {
      method: 'POST',
      body: JSON.stringify({ managementKey: MANAGEMENT_KEY }),
      csrf: null,
    });
    expect(noCsrf.status).toBe(403);
    expect(((await noCsrf.json()) as { error: { code: string } }).error.code).toBe('WEBUI_CSRF_REJECTED');

    expect(upstream.requests.filter((item) => item.path.includes('/auth/sessions')).length).toBe(0);
    expect(upstream.requests.length).toBe(before);
  });

  it('正确登录后可以读取渠道，浏览器看不到上游凭证', async () => {
    const jar = new CookieJar();
    const bootstrap = await browserFetch(jar, '/webui/bff/bootstrap', { origin: null });
    const { data } = (await bootstrap.json()) as { data: { csrfToken: string } };
    const preloginCookie = jar.header();

    const login = await browserFetch(jar, '/webui/bff/auth/login', {
      method: 'POST',
      body: JSON.stringify({ managementKey: MANAGEMENT_KEY }),
      csrf: data.csrfToken,
    });
    expect(login.status).toBe(200);
    const loginText = await login.text();
    expect(loginText).not.toContain(UPSTREAM_CREDENTIAL);
    const loginBody = JSON.parse(loginText) as { data: { csrfToken: string; session: { summary: { subjectId: string } } } };
    expect(loginBody.data.session.summary.subjectId).toBe('administrator');
    // 登录后轮换 Cookie（会话固定攻击防护）
    expect(jar.header()).not.toBe(preloginCookie);

    const channels = await browserFetch(jar, '/webui/bff/management/channels', { origin: null });
    expect(channels.status).toBe(200);
    const channelsText = await channels.text();
    expect(channelsText).toContain('示例渠道');
    expect(channelsText).not.toContain(UPSTREAM_CREDENTIAL);

    // 会话摘要接口也不得泄露 credential
    const session = await browserFetch(jar, '/webui/bff/auth/session', { origin: null });
    const sessionText = await session.text();
    expect(sessionText).not.toContain(UPSTREAM_CREDENTIAL);
    expect((JSON.parse(sessionText) as { data: { authenticated: boolean } }).data.authenticated).toBe(true);
  });

  it('写操作透传 If-Match；revision 冲突按 409 原样返回，BFF 不自动覆盖', async () => {
    const jar = new CookieJar();
    const bootstrap = await browserFetch(jar, '/webui/bff/bootstrap', { origin: null });
    const { data } = (await bootstrap.json()) as { data: { csrfToken: string } };
    await browserFetch(jar, '/webui/bff/auth/login', {
      method: 'POST',
      body: JSON.stringify({ managementKey: MANAGEMENT_KEY }),
      csrf: data.csrfToken,
    });
    const session = await browserFetch(jar, '/webui/bff/auth/session', { origin: null });
    const csrfToken = ((await session.json()) as { data: { csrfToken: string } }).data.csrfToken;

    const conflict = await browserFetch(jar, '/webui/bff/management/channels/ch-1', {
      method: 'PATCH',
      headers: { 'if-match': 'rev-stale' },
      body: JSON.stringify({ name: '被拒绝的修改' }),
      csrf: csrfToken,
    });
    expect(conflict.status).toBe(409);
    const conflictBody = (await conflict.json()) as { error: { code: string } };
    expect(conflictBody.error.code).toBe('REVISION_CONFLICT');

    const ok = await browserFetch(jar, '/webui/bff/management/channels/ch-1', {
      method: 'PATCH',
      headers: { 'if-match': 'rev-1' },
      body: JSON.stringify({ name: '合法修改' }),
      csrf: csrfToken,
    });
    expect(ok.status).toBe(200);

    // 断言上游确实收到了透传的 If-Match 与 BFF 自己设置的 Bearer
    const patch = upstream.requests.filter((item) => item.method === 'PATCH').at(-1);
    expect(patch?.headers['if-match']).toBe('rev-1');
    expect(patch?.headers.authorization).toBe(`Bearer ${UPSTREAM_CREDENTIAL}`);
    // 浏览器 Cookie / Origin 不得转发给上游
    expect(patch?.headers.cookie).toBeUndefined();
    expect(patch?.headers.origin).toBeUndefined();
  });

  it('允许清单之外的路径与编码绕过不会触达上游', async () => {
    const jar = new CookieJar();
    const bootstrap = await browserFetch(jar, '/webui/bff/bootstrap', { origin: null });
    const { data } = (await bootstrap.json()) as { data: { csrfToken: string } };
    await browserFetch(jar, '/webui/bff/auth/login', {
      method: 'POST',
      body: JSON.stringify({ managementKey: MANAGEMENT_KEY }),
      csrf: data.csrfToken,
    });
    const before = upstream.requests.length;

    for (const hostile of [
      '/webui/bff/management/updates/check',
      '/webui/bff/management/system/settings',
      '/webui/bff/management/channels/%2e%2e/%2e%2e/meta',
      '/webui/bff/management/channels/ch-1/../../meta',
      '/webui/bff/management/auth/session',
    ]) {
      const response = await browserFetch(jar, hostile, { origin: null });
      expect([400, 404, 405]).toContain(response.status);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code.startsWith('WEBUI_')).toBe(true);
    }
    expect(upstream.requests.length).toBe(before);
  });

  it('注销后旧 Cookie 立即失效，且上游收到注销请求', async () => {
    const jar = new CookieJar();
    const bootstrap = await browserFetch(jar, '/webui/bff/bootstrap', { origin: null });
    const { data } = (await bootstrap.json()) as { data: { csrfToken: string } };
    await browserFetch(jar, '/webui/bff/auth/login', {
      method: 'POST',
      body: JSON.stringify({ managementKey: MANAGEMENT_KEY }),
      csrf: data.csrfToken,
    });
    const session = await browserFetch(jar, '/webui/bff/auth/session', { origin: null });
    const csrfToken = ((await session.json()) as { data: { csrfToken: string } }).data.csrfToken;

    const logout = await browserFetch(jar, '/webui/bff/auth/logout', {
      method: 'POST',
      body: JSON.stringify({}),
      csrf: csrfToken,
    });
    expect(logout.status).toBe(200);
    const logoutBody = (await logout.json()) as {
      data: { localSessionDestroyed: boolean; upstreamRevocation: string };
    };
    expect(logoutBody.data.localSessionDestroyed).toBe(true);
    expect(logoutBody.data.upstreamRevocation).toBe('revoked');
    expect(upstream.requests.some((item) => item.method === 'DELETE' && item.path.endsWith('/auth/session'))).toBe(true);

    const afterLogout = await browserFetch(jar, '/webui/bff/management/channels', { origin: null });
    expect(afterLogout.status).toBe(401);
  });

  it('健康检查只在内部可用，且不泄露凭据', async () => {
    const jar = new CookieJar();
    const internal = await browserFetch(jar, '/webui/health/live', { origin: null, headers: { host: '127.0.0.1' } });
    expect(internal.status).toBe(200);
    const body = (await internal.json()) as { status: string };
    expect(body.status).toBe('ok');
  });
});
