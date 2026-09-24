/**
 * BFF 测试脚手架。
 *
 * 组成：
 * - `makeConfig`：直接构造 `WebuiConfig` 对象（不经过 loadConfig 的严格校验），
 *   便于把超时/空闲/限流值设得很小以便在毫秒级完成断言。
 * - `startFakeUpstream`：`node:http` 本地假上游，监听 127.0.0.1:0，
 *   记录每个请求的 method/path/query/headers/body，并按用例返回预设响应。
 * - `createHarness`：把假上游与 `buildServer(config)` 组合起来，用 `app.inject()` 发请求。
 *
 * 全部数据均为虚构测试值，不含任何真实密钥、域名或上游地址。
 */

import { createServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildServer } from '../src/server.js';
import { cookieNames } from '../src/auth/cookies.js';
import type { WebSession } from '../src/auth/session-store.js';
import { FIXED_BASE_PATH, type WebuiConfig } from '../src/config.js';

/** 假管理主密钥（测试专用，长度满足上游“至少 48 字节”的描述，但不是真实密钥）。 */
export const TEST_MANAGEMENT_KEY = 'test-management-key-0123456789abcdefghijklmnopqrstuvwxyz-ABCD';

/** 测试用公共域名（.test 保留域，非真实域名）。 */
export const TEST_PUBLIC_ORIGIN = 'http://webui.test';
export const TEST_PUBLIC_HOST = 'webui.test';

const MISSING_STATIC_DIR = join(fileURLToPath(new URL('.', import.meta.url)), '__missing_static__');

export const UPSTREAM_META_PATH = '/api/management/v1/meta';
export const UPSTREAM_LOGIN_PATH = '/api/management/v1/auth/sessions';
export const UPSTREAM_SESSION_PATH = '/api/management/v1/auth/session';

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// --------------------------------------------------------------------- config

export function makeConfig(upstreamOrigin: string, overrides: Partial<WebuiConfig> = {}): WebuiConfig {
  const base: WebuiConfig = {
    nodeEnv: 'test',
    isProduction: false,
    port: 0,
    bindHost: '127.0.0.1',
    basePath: FIXED_BASE_PATH,
    publicOrigin: TEST_PUBLIC_ORIGIN,
    publicHost: TEST_PUBLIC_HOST,
    upstreamOrigin,
    upstreamOriginDisplay: upstreamOrigin,
    instanceName: 'ParrotTestInstance',
    trustProxy: ['127.0.0.1', '::1'],
    sessionIdleSeconds: 1800,
    sessionMaxSeconds: 28800,
    maxSessions: 50,
    maxPreloginSessions: 50,
    bootstrapTtlSeconds: 300,
    connectTimeoutMs: 2000,
    requestTimeoutMs: 5000,
    maxUpstreamResponseBytes: 1024 * 1024,
    defaultBodyLimitBytes: 1024 * 1024,
    oauthImportBodyLimitBytes: 5 * 1024 * 1024,
    loginPerSourcePerMinute: 50,
    loginGlobalPerMinute: 100,
    bootstrapPerSourcePerMinute: 200,
    bootstrapGlobalPerMinute: 400,
    maxConcurrentLogin: 8,
    maxConcurrentBootstrap: 16,
    logLevel: 'silent',
    staticDir: MISSING_STATIC_DIR,
    cookieSecure: false,
    cookiePrefix: '',
    exposeUpstreamOrigin: false,
    allowInsecurePublicOrigin: true,
  };
  return { ...base, ...overrides };
}

// ------------------------------------------------------------------- upstream

export interface RecordedUpstreamRequest {
  readonly method: string;
  /** 不含 query 的原始路径（保持百分号编码）。 */
  readonly path: string;
  readonly query: string;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
}

export type UpstreamResponder = (
  request: RecordedUpstreamRequest,
  response: ServerResponse,
) => void | Promise<void>;

export interface FakeUpstream {
  readonly origin: string;
  readonly host: string;
  readonly requests: RecordedUpstreamRequest[];
  setResponder(responder: UpstreamResponder): void;
  requestsFor(path: string): RecordedUpstreamRequest[];
  close(): Promise<void>;
}

export function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(payload.byteLength),
    ...headers,
  });
  response.end(payload);
}

export function sendRaw(
  response: ServerResponse,
  status: number,
  body: string | Buffer,
  headers: Record<string, string> = {},
): void {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
  response.writeHead(status, { 'content-length': String(payload.byteLength), ...headers });
  response.end(payload);
}

