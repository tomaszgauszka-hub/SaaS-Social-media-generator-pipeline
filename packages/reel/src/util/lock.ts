import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

/**
 * Host-wide resource semaphore (e.g. "blender" with 1 slot) built on exclusive lock files, so several worker
 * processes on one machine never render on the same CPU/GPU at once. Stale locks (dead PID) are reclaimed.
 */
export async function withResourceLock<T>(
  lockDir: string,
  resource: string,
  slots: number,
  fn: () => Promise<T>,
  opts: { pollMs?: number; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<T> {
  await fsp.mkdir(lockDir, { recursive: true });
  const started = Date.now();
  for (;;) {
    opts.signal?.throwIfAborted();
    for (let slot = 0; slot < slots; slot++) {
      const file = path.join(lockDir, `${resource}.${slot}.lock`);
      if (tryAcquire(file)) {
        try {
          return await fn();
        } finally {
          await fsp.rm(file, { force: true });
        }
      }
    }
    if (opts.timeoutMs && Date.now() - started > opts.timeoutMs) {
      throw new Error(`timed out waiting for resource lock "${resource}"`);
    }
    await new Promise((r) => setTimeout(r, opts.pollMs ?? 500));
  }
}

function tryAcquire(file: string): boolean {
  try {
    fs.writeFileSync(file, String(process.pid), { flag: "wx" });
    return true;
  } catch {
    // reclaim a lock whose owner process is gone
    try {
      const pid = Number(fs.readFileSync(file, "utf8"));
      if (Number.isFinite(pid) && pid > 0 && !alive(pid)) {
        fs.rmSync(file, { force: true });
        fs.writeFileSync(file, String(process.pid), { flag: "wx" });
        return true;
      }
    } catch {
      /* someone else won the race */
    }
    return false;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
