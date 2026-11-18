export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly retryAfterSeconds: number;
  readonly remaining: number;
}

interface Bucket {
  used: number;
  resetAt: number;
}

/**
 * Fixed-window limiter keyed by authenticated user. Deliberately does not key
 * on IP addresses, so limiter state contains no network identifiers.
 */
export class RateLimiter {
  readonly #max: number;
  readonly #windowMs: number;
  readonly #now: () => number;
  readonly #buckets = new Map<string, Bucket>();

  constructor(options: { maxRequests: number; windowMs: number; now?: () => number }) {
    this.#max = Math.max(1, options.maxRequests);
    this.#windowMs = Math.max(1, options.windowMs);
    this.#now = options.now ?? (() => Date.now());
  }

  check(key: string): RateLimitDecision {
    const now = this.#now();
    let bucket = this.#buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { used: 0, resetAt: now + this.#windowMs };
      this.#buckets.set(key, bucket);
    }
    if (bucket.used >= this.#max) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
        remaining: 0,
      };
    }
    bucket.used += 1;
    return {
      allowed: true,
      retryAfterSeconds: 0,
      remaining: Math.max(0, this.#max - bucket.used),
    };
  }

  reset(): void {
    this.#buckets.clear();
  }
}
