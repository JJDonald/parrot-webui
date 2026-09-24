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

export class SlidingWindowRateLimiter {
  private readonly windows = new Map<string, WindowState>();
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly maxKeys: number;

  constructor(options: { limit: number; windowMs: number; maxKeys?: number }) {
    this.limit = options.limit;
    this.windowMs = options.windowMs;
    this.maxKeys = options.maxKeys ?? 4096;
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

  /** 请求流程因其他原因失败时回补配额，避免把失败尝试计入用户额度。 */
  refund(key: string, now = Date.now()): void {
    const state = this.windows.get(key);
    if (!state) return;
    if (now - state.windowStartedAt >= this.windowMs) return;
    state.count = Math.max(0, state.count - 1);
  }

  reset(): void {
    this.windows.clear();
  }

  get size(): number {
    return this.windows.size;
  }

  private sweep(now: number): void {
    if (this.windows.size < this.maxKeys) {
      // 常规情况下按窗口过期清理
      for (const [key, state] of this.windows) {
        if (now - state.windowStartedAt >= this.windowMs) this.windows.delete(key);
      }
      return;
    }
    for (const [key, state] of this.windows) {
      if (now - state.windowStartedAt >= this.windowMs) this.windows.delete(key);
    }
    // 仍然超限时按最旧窗口淘汰，保证容器有界
    if (this.windows.size >= this.maxKeys) {
      const sorted = [...this.windows.entries()].sort((a, b) => a[1].windowStartedAt - b[1].windowStartedAt);
      const removeCount = sorted.length - this.maxKeys + 1;
      for (let index = 0; index < removeCount; index += 1) {
        this.windows.delete(sorted[index]![0]);
      }
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
