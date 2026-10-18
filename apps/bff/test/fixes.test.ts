/**
 * 评审修复项的语义回归测试。
 *
 *  1. 本地绝对会话期限锚定在"创建时刻"，不会被上游刷新滑动延长
 *  2. query 净化不再误伤合法值（文件名/版本号/时间戳），但仍拦真正的相对路径
 *  3. `/stats/models/{modelId:path}` 支持含斜杠的模型 id（上游 Starlette path 转换器语义）
 *  4. 会话绝对期限不会超过上游 expiresAt
 *  5. 有界限流器不会因为键刷满而丢掉全局固定键
 *  6. 已删除的 `/session-summary` 影子端点确实不可达
 */

import { afterEach, describe, expect, it } from 'vitest';
import { WebuiError } from '../src/errors.js';
import { matchProxyRoute, sanitizeUpstreamQuery } from '../src/security/route-allowlist.js';
import { FixedWindowRateLimiter } from '../src/security/rate-limit.js';
import { SessionStore } from '../src/auth/session-store.js';
import { createHarness, findCookie, makeConfig, type Harness } from './helpers.js';

const opened: Harness[] = [];

afterEach(async () => {
  while (opened.length) {
    const harness = opened.pop();
    if (harness) await harness.close();
  }
});

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

// ---------------------------------------------------------------- query 净化

describe('sanitizeUpstreamQuery', () => {
  it('允许日志搜索里的常见合法值（曾因匹配子串 .. 被误伤）', () => {
    const allowed = [
      'query=a..b',
      'query=nginx%2F1.2',
      'query=2026-01-01T00%3A00%3A00Z',
      'query=v1.2.3',
      'query=api.example.com',
      'query=https%3A%2F%2Fapi.example.com%2Fv1',
      'text=hello%20world',
      'name=my-key.1',
      'filter=status%3Dfailed',
      'search=%E4%B8%AD%E6%96%87',
      'page=1&pageSize=20',
    ];
    for (const raw of allowed) {
      expect(() => sanitizeUpstreamQuery(raw), raw).not.toThrow();
    }
  });

  it('仍然拒绝真正的相对路径形状', () => {
    const rejected = ['query=../etc/passwd', 'query=a/../b', 'query=..', 'query=..%5Cwin', 'query=x/..'];
    for (const raw of rejected) {
      expectWebuiError(() => sanitizeUpstreamQuery(raw), 'WEBUI_INVALID_REQUEST');
    }
  });

  it('拒绝被明确禁止的参数键', () => {
    for (const raw of ['url=http://evil.test', 'next=/x', 'redirect=/y', 'host=evil.test', 'PROXY=1']) {
      expectWebuiError(() => sanitizeUpstreamQuery(raw), 'WEBUI_INVALID_REQUEST');
    }
  });

  it('拒绝超长单值与超长 query 串', () => {
    expectWebuiError(() => sanitizeUpstreamQuery(`query=${'a'.repeat(1025)}`), 'WEBUI_INVALID_REQUEST');
    expectWebuiError(() => sanitizeUpstreamQuery(`query=${'a'.repeat(5000)}`), 'WEBUI_INVALID_REQUEST');
  });

  it('拒绝控制字符与 fragment', () => {
    expectWebuiError(() => sanitizeUpstreamQuery('query=a%00b'), 'WEBUI_INVALID_REQUEST');
    expectWebuiError(() => sanitizeUpstreamQuery('query=a#b'), 'WEBUI_INVALID_REQUEST');
  });

  it('空 query 原样返回空串', () => {
    expect(sanitizeUpstreamQuery('')).toBe('');
  });
});

// ---------------------------------------------------- path 转换器（含斜杠的 id）

