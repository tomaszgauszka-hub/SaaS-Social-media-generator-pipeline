import { sleep as abortableSleep } from "@cre/shared";

/**
 * Client-side token bucket shared by every Google call of a process (GOOGLE_MAX_RPM). It smooths bursts from
 * parallel variants so the project quota is not hit with 429s in the first place; server-side 429s are still
 * handled by the transport's Retry-After logic.
 *
 * Refill is continuous (`perMinute / 60 000` tokens per ms) and the bucket holds at most `burst` tokens, so the
 * sustained rate never exceeds `perMinute` while short bursts stay possible.
 */
export interface RateLimiter {
  /** waits (abortably) until a request may be sent */
  acquire(signal?: AbortSignal): Promise<void>;
}

export interface TokenBucketOptions {
  perMinute: number;
  /** bucket capacity (default: a tenth of a minute's quota, at least 1) */
  burst?: number;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export class TokenBucket implements RateLimiter {
  private ratePerMs = 1 / 60_000;
  private capacity = 1;
  private tokens = Number.POSITIVE_INFINITY;
  private last: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;

  constructor(opts: TokenBucketOptions) {
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? abortableSleep;
    this.configure(opts.perMinute, opts.burst); // starts full
    this.last = this.now();
  }

  /** change the rate (the process-wide bucket follows the latest GOOGLE_MAX_RPM) */
  configure(perMinute: number, burst?: number): void {
    const rpm = Math.max(1, perMinute);
    this.ratePerMs = rpm / 60_000;
    this.capacity = Math.max(1, burst ?? Math.round(rpm / 10));
    this.tokens = Math.min(this.tokens, this.capacity);
  }

  get perMinute(): number {
    return this.ratePerMs * 60_000;
  }

  async acquire(signal?: AbortSignal): Promise<void> {
    for (;;) {
      signal?.throwIfAborted();
      this.refill();
      // no await between the check and the decrement → safe under concurrent callers
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      await this.sleep(Math.max(1, Math.ceil((1 - this.tokens) / this.ratePerMs)), signal);
    }
  }

  private refill(): void {
    const t = this.now();
    this.tokens = Math.min(this.capacity, this.tokens + (t - this.last) * this.ratePerMs);
    this.last = t;
  }
}

let shared: TokenBucket | undefined;

/** The process-wide Google limiter (created on first use, re-rated when GOOGLE_MAX_RPM changes). */
export function sharedGoogleRateLimiter(perMinute: number): TokenBucket {
  if (!shared) shared = new TokenBucket({ perMinute });
  else if (Math.abs(shared.perMinute - perMinute) > 1e-9) shared.configure(perMinute);
  return shared;
}
