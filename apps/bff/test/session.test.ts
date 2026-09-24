/**
 * BFF 会话生命周期测试（对应实施文档 4.x 与 11.1 BFF 必需清单）。
 *
 * 重点：上游 credential 只存在 BFF 内存；会话 ID/CSRF 轮换；注销幂等；
 * 多浏览器独立凭证；容量上限；上游判定失效时清理本地会话。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createHarness,
  findCookie,
  sendJson,
  TEST_MANAGEMENT_KEY,
  UPSTREAM_LOGIN_PATH,
  UPSTREAM_META_PATH,
  UPSTREAM_SESSION_PATH,
  type Harness,
  type HarnessOptions,
} from './helpers.js';

const opened: Harness[] = [];

async function open(options?: HarnessOptions): Promise<Harness> {
  const harness = await createHarness(options);
  opened.push(harness);
  return harness;
}

interface ErrorEnvelope {
  error?: { code?: string };
}

function codeOf(res: { json: () => unknown }): string {
  return (res.json() as ErrorEnvelope).error?.code ?? '';
}

/** 上游再次判定会话失效（GET /auth/session 返回 401）时使用的响应器。 */
function sessionRevokedResponder(): Parameters<Harness['upstream']['setResponder']>[0] {
  return (request, response) => {
    if (request.path === UPSTREAM_META_PATH) {
      sendJson(response, 401, { error: { code: 'SESSION_REQUIRED' } });
      return;
    }
    if (request.path === UPSTREAM_SESSION_PATH && request.method === 'GET') {
      sendJson(response, 401, { error: { code: 'SESSION_EXPIRED', message: 'upstream session expired' } });
      return;
    }
    sendJson(response, 200, { data: { ok: true } });
  };
}

