/**
 * 应用上下文：把配置、会话存储、限流器、上游客户端装配在一起，供各路由复用。
 */

import type { WebuiConfig } from './config.js';
import { SessionStore } from './auth/session-store.js';
import { ConcurrencyGate, FixedWindowRateLimiter } from './security/rate-limit.js';
import { UpstreamClient } from './upstream/client.js';
import { UPSTREAM_CONTRACT_SOURCE } from '@parrot-webui/contracts/routes';

export interface AppContext {
  readonly config: WebuiConfig;
  readonly store: SessionStore;
  readonly upstream: UpstreamClient;
  readonly limiters: {
    readonly loginPerSource: FixedWindowRateLimiter;
    readonly loginGlobal: FixedWindowRateLimiter;
    readonly bootstrapPerSource: FixedWindowRateLimiter;
    readonly bootstrapGlobal: FixedWindowRateLimiter;
  };
  readonly gates: {
    readonly login: ConcurrencyGate;
    readonly bootstrap: ConcurrencyGate;
  };
  readonly contract: typeof UPSTREAM_CONTRACT_SOURCE;
  readonly startedAt: number;
  readonly ready: { staticAssetsPresent: boolean };
  dispose(): Promise<void>;
}

export function createContext(config: WebuiConfig, options: { staticAssetsPresent?: boolean } = {}): AppContext {
  const upstream = new UpstreamClient(config);
  const oneMinute = 60_000;
  return {
    config,
    store: new SessionStore(config),
    upstream,
    limiters: {
      loginPerSource: new FixedWindowRateLimiter({ limit: config.loginPerSourcePerMinute, windowMs: oneMinute }),
      // 全局限流用常量键 'global'：固定键，不允许被容量淘汰挤掉（否则轮换来源可绕过全局限制）
      loginGlobal: new FixedWindowRateLimiter({
        limit: config.loginGlobalPerMinute,
        windowMs: oneMinute,
        pinnedKeys: ['global'],
      }),
      bootstrapPerSource: new FixedWindowRateLimiter({
        limit: config.bootstrapPerSourcePerMinute,
        windowMs: oneMinute,
      }),
      bootstrapGlobal: new FixedWindowRateLimiter({
        limit: config.bootstrapGlobalPerMinute,
        windowMs: oneMinute,
        pinnedKeys: ['global'],
      }),
    },
    gates: {
      login: new ConcurrencyGate(config.maxConcurrentLogin),
      bootstrap: new ConcurrencyGate(config.maxConcurrentBootstrap),
    },
    contract: UPSTREAM_CONTRACT_SOURCE,
    startedAt: Date.now(),
    ready: { staticAssetsPresent: options.staticAssetsPresent ?? false },
    async dispose() {
      await upstream.close();
    },
  };
}
