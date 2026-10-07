import { TimeoutError } from "./errors.ts";

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error("Aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason instanceof Error ? signal.reason : new Error("Aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Run `fn` with an AbortSignal that fires after `timeoutMs` (or when `parent` aborts).
 * The promise rejects with TimeoutError even if `fn` ignores the signal.
 */
export async function withTimeout<T>(
  timeoutMs: number,
  fn: (signal: AbortSignal) => Promise<T>,
  opts: { parent?: AbortSignal; label?: string } = {},
): Promise<T> {
  const controller = new AbortController();
  const label = opts.label ?? "operation";
  const timeoutErr = new TimeoutError(`${label} timed out after ${timeoutMs} ms`);
  let timer: NodeJS.Timeout | undefined;
  const onParentAbort = () => controller.abort(opts.parent?.reason);
  opts.parent?.addEventListener("abort", onParentAbort, { once: true });
  try {
    return await Promise.race([
      fn(controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort(timeoutErr);
          reject(timeoutErr);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    opts.parent?.removeEventListener("abort", onParentAbort);
  }
}

/** Exponential backoff with full jitter: random(0, base * 2^attempt) capped at maxMs. */
export function backoffDelay(attempt: number, baseMs = 1000, maxMs = 60_000): number {
  const exp = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt));
  return Math.floor(Math.random() * exp);
}

/** Run async tasks with bounded concurrency, preserving result order. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index] as T, index);
    }
  });
  await Promise.all(workers);
  return results;
}