describe('matchProxyRoute 的 Starlette path 转换器', () => {
  // 注意：matchProxyRoute 接收的是"去掉 /webui/bff/management 前缀之后"的相对路径，
  // 与 apps/bff/src/routes/management-proxy.ts:81-82 的调用方式一致。
  it('含斜杠的模型 id 可以被一路送到上游，且逐段重新编码', () => {
    const match = matchProxyRoute('GET', '/stats/models/provider/model-a');
    expect(match.route.upstreamOperationId).toBe('getModelStats');
    expect(match.params.modelId).toBe('provider/model-a');
    expect(match.upstreamPath).toBe('/api/management/v1/stats/models/provider/model-a');
  });

  it('单段模型 id 仍按原行为匹配', () => {
    const match = matchProxyRoute('GET', '/stats/models/plain-model');
    expect(match.params.modelId).toBe('plain-model');
    expect(match.upstreamPath).toBe('/api/management/v1/stats/models/plain-model');
  });

  it('路径型 id 里的特殊字符被逐段编码', () => {
    const match = matchProxyRoute('GET', '/stats/models/provider/model%20a');
    expect(match.params.modelId).toBe('provider/model a');
    expect(match.upstreamPath).toBe('/api/management/v1/stats/models/provider/model%20a');
  });

  it('路径型 id 为空（只有前缀）时拒绝', () => {
    expectWebuiError(() => matchProxyRoute('GET', '/stats/models'), 'WEBUI_ROUTE_NOT_ALLOWED');
  });

  it('其它路由不吃多段路径（不能借 path 转换器扩大攻击面）', () => {
    expectWebuiError(() => matchProxyRoute('GET', '/channels/abc/extra/segments'), 'WEBUI_ROUTE_NOT_ALLOWED');
  });
});

// ------------------------------------------------------------ 会话绝对期限

describe('本地会话绝对期限', () => {
  function newStore() {
    return new SessionStore(makeConfig('http://127.0.0.1:1', { sessionIdleSeconds: 1800, sessionMaxSeconds: 28_800 }));
  }

  const summary = (expiresAt: number) => ({
    sessionId: 's1',
    expiresAt: new Date(expiresAt).toISOString(),
    idleExpiresAt: new Date(expiresAt).toISOString(),
  });

  it('创建时的绝对期限 = 创建时刻 + 8 小时（与上游取较小值）', () => {
    const store = newStore();
    const t0 = 1_700_000_000_000;
    const created = store.createSession({
      upstreamCredential: 'cred',
      upstreamSessionSummary: summary(t0 + 100 * 3600 * 1000),
      clientIp: '127.0.0.1',
      now: t0,
    });
    expect(created.session.absoluteExpiresAt).toBe(t0 + 28_800_000);
  });

  it('上游刷新不会把绝对期限往后推（曾按 now 计算，可无限续期）', () => {
    const store = newStore();
    const t0 = 1_700_000_000_000;
    const created = store.createSession({
      upstreamCredential: 'cred',
      upstreamSessionSummary: summary(t0 + 100 * 3600 * 1000),
      clientIp: '127.0.0.1',
      now: t0,
    });
    const { session } = created;

    // T+7h 刷新一次：绝对期限必须仍是 T+8h，不能变成 T+15h
    store.applyUpstreamSessionSummary(session, summary(t0 + 100 * 3600 * 1000), t0 + 7 * 3600 * 1000);
    expect(session.absoluteExpiresAt).toBe(t0 + 28_800_000);

    // T+14h 再刷新一次：依旧不变
    store.applyUpstreamSessionSummary(session, summary(t0 + 100 * 3600 * 1000), t0 + 14 * 3600 * 1000);
    expect(session.absoluteExpiresAt).toBe(t0 + 28_800_000);

    // 到了 T+8h 就必须判定过期；临界点前若不是空闲超时则仍可用
    expect(store.isExpired(session, t0 + 8 * 3600 * 1000)).toBe(true);
    expect(store.isExpired({ ...session, lastSeenAt: t0 + 8 * 3600 * 1000 - 1 }, t0 + 8 * 3600 * 1000 - 1)).toBe(
      false,
    );
  });

  it('上游 expiresAt 更早时取上游值，且后续刷新不会放宽它', () => {
    const store = newStore();
    const t0 = 1_700_000_000_000;
    const upstreamDeadline = t0 + 2 * 3600 * 1000;
    const created = store.createSession({
      upstreamCredential: 'cred',
      upstreamSessionSummary: summary(upstreamDeadline),
      clientIp: '127.0.0.1',
      now: t0,
    });
    expect(created.session.absoluteExpiresAt).toBe(upstreamDeadline);

    // 上游后来给出更晚的 expiresAt：本地期限以 createdAt 为锚，仍取更早者
    store.applyUpstreamSessionSummary(created.session, summary(t0 + 100 * 3600 * 1000), t0 + 3600 * 1000);
    expect(created.session.absoluteExpiresAt).toBe(t0 + 28_800_000);
  });

  it('上游摘要缺 expiresAt 时保持原有绝对期限不变', () => {
    const store = newStore();
    const t0 = 1_700_000_000_000;
    const created = store.createSession({
      upstreamCredential: 'cred',
      upstreamSessionSummary: summary(t0 + 100 * 3600 * 1000),
      clientIp: '127.0.0.1',
      now: t0,
    });
    store.applyUpstreamSessionSummary(created.session, { sessionId: 's1' }, t0 + 7 * 3600 * 1000);
    expect(created.session.absoluteExpiresAt).toBe(t0 + 28_800_000);
  });
});

