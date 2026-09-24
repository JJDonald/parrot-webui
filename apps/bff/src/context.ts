/**
 * 应用上下文：把配置、会话存储、限流器、上游客户端装配在一起，供各路由复用。
 */

import type { WebuiConfig } from './config.js';
import { SessionStore } from './auth/session-store.js';
import { ConcurrencyGate, SlidingWindowRateLimiter } from './security/rate-limit.js';
import { UpstreamClient } from './upstream/client.js';
import { UPSTREAM_CONTRACT_SOURCE } from '@parrot-webui/contracts/routes';

export interface AppContext {
  readonly config: WebuiConfig;
  readonly store: SessionStore;
  readonly upstream: UpstreamClient;
  readonly limiters: {
    readonly loginPerSource: SlidingWindowRateLimiter;
    readonly loginGlobal: SlidingWindowRateLimiter;
    readonly bootstrapPerSource: SlidingWindowRateLimiter;
    readonly bootstrapGlobal: SlidingWindowRateLimiter;
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
      loginPerSource: new SlidingWindowRateLimiter({ limit: config.loginPerSourcePerMinute, windowMs: oneMinute }),
      loginGlobal: new SlidingWindowRateLimiter({ limit: config.loginGlobalPerMinute, windowMs: oneMinute }),
      bootstrapPerSource: new SlidingWindowRateLimiter({
        limit: config.bootstrapPerSourcePerMinute,
        windowMs: oneMinute,
      }),
      bootstrapGlobal: new SlidingWindowRateLimiter({
        limit: config.bootstrapGlobalPerMinute,
        windowMs: oneMinute,
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