describe('BFF 登录 / 会话 / 注销', () => {
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

  it('登录成功：设置会话 Cookie，响应体/头部/Cookie 都不出现上游 credential', async () => {
    const result = await h.login();
    expect(result.res.statusCode).toBe(200);

    const cookie = findCookie(result.res, h.sessionCookieName);
    expect(cookie).toBeDefined();
    expect(cookie?.value).not.toBe('');
    expect(cookie?.value.length).toBeGreaterThanOrEqual(32);
    expect(cookie?.path).toBe('/webui/');
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite).toBe('Lax');
    expect(cookie?.maxAge).toBe(h.config.sessionMaxSeconds);
    // 本测试使用非生产调试 Cookie；生产由 loadConfig 强制 Secure 与 __Secure- 前缀
    expect(cookie?.secure ?? false).toBe(false);

    const credential = h.issuedCredentials[0];
    expect(credential).toBeDefined();
    expect(result.res.body).not.toContain(credential);
    expect(JSON.stringify(result.res.headers)).not.toContain(credential);
    expect(JSON.stringify(result.res.cookies)).not.toContain(credential);
    expect(cookie?.value).not.toContain(credential);

    const body = result.res.json<{
      data: { csrfToken: string; session: { summary: { sessionId: string; capabilities: string[] } } };
      meta: { requestId: string };
    }>();
    expect(body.data.csrfToken).not.toBe('');
    expect(body.data.session.summary.sessionId).toBe('test-upstream-session-1');
    expect(body.data.session.summary.capabilities).toEqual(['channels.read', 'channels.write']);
    expect(body.meta.requestId).not.toBe('');

    // 上游确实收到了管理密钥换票请求，且管理密钥只在这一处出现
    const loginRequests = h.upstream.requestsFor(UPSTREAM_LOGIN_PATH);
    expect(loginRequests).toHaveLength(1);
    expect(JSON.parse(loginRequests[0]!.body)).toEqual({
      grantType: 'managementKey',
      managementKey: TEST_MANAGEMENT_KEY,
    });
  });

  it('登录后会话 ID 与 CSRF 都轮换，预登录 Cookie 被清除且不能再用', async () => {
    const boot = await h.bootstrap();
    expect(boot.res.statusCode).toBe(200);
    expect(boot.preloginCookie).not.toBe('');
    expect(boot.csrfToken).not.toBe('');

    const login = await h.inject({
      method: 'POST',
      url: '/webui/bff/auth/login',
      json: { managementKey: TEST_MANAGEMENT_KEY },
      cookies: [boot.preloginCookie],
      headers: { origin: h.config.publicOrigin, 'x-csrf-token': boot.csrfToken },
    });
    expect(login.statusCode).toBe(200);

    const sessionCookie = findCookie(login, h.sessionCookieName);
    const preloginValue = boot.preloginCookie.slice(boot.preloginCookie.indexOf('=') + 1);
    expect(sessionCookie?.value).toBeDefined();
    expect(sessionCookie?.value).not.toBe(preloginValue);

    const body = login.json<{ data: { csrfToken: string } }>();
    expect(body.data.csrfToken).not.toBe(boot.csrfToken);

    const clearedPrelogin = findCookie(login, h.preloginCookieName);
    expect(clearedPrelogin?.maxAge).toBe(0);
    expect(clearedPrelogin?.path).toBe('/webui/');

    // 旧预登录 Cookie 不是会话 Cookie，不能访问业务接口
    const withPrelogin = await h.inject({ url: '/webui/bff/management/channels', cookies: [boot.preloginCookie] });
    expect(withPrelogin.statusCode).toBe(401);
    expect(codeOf(withPrelogin)).toBe('WEBUI_SESSION_REQUIRED');
  });

  it('GET /bff/auth/session 能恢复已登录会话，且不返回 credential', async () => {
    const login = await h.login();
    expect(login.res.statusCode).toBe(200);

    const res = await h.inject({ url: '/webui/bff/auth/session', cookies: [login.sessionCookie] });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      data: { authenticated: boolean; csrfToken: string; session: { summary: { sessionId: string } }; capabilities: string[] };
    }>();
    expect(body.data.authenticated).toBe(true);
    expect(body.data.csrfToken).toBe(login.csrfToken);
    expect(body.data.session.summary.sessionId).toBe('test-upstream-session-1');
    expect(body.data.capabilities).toEqual(['channels.read', 'channels.write']);
    expect(res.body).not.toContain(h.issuedCredentials[0]);
    expect(res.headers['cache-control']).toBe('no-store');

    // 未登录时同一接口返回未认证状态，而不是错误
    const anonymous = await h.inject({ url: '/webui/bff/auth/session' });
    expect(anonymous.statusCode).toBe(200);
    expect(anonymous.json<{ data: { authenticated: boolean; csrfToken: null } }>().data).toMatchObject({
      authenticated: false,
      csrfToken: null,
    });
  });

  it('注销：吊销上游会话、清除 Cookie，旧 Cookie 不能再访问业务接口', async () => {
    const login = await h.login();
    expect(login.res.statusCode).toBe(200);
    const credential = h.issuedCredentials[0];

    const logout = await h.inject({
      method: 'POST',
      url: '/webui/bff/auth/logout',
      cookies: [login.sessionCookie],
      headers: h.writeHeaders({ cookies: [login.sessionCookie], csrfToken: login.csrfToken }),
    });
    expect(logout.statusCode).toBe(200);
    expect(logout.json<{ data: Record<string, unknown> }>().data).toMatchObject({
      localSessionDestroyed: true,
      upstreamRevocation: 'revoked',
    });

    const revocations = h.upstream.requests.filter(
      (item) => item.path === UPSTREAM_SESSION_PATH && item.method === 'DELETE',
    );
    expect(revocations).toHaveLength(1);
    expect(revocations[0]!.headers.authorization).toBe(`Bearer ${credential}`);

    const cleared = findCookie(logout, h.sessionCookieName);
    expect(cleared?.maxAge).toBe(0);
    expect(cleared?.path).toBe('/webui/');

    const afterLogout = await h.inject({ url: '/webui/bff/management/channels', cookies: [login.sessionCookie] });
    expect(afterLogout.statusCode).toBe(401);
    expect(codeOf(afterLogout)).toBe('WEBUI_SESSION_REQUIRED');

    const sessionAfterLogout = await h.inject({ url: '/webui/bff/auth/session', cookies: [login.sessionCookie] });
    expect(sessionAfterLogout.json<{ data: { authenticated: boolean } }>().data.authenticated).toBe(false);
  });

  it('注销缺少 CSRF/Origin 时被拒绝，且不调用上游吊销', async () => {
    const login = await h.login();
    const before = h.upstream.requests.length;

    const noCsrf = await h.inject({
      method: 'POST',
      url: '/webui/bff/auth/logout',
      cookies: [login.sessionCookie],
      headers: h.writeHeaders({ cookies: [login.sessionCookie] }),
    });
    expect(noCsrf.statusCode).toBe(403);
    expect(codeOf(noCsrf)).toBe('WEBUI_CSRF_REJECTED');

    const noOrigin = await h.inject({
      method: 'POST',
      url: '/webui/bff/auth/logout',
      cookies: [login.sessionCookie],
      headers: h.writeHeaders({ cookies: [login.sessionCookie], csrfToken: login.csrfToken, origin: null }),
    });
    expect(noOrigin.statusCode).toBe(403);
    expect(codeOf(noOrigin)).toBe('WEBUI_ORIGIN_REJECTED');

    expect(h.upstream.requests.length).toBe(before);
    // 会话未被销毁
    const stillValid = await h.inject({ url: '/webui/bff/management/channels', cookies: [login.sessionCookie] });
    expect(stillValid.statusCode).toBe(200);
  });

  it('上游不可达时注销仍然销毁本地会话（upstreamRevocation=unconfirmed）', async () => {
    const unreachable = await open();
    const login = await unreachable.login();
    expect(login.res.statusCode).toBe(200);
    await unreachable.upstream.close();

    const logout = await unreachable.inject({
      method: 'POST',
      url: '/webui/bff/auth/logout',
      cookies: [login.sessionCookie],
      headers: unreachable.writeHeaders({ cookies: [login.sessionCookie], csrfToken: login.csrfToken }),
    });
    expect(logout.statusCode).toBe(200);
    expect(logout.json<{ data: Record<string, unknown> }>().data).toMatchObject({
      localSessionDestroyed: true,
      upstreamRevocation: 'unconfirmed',
    });
    expect(findCookie(logout, unreachable.sessionCookieName)?.maxAge).toBe(0);

    const afterLogout = await unreachable.inject({
      url: '/webui/bff/management/channels',
      cookies: [login.sessionCookie],
    });
    expect(afterLogout.statusCode).toBe(401);
  });

  it('两个浏览器登录各自使用独立上游凭证，注销不串会话', async () => {
    const first = await h.login();
    const second = await h.login();
    expect(first.res.statusCode).toBe(200);
    expect(second.res.statusCode).toBe(200);
    expect(first.sessionCookie).not.toBe(second.sessionCookie);
    expect(h.issuedCredentials).toHaveLength(2);
    expect(h.issuedCredentials[0]).not.toBe(h.issuedCredentials[1]);

    const readFirst = await h.inject({ url: '/webui/bff/management/channels', cookies: [first.sessionCookie] });
    const readSecond = await h.inject({ url: '/webui/bff/management/channels', cookies: [second.sessionCookie] });
    expect(readFirst.statusCode).toBe(200);
    expect(readSecond.statusCode).toBe(200);

    const bearers = new Set(
      h.upstream.requests
        .map((item) => item.headers.authorization)
        .filter((value): value is string => typeof value === 'string'),
    );
    expect(bearers).toEqual(
      new Set([`Bearer ${h.issuedCredentials[0]}`, `Bearer ${h.issuedCredentials[1]}`]),
    );

    // 注销第一个浏览器不影响第二个
    const logout = await h.inject({
      method: 'POST',
      url: '/webui/bff/auth/logout',
      cookies: [first.sessionCookie],
      headers: h.writeHeaders({ cookies: [first.sessionCookie], csrfToken: first.csrfToken }),
    });
    expect(logout.statusCode).toBe(200);

    const afterFirstLogout = await h.inject({ url: '/webui/bff/management/channels', cookies: [first.sessionCookie] });
    expect(afterFirstLogout.statusCode).toBe(401);
    const secondStillValid = await h.inject({ url: '/webui/bff/management/channels', cookies: [second.sessionCookie] });
    expect(secondStillValid.statusCode).toBe(200);
  });

  it('maxSessions=1 时第二次登录返回 429 WEBUI_CAPACITY_EXCEEDED，且不驱逐已登录会话', async () => {
    const single = await open({ config: { maxSessions: 1 } });
    const first = await single.login();
    expect(first.res.statusCode).toBe(200);

    const second = await single.login();
    expect(second.res.statusCode).toBe(429);
    expect(codeOf(second.res)).toBe('WEBUI_CAPACITY_EXCEEDED');
    expect(findCookie(second.res, single.sessionCookieName)).toBeUndefined();

    const firstStillValid = await single.inject({
      url: '/webui/bff/management/channels',
      cookies: [first.sessionCookie],
    });
    expect(firstStillValid.statusCode).toBe(200);
  });

  it('上游对 GET /auth/session 返回 401 时清理本地会话与 Cookie', async () => {
    const login = await h.login();
    expect(login.res.statusCode).toBe(200);

    const live = h.sessionFromCookie(login.sessionCookie);
    expect(live).not.toBeNull();
    // 强制走一次上游会话刷新（模块内默认 60 秒节流）
    live!.lastUpstreamSessionRefreshAt = 0;

    h.upstream.setResponder(sessionRevokedResponder());

    const res = await h.inject({ url: '/webui/bff/auth/session', cookies: [login.sessionCookie] });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { authenticated: boolean; session: null } }>();
    expect(body.data.authenticated).toBe(false);
    expect(body.data.session).toBeNull();
    expect(findCookie(res, h.sessionCookieName)?.maxAge).toBe(0);
    expect(h.sessionFromCookie(login.sessionCookie)).toBeNull();

    const afterCleanup = await h.inject({ url: '/webui/bff/management/channels', cookies: [login.sessionCookie] });
    expect(afterCleanup.statusCode).toBe(401);
    expect(codeOf(afterCleanup)).toBe('WEBUI_SESSION_REQUIRED');
  });

  it('上游判定业务请求会话失效（401）时清理本地会话', async () => {
    const login = await h.login();
    h.upstream.setResponder((request, response) => {
      if (request.path === UPSTREAM_META_PATH) {
        sendJson(response, 401, { error: { code: 'SESSION_REQUIRED' } });
        return;
      }
      sendJson(response, 401, { error: { code: 'SESSION_EXPIRED', message: 'upstream session expired' } });
    });

    const res = await h.inject({ url: '/webui/bff/management/channels', cookies: [login.sessionCookie] });
    expect(res.statusCode).toBe(401);
    expect(codeOf(res)).toBe('SESSION_EXPIRED');
    expect(res.headers['x-webui-response-source']).toBe('upstream');
    expect(findCookie(res, h.sessionCookieName)?.maxAge).toBe(0);
    expect(h.sessionFromCookie(login.sessionCookie)).toBeNull();
  });

  it('登录失败：上游 401 信封原样透传且不建立本地会话', async () => {
    h.upstream.setResponder((request, response) => {
      if (request.path === UPSTREAM_META_PATH) {
        sendJson(response, 401, { error: { code: 'SESSION_REQUIRED' } });
        return;
      }
      sendJson(
        response,
        401,
        { error: { code: 'INVALID_MANAGEMENT_KEY', message: '管理密钥无效' }, meta: { requestId: 'upstream-login-denied' } },
        { 'x-request-id': 'upstream-login-denied' },
      );
    });

    const login = await h.login();
    expect(login.res.statusCode).toBe(401);
    expect(codeOf(login.res)).toBe('INVALID_MANAGEMENT_KEY');
    expect(login.res.body).not.toContain(TEST_MANAGEMENT_KEY);
    expect(findCookie(login.res, h.sessionCookieName)).toBeUndefined();
    expect(h.sessionFromCookie(login.sessionCookie)).toBeNull();
  });

  it('上游登录响应缺少 credential/session 时返回 502 WEBUI_UPSTREAM_UNEXPECTED_CONTENT', async () => {
    h.upstream.setResponder((request, response) => {
      if (request.path === UPSTREAM_META_PATH) {
        sendJson(response, 401, { error: { code: 'SESSION_REQUIRED' } });
        return;
      }
      sendJson(response, 201, { data: { session: { sessionId: 'no-credential-here' } } });
    });

    const login = await h.login();
    expect(login.res.statusCode).toBe(502);
    expect(codeOf(login.res)).toBe('WEBUI_UPSTREAM_UNEXPECTED_CONTENT');
    expect(findCookie(login.res, h.sessionCookieName)).toBeUndefined();
  });
});