// ------------------------------------------------- v6 能力判定的真实上游取值

describe('会话能力字段', () => {
  it('上游返回的 capabilities 经 GET /auth/session 原样暴露（供 canWrite 判定）', async () => {
    const harness = await createHarness();
    opened.push(harness);
    const login = await harness.login();
    expect(login.res.statusCode).toBe(200);

    // login 响应只回 session/csrfToken/upstream；capabilities 由 session 接口暴露
    const res = await harness.inject({
      method: 'GET',
      url: '/webui/bff/auth/session',
      cookies: [login.sessionCookie],
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { authenticated: boolean; capabilities: string[] } }>();
    expect(body.data.authenticated).toBe(true);
    // 假上游在 helpers.upstreamSessionSummary 里固定返回这两个能力
    expect(body.data.capabilities).toEqual(['channels.read', 'channels.write']);
  });
});

// ------------------------------------------------------------ 有界限流容器

describe('FixedWindowRateLimiter 的有界性', () => {
  it('超出 maxKeys 时淘汰最旧键，但固定键 global 不会被淘汰', () => {
    const limiter = new FixedWindowRateLimiter({ limit: 5, windowMs: 60_000, maxKeys: 4, pinnedKeys: ['global'] });
    const t0 = 1_700_000_000_000;
    // 先打满全局键，再刷入远超容量的轮换来源键（模拟 IPv6 /64 攻击）
    for (let index = 0; index < 5; index += 1) limiter.check('global', t0);
    expect(limiter.check('global', t0).allowed).toBe(false);

    for (let index = 0; index < 50; index += 1) {
      limiter.check(`10.0.0.${index}`, t0 + index);
    }
    expect(limiter.size).toBeLessThanOrEqual(4);
    // 全局键仍然保留且仍处于"已超限"状态：轮换来源没能把全局计数挤掉
    expect(limiter.check('global', t0 + 100).allowed).toBe(false);
  });

  it('窗口过期后计数重置', () => {
    const limiter = new FixedWindowRateLimiter({ limit: 1, windowMs: 1000 });
    const t0 = 1_700_000_000_000;
    expect(limiter.check('k', t0).allowed).toBe(true);
    expect(limiter.check('k', t0 + 100).allowed).toBe(false);
    expect(limiter.check('k', t0 + 1001).allowed).toBe(true);
  });
});

// ------------------------------------------------- 已删除的影子端点

describe('会话刷新入口', () => {
  it('/webui/bff/management/session-summary 已删除（不再有绕过允许清单的本地端点）', async () => {
    const harness = await createHarness();
    opened.push(harness);
    const login = await harness.login();
    const res = await harness.inject({
      method: 'GET',
      url: '/webui/bff/management/session-summary',
      cookies: [login.sessionCookie],
    });
    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('WEBUI_ROUTE_NOT_ALLOWED');
  });
});

// ---------------------------------------------- 401 错误码语义（REQUIRED vs EXPIRED）

describe('会话 401 错误码语义', () => {
  it('完全没有会话 Cookie 时返回 WEBUI_SESSION_REQUIRED（从未登录）', async () => {
    const harness = await createHarness();
    opened.push(harness);
    const res = await harness.inject({ url: '/webui/bff/management/channels' });
    expect(res.statusCode).toBe(401);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('WEBUI_SESSION_REQUIRED');
  });

  it('带着已失效的会话 Cookie 时返回 WEBUI_SESSION_EXPIRED，并清掉 Cookie', async () => {
    const harness = await createHarness();
    opened.push(harness);
    const login = await harness.login();
    // 模拟"本地会话已消失但浏览器 Cookie 还在"（空闲超时/容量驱逐后的真实形态）
    harness.app.webui.store.destroySession(login.sessionCookie.split('=')[1]);
    const res = await harness.inject({
      url: '/webui/bff/management/channels',
      cookies: [login.sessionCookie],
    });
    expect(res.statusCode).toBe(401);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('WEBUI_SESSION_EXPIRED');
    const cleared = findCookie(res, harness.sessionCookieName);
    expect(cleared?.maxAge).toBe(0);
  });
});