export async function startFakeUpstream(responder: UpstreamResponder): Promise<FakeUpstream> {
  const requests: RecordedUpstreamRequest[] = [];
  let handler = responder;
  let closed = false;
  const server = createServer((request, response) => {
    // 用例主动中止连接（超时/关闭）时不要产生未处理的 'error' 事件
    response.on('error', () => {});
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
      }
      const rawUrl = request.url ?? '/';
      const index = rawUrl.indexOf('?');
      const record: RecordedUpstreamRequest = {
        method: (request.method ?? 'GET').toUpperCase(),
        path: index === -1 ? rawUrl : rawUrl.slice(0, index),
        query: index === -1 ? '' : rawUrl.slice(index + 1),
        headers: { ...request.headers },
        body: Buffer.concat(chunks).toString('utf8'),
      };
      requests.push(record);
      try {
        await handler(record, response);
      } catch {
        try {
          if (response.destroyed || response.writableEnded) return;
          if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' });
          response.end('{"error":{"code":"FAKE_UPSTREAM_FAILURE"}}');
        } catch {
          // 连接已被用例关闭：忽略
        }
      }
    })();
  });

  server.on('clientError', (_error, socket) => {
    socket.destroy();
  });

  server.listen({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const address = server.address() as AddressInfo;
  const host = `127.0.0.1:${address.port}`;

  return {
    origin: `http://${host}`,
    host,
    requests,
    setResponder(next) {
      handler = next;
    },
    requestsFor(path) {
      return requests.filter((item) => item.path === path);
    },
    async close() {
      // 幂等：用例可能已经先关掉上游（模拟上游不可达）
      if (closed) return;
      closed = true;
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

// --------------------------------------------------------------------- cookie

export interface ParsedCookie {
  readonly name: string;
  readonly value: string;
  readonly path?: string;
  readonly secure?: boolean;
  readonly httpOnly?: boolean;
  readonly sameSite?: string;
  readonly maxAge?: number;
}

/** Cookie jar：只保留未过期的 Cookie，按 Path=/webui/ 语义（测试里只有一个 Cookie 域）。 */
export class CookieJar {
  private readonly jar = new Map<string, string>();

  apply(response: LightMyRequestResponse): this {
    for (const cookie of response.cookies) {
      const cleared =
        cookie.value === '' ||
        cookie.maxAge === 0 ||
        (cookie.expires !== undefined && cookie.expires.getTime() <= Date.now());
      if (cleared) {
        this.jar.delete(cookie.name);
        continue;
      }
      this.jar.set(cookie.name, cookie.value);
    }
    return this;
  }

  get(name: string): string | undefined {
    return this.jar.get(name);
  }

  header(): string {
    return [...this.jar.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  all(): string[] {
    return [...this.jar.entries()].map(([name, value]) => `${name}=${value}`);
  }
}

export function findCookie(response: LightMyRequestResponse, name: string): ParsedCookie | undefined {
  return response.cookies.find((cookie) => cookie.name === name);
}

// -------------------------------------------------------------------- harness

export interface InjectInput {
  method?: string;
  url: string;
  cookies?: string[];
  headers?: Record<string, string>;
  json?: unknown;
  rawPayload?: string;
  remoteAddress?: string;
}

export interface Harness {
  readonly config: WebuiConfig;
  readonly app: FastifyInstance;
  readonly upstream: FakeUpstream;
  /** 假上游已签发的上游凭证，按签发顺序记录。 */
  readonly issuedCredentials: string[];
  readonly sessionCookieName: string;
  readonly preloginCookieName: string;
  inject(input: InjectInput): Promise<LightMyRequestResponse>;
  bootstrap(remoteAddress?: string): Promise<{
    res: LightMyRequestResponse;
    preloginCookie: string;
    csrfToken: string;
  }>;
  login(
    managementKey?: string,
    options?: { remoteAddress?: string },
  ): Promise<{
    res: LightMyRequestResponse;
    sessionCookie: string;
    csrfToken: string;
    body: Record<string, unknown>;
  }>;
  /** 已登录会话的写请求头（Origin + CSRF + Cookie）。 */
  writeHeaders(options: {
    cookies?: string[];
    csrfToken?: string;
    origin?: string | null;
    extra?: Record<string, string>;
  }): Record<string, string>;
  sessionFromCookie(sessionCookie: string): WebSession | null;
  close(): Promise<void>;
}

export interface HarnessOptions {
  config?: Partial<WebuiConfig>;
  responder?: UpstreamResponder;
}

/** 上游会话摘要（不含任何 credential 值，便于断言响应里没有上游凭证）。 */
export function upstreamSessionSummary(tag = 'default', now = Date.now()): Record<string, unknown> {
  return {
    sessionId: `test-upstream-session-${tag}`,
    subjectId: 'test-subject',
    authMethod: 'managementKey',
    roles: ['admin'],
    capabilities: ['channels.read', 'channels.write'],
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 6 * 60 * 60 * 1000).toISOString(),
    idleExpiresAt: new Date(now + 30 * 60 * 1000).toISOString(),
  };
}

export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const issuedCredentials: string[] = [];
  const nextCredential = (): string => {
    const credential = `test-upstream-credential-${issuedCredentials.length + 1}`;
    issuedCredentials.push(credential);
    return credential;
  };

  const defaultResponder: UpstreamResponder = (request, response) => {
    if (request.path === UPSTREAM_META_PATH) {
      // 未认证探测：管理 API 存在但需要登录
      sendJson(response, 401, { error: { code: 'SESSION_REQUIRED', message: 'unauthorized' } });
      return;
    }
    if (request.path === UPSTREAM_LOGIN_PATH && request.method === 'POST') {
      const credential = nextCredential();
      sendJson(response, 201, {
        data: { credential, session: upstreamSessionSummary(String(issuedCredentials.length)) },
        meta: { requestId: 'test-upstream-login' },
      });
      return;
    }
    if (request.path === UPSTREAM_SESSION_PATH) {
      if (request.method === 'GET') {
        sendJson(response, 200, {
          data: { session: upstreamSessionSummary('refresh-probe') },
          meta: { requestId: 'test-upstream-session' },
        });
        return;
      }
      if (request.method === 'DELETE') {
        response.writeHead(204);
        response.end();
        return;
      }
    }
    sendJson(response, 200, {
      data: {
        echo: {
          method: request.method,
          path: request.path,
          query: request.query,
          body: request.body ? (JSON.parse(request.body) as unknown) : null,
        },
      },
      meta: { requestId: 'test-upstream-ok' },
    });
  };

  const upstream = await startFakeUpstream(options.responder ?? defaultResponder);
  const config = makeConfig(upstream.origin, options.config);
  const app = buildServer(config);
  await app.ready();

  const names = cookieNames(config);

  const inject = async (input: InjectInput): Promise<LightMyRequestResponse> => {
    const headers: Record<string, string> = { host: config.publicHost, ...(input.headers ?? {}) };
    if (input.cookies?.length) headers.cookie = input.cookies.join('; ');
    let payload: string | undefined;
    if (input.json !== undefined) {
      payload = JSON.stringify(input.json);
      headers['content-type'] ??= 'application/json';
    } else if (input.rawPayload !== undefined) {
      payload = input.rawPayload;
    }
    const result = await app.inject({
      method: (input.method ?? 'GET') as 'GET',
      url: input.url,
      headers,
      ...(payload === undefined ? {} : { payload }),
      ...(input.remoteAddress === undefined ? {} : { remoteAddress: input.remoteAddress }),
    });
    return result;
  };

  const cookiePair = (response: LightMyRequestResponse, name: string): string => {
    const cookie = findCookie(response, name);
    return cookie ? `${cookie.name}=${cookie.value}` : '';
  };

  const bootstrap: Harness['bootstrap'] = async (remoteAddress) => {
    const res = await inject({
      url: '/webui/bff/bootstrap',
      ...(remoteAddress === undefined ? {} : { remoteAddress }),
    });
    const body = res.json<{ data?: { csrfToken?: string } }>();
    return {
      res,
      preloginCookie: cookiePair(res, names.prelogin),
      csrfToken: body.data?.csrfToken ?? '',
    };
  };

  return {
    config,
    app,
    upstream,
    issuedCredentials,
    sessionCookieName: names.session,
    preloginCookieName: names.prelogin,

    inject,

    bootstrap,

    async login(managementKey = TEST_MANAGEMENT_KEY, loginOptions = {}) {
      const bootstrapResult = await bootstrap(loginOptions.remoteAddress);
      const res = await inject({
        method: 'POST',
        url: '/webui/bff/auth/login',
        json: { managementKey },
        cookies: [bootstrapResult.preloginCookie],
        headers: {
          origin: config.publicOrigin,
          'x-csrf-token': bootstrapResult.csrfToken,
        },
        ...(loginOptions.remoteAddress === undefined ? {} : { remoteAddress: loginOptions.remoteAddress }),
      });
      const body = res.json<{ data?: { csrfToken?: string } }>();
      return {
        res,
        sessionCookie: cookiePair(res, names.session),
        csrfToken: body.data?.csrfToken ?? '',
        body: body as Record<string, unknown>,
      };
    },

    writeHeaders({ cookies = [], csrfToken = '', origin = config.publicOrigin, extra = {} }) {
      const headers: Record<string, string> = { ...extra };
      if (cookies.length) headers.cookie = cookies.join('; ');
      if (origin !== null) headers.origin = origin;
      if (csrfToken) headers['x-csrf-token'] = csrfToken;
      return headers;
    },

    sessionFromCookie(sessionCookie) {
      const separator = sessionCookie.indexOf('=');
      const token = separator === -1 ? '' : sessionCookie.slice(separator + 1);
      return app.webui.store.getSession(token);
    },

    async close() {
      await app.close();
      await upstream.close();
    },
  };
}
