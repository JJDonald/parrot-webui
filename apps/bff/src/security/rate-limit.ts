/**
 * 有界限流与并发闸门。
 *
 * 会话/预登录/限流容器都必须有容量上限并定期清理，不能随匿名访问无限增长（实施文档 11.1）。
 */

export interface RateLimitVerdict {
  readonly allowed: boolean;
  readonly remaining: number;
  readonly retryAfterSeconds: number;
}

interface WindowState {
  count: number;
  windowStartedAt: number;
}

/**
 * 固定窗口计数器（窗口边界处最多放行 2×limit）。
 *
 * 早期版本叫 `SlidingWindowRateLimiter`，但实现一直是固定窗口：窗口起点写死在
 * `windowStartedAt`，到点整体重置。名字与实现不符会误导运维与后续维护者，
 * 这里改回本名。真正的滑动窗口需要保存每次请求的时间戳队列，成本更高；
 * 对"登录/引导接口防暴力猜解"这个用途，固定窗口足够。
 *
 * 容器有界策略：`maxKeys` 之外的键按最旧窗口淘汰，但 `pinnedKeys` 里的键
 * （全局计数用的常量键）永不淘汰——否则攻击者用轮换来源（IPv6 /64）把表刷满，
 * 就能把全局计数挤掉，等于绕过全局限流。
 */
export class FixedWindowRateLimiter {
  private readonly windows = new Map<string, WindowState>();
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly maxKeys: number;
  private readonly pinnedKeys: ReadonlySet<string>;

  constructor(options: { limit: number; windowMs: number; maxKeys?: number; pinnedKeys?: readonly string[] }) {
    this.limit = options.limit;
    this.windowMs = options.windowMs;
    this.maxKeys = options.maxKeys ?? 4096;
    this.pinnedKeys = new Set(options.pinnedKeys ?? []);
  }

  check(key: string, now = Date.now()): RateLimitVerdict {
    this.sweep(now);
    const state = this.windows.get(key);
    if (!state || now - state.windowStartedAt >= this.windowMs) {
      this.windows.set(key, { count: 1, windowStartedAt: now });
      return { allowed: true, remaining: Math.max(0, this.limit - 1), retryAfterSeconds: 0 };
    }
    if (state.count >= this.limit) {
      const retryAfterSeconds = Math.max(1, Math.ceil((state.windowStartedAt + this.windowMs - now) / 1000));
      return { allowed: false, remaining: 0, retryAfterSeconds };
    }
    state.count += 1;
    return { allowed: true, remaining: Math.max(0, this.limit - state.count), retryAfterSeconds: 0 };
  }

  reset(): void {
    this.windows.clear();
  }

  get size(): number {
    return this.windows.size;
  }

  private sweep(now: number): void {
    // 常规情况下按窗口过期清理
    for (const [key, state] of this.windows) {
      if (now - state.windowStartedAt >= this.windowMs) this.windows.delete(key);
    }
    if (this.windows.size < this.maxKeys) return;
    // 仍然超限时按最旧窗口淘汰，但固定键不参与淘汰，保证全局计数不会被刷掉
    const removable = [...this.windows.entries()]
      .filter(([key]) => !this.pinnedKeys.has(key))
      .sort((a, b) => a[1].windowStartedAt - b[1].windowStartedAt);
    const removeCount = removable.length - this.maxKeys + this.pinnedKeys.size + 1;
    for (let index = 0; index < removeCount && index < removable.length; index += 1) {
      this.windows.delete(removable[index]![0]);
    }
  }
}

export class ConcurrencyGate {
  private active = 0;
  private readonly limit: number;

  constructor(limit: number) {
    this.limit = limit;
  }

  get inFlight(): number {
    return this.active;
  }

  tryEnter(): boolean {
    if (this.active >= this.limit) return false;
    this.active += 1;
    return true;
  }

  leave(): void {
    this.active = Math.max(0, this.active - 1);
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (!this.tryEnter()) throw new Error('concurrency gate exhausted');
    try {
      return await task();
    } finally {
      this.leave();
    }
  }
}
