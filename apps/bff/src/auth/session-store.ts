/**
 * 本地会话存储（有界内存）。
 *
 * 约束（实施文档 4.1）：
 * - 每个浏览器登录使用独立上游 Session，不共享固定管理员凭据。
 * - 管理主密钥只用于登录请求换票，不落盘、不写日志、不进环境变量。
 * - 本地空闲 30 分钟、绝对 8 小时，并且不超过上游已知有效期。
 * - 容量有界（默认 100 个已登录 / 200 个预登录），过期自动清理；
 *   容量满时先清理过期项，仍满则拒绝新请求（429），不驱逐有效会话。
 */

import type { WebuiConfig } from '../config.js';
import { WebuiError } from '../errors.js';
import { randomToken, sessionKeyFromToken } from '../util/crypto.js';

/** 上游可能返回的会话摘要字段；未知字段原样保留但不会被当作可信输入使用。 */
export interface UpstreamSessionSummary {
  readonly sessionId?: string;
  readonly subjectId?: string;
  readonly authMethod?: string;
  readonly roles?: readonly string[];
  readonly capabilities?: readonly string[];
  readonly issuedAt?: string;
  readonly expiresAt?: string;
  readonly idleExpiresAt?: string;
  readonly [key: string]: unknown;
}

export interface WebSession {
  /** Cookie 中随机值的 sha256，仅作内存键。 */
  readonly key: string;
  /** 上游 Session 凭证，只存在于 BFF 内存，绝不返回浏览器。 */
  upstreamCredential: string;
  upstreamSessionSummary: UpstreamSessionSummary;
  csrfToken: string;
  readonly clientIp: string;
  readonly createdAt: number;
  lastSeenAt: number;
  absoluteExpiresAt: number;
  upstreamAbsoluteExpiresAt: number | null;
  upstreamIdleExpiresAt: number | null;
  lastUpstreamSessionRefreshAt: number;
}

export interface PreloginSession {
  readonly key: string;
  csrfToken: string;
  readonly clientIp: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  /** 绑定到发起它的预登录会话的批准/导入流程（第二阶段 Telegram 登录使用）。 */
  boundFlow?: { flowId: string; secret: string; expiresAt: number };
}

export interface SessionStoreStats {
  readonly sessions: number;
  readonly prelogins: number;
  readonly maxSessions: number;
  readonly maxPrelogins: number;
}

export interface CreatedSession {
  readonly token: string;
  readonly session: WebSession;
}

function parseTime(value: unknown): number | null {
  if (typeof value !== 'string' || !value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export class SessionStore {
  private readonly sessions = new Map<string, WebSession>();
  private readonly prelogins = new Map<string, PreloginSession>();
  private readonly config: WebuiConfig;

  constructor(config: WebuiConfig) {
    this.config = config;
  }

  // ------------------------------------------------------------ 预登录会话

  /**
   * 复用仍然有效的预登录会话（bootstrap 每次刷新不应新建），否则创建。
   * 容量满时先清理过期项；仍然满则抛出容量错误，绝不驱逐有效登录流程。
   */
  getOrCreatePrelogin(token: string | undefined, clientIp: string, now = Date.now()): { prelogin: PreloginSession; token: string; created: boolean } {
    this.sweep(now);
    if (token) {
      const existing = this.prelogins.get(sessionKeyFromToken(token));
      if (existing && existing.expiresAt > now) {
        return { prelogin: existing, token, created: false };
      }
    }
    if (this.prelogins.size >= this.config.maxPreloginSessions) {
      throw new WebuiError('WEBUI_CAPACITY_EXCEEDED', {
        message: '预登录会话数量已达上限，请稍后重试',
        details: { maxPreloginSessions: this.config.maxPreloginSessions },
      });
    }
    const newToken = randomToken(32);
    const prelogin: PreloginSession = {
      key: sessionKeyFromToken(newToken),
      csrfToken: randomToken(32),
      clientIp,
      createdAt: now,
      expiresAt: now + this.config.bootstrapTtlSeconds * 1000,
    };
    this.prelogins.set(prelogin.key, prelogin);
    return { prelogin, token: newToken, created: true };
  }

  getPrelogin(token: string | undefined, now = Date.now()): PreloginSession | null {
    if (!token) return null;
    const found = this.prelogins.get(sessionKeyFromToken(token));
    if (!found) return null;
    if (found.expiresAt <= now) {
      this.prelogins.delete(found.key);
      return null;
    }
    return found;
  }

  dropPrelogin(token: string | undefined): void {
    if (!token) return;
    this.prelogins.delete(sessionKeyFromToken(token));
  }

  // ------------------------------------------------------------- 已登录会话

  createSession(params: {
    upstreamCredential: string;
    upstreamSessionSummary: UpstreamSessionSummary;
    clientIp: string;
    now?: number;
  }): CreatedSession {
    const now = params.now ?? Date.now();
    this.sweep(now);
    if (this.sessions.size >= this.config.maxSessions) {
      throw new WebuiError('WEBUI_CAPACITY_EXCEEDED', {
        message: '已登录会话数量已达上限，请稍后重试',
        details: { maxSessions: this.config.maxSessions },
      });
    }
    const token = randomToken(32);
    const upstreamExpiresAt = parseTime(params.upstreamSessionSummary.expiresAt);
    const upstreamIdleExpiresAt = parseTime(params.upstreamSessionSummary.idleExpiresAt);
    const localAbsolute = now + this.config.sessionMaxSeconds * 1000;
    const session: WebSession = {
      key: sessionKeyFromToken(token),
      upstreamCredential: params.upstreamCredential,
      upstreamSessionSummary: params.upstreamSessionSummary,
      csrfToken: randomToken(32),
      clientIp: params.clientIp,
      createdAt: now,
      lastSeenAt: now,
      // 本地绝对截止取"创建时刻 + 8 小时"与上游 expiresAt 的较小值
      absoluteExpiresAt: upstreamExpiresAt ? Math.min(localAbsolute, upstreamExpiresAt) : localAbsolute,
      upstreamAbsoluteExpiresAt: upstreamExpiresAt,
      upstreamIdleExpiresAt,
      lastUpstreamSessionRefreshAt: now,
    };
    this.sessions.set(session.key, session);
    return { token, session };
  }

  /**
   * 取出会话，并检查本地空闲期与上游已知有效期。
   * 返回 null 表示会话不存在或已过期（调用方应清理 Cookie 并转登录）。
   */
  getSession(token: string | undefined, now = Date.now()): WebSession | null {
    if (!token) return null;
    const key = sessionKeyFromToken(token);
    const session = this.sessions.get(key);
    if (!session) return null;
    if (this.isExpired(session, now)) {
      this.sessions.delete(key);
      return null;
    }
    session.lastSeenAt = now;
    return session;
  }

  isExpired(session: WebSession, now = Date.now()): boolean {
    if (session.absoluteExpiresAt <= now) return true;
    if (now - session.lastSeenAt > this.config.sessionIdleSeconds * 1000) return true;
    if (session.upstreamAbsoluteExpiresAt !== null && session.upstreamAbsoluteExpiresAt <= now) return true;
    return false;
  }

  /** 用真实 GET /auth/session 的摘要刷新上游 idle 截止时间。 */
  applyUpstreamSessionSummary(session: WebSession, summary: UpstreamSessionSummary, now = Date.now()): void {
    session.upstreamSessionSummary = summary;
    session.lastUpstreamSessionRefreshAt = now;
    const absolute = parseTime(summary.expiresAt);
    if (absolute !== null) {
      session.upstreamAbsoluteExpiresAt = absolute;
      session.absoluteExpiresAt = Math.min(now + this.config.sessionMaxSeconds * 1000, absolute);
    }
    session.upstreamIdleExpiresAt = parseTime(summary.idleExpiresAt);
  }

  destroySession(token: string | undefined): WebSession | null {
    if (!token) return null;
    const key = sessionKeyFromToken(token);
    const session = this.sessions.get(key);
    if (!session) return null;
    this.sessions.delete(key);
    return session;
  }

  stats(): SessionStoreStats {
    return {
      sessions: this.sessions.size,
      prelogins: this.prelogins.size,
      maxSessions: this.config.maxSessions,
      maxPrelogins: this.config.maxPreloginSessions,
    };
  }

  /** 有界清理：按绝对/空闲过期删除，不做任何无界增长。 */
  sweep(now = Date.now()): void {
    for (const [key, session] of this.sessions) {
      if (this.isExpired(session, now)) this.sessions.delete(key);
    }
    for (const [key, prelogin] of this.prelogins) {
      if (prelogin.expiresAt <= now) this.prelogins.delete(key);
    }
  }
}
