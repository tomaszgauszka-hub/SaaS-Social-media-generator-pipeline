import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RetryableError } from "@cre/shared";

/**
 * Host-wide resource semaphore (e.g. "blender" with 1 slot) built on exclusive lock files, so several worker
 * processes on one machine never render on the same CPU/GPU at once.
 *
 * A lock file names its owner ({ pid, host, ns, boot, start, nonce }); it is created complete (a temp file
 * hard-linked into place, which fails when the lock exists) and its mtime is refreshed while it is held. A lock is
 * stale — and reclaimed — when
 *   - its owner is on this host (same hostname and PID namespace) and the process is gone, the PID now belongs to a
 *     process started at another time (PID reuse after a restart: /proc start time), or the host has rebooted;
 *   - the owner cannot be checked (another host / container, no /proc) and its heartbeat is older than `staleMs`;
 *   - the file is empty or unreadable and older than a few seconds (a crashed writer, an older lock format).
 * A reclaim renames the stale file away and checks it is still the one judged stale before taking the slot, so
 * two waiters never both win.
 */

export interface ResourceLockOptions {
  pollMs?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** an owner that cannot be checked is gone after this long without a heartbeat (default 60 s) */
  staleMs?: number;
}

/** an empty / unreadable lock younger than this may still be written by an older-format writer */
const UNREADABLE_GRACE_MS = 5_000;

interface LockOwner {
  pid: number;
  host: string;
  ns: string;
  boot: string;
  start?: string;
  nonce: string;
}

const readText = (file: string): string => {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
};
const readLink = (file: string): string => {
  try {
    return fs.readlinkSync(file);
  } catch {
    return "";
  }
};

const HOST = os.hostname();
const PID_NS = readLink("/proc/self/ns/pid");
const BOOT = readText("/proc/sys/kernel/random/boot_id").trim();

/** Start time of a process (clock ticks since boot, /proc/<pid>/stat field 22); undefined without /proc. */
function processStart(pid: number): string | undefined {
  const stat = readText(`/proc/${pid}/stat`);
  if (!stat) return undefined;
  // the command name (field 2) may contain spaces and parentheses: count fields after its closing ")"
  return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
}

const SELF_START = processStart(process.pid);

export async function withResourceLock<T>(
  lockDir: string,
  resource: string,
  slots: number,
  fn: () => Promise<T>,
  opts: ResourceLockOptions = {},
): Promise<T> {
  await fsp.mkdir(lockDir, { recursive: true });
  const staleMs = opts.staleMs ?? 60_000;
  const started = Date.now();
  for (;;) {
    opts.signal?.throwIfAborted();
    for (let slot = 0; slot < slots; slot++) {
      const file = path.join(lockDir, `${resource}.${slot}.lock`);
      const body = tryAcquire(file, staleMs);
      if (body !== null) {
        const heartbeat = setInterval(() => touch(file, body), Math.max(20, staleMs / 4));
        heartbeat.unref();
        try {
          return await fn();
        } finally {
          clearInterval(heartbeat);
          release(file, body);
        }
      }
    }
    if (opts.timeoutMs && Date.now() - started > opts.timeoutMs) {
      throw new RetryableError(`timed out waiting for resource lock "${resource}"`);
    }
    await new Promise((r) => setTimeout(r, opts.pollMs ?? 500));
  }
}

/** Takes the slot (a fresh one, or a stale one reclaimed); returns the lock body written, or null. */
function tryAcquire(file: string, staleMs: number): string | null {
  const owner: LockOwner = {
    pid: process.pid,
    host: HOST,
    ns: PID_NS,
    boot: BOOT,
    ...(SELF_START !== undefined ? { start: SELF_START } : {}),
    nonce: randomUUID(),
  };
  const body = JSON.stringify(owner);
  if (create(file, body)) return body;
  let seen: string;
  let ageMs: number;
  try {
    seen = fs.readFileSync(file, "utf8");
    ageMs = Date.now() - fs.statSync(file).mtimeMs;
  } catch {
    return null; // released meanwhile: the next round takes it
  }
  if (!isStale(seen, ageMs, staleMs)) return null;
  const grave = `${file}.stale-${process.pid}-${owner.nonce}`;
  try {
    fs.renameSync(file, grave);
  } catch {
    return null; // another waiter moved it first
  }
  if (readText(grave) !== seen) {
    // another waiter reclaimed the slot between our read and our rename: this is its fresh lock, put it back
    try {
      fs.linkSync(grave, file);
    } catch {
      /* the slot was taken again meanwhile */
    }
    fs.rmSync(grave, { force: true });
    return null;
  }
  fs.rmSync(grave, { force: true });
  return create(file, body) ? body : null;
}

/** Creates the lock file with its whole body at once; false when it exists. */
function create(file: string, body: string): boolean {
  const tmp = `${file}.new-${process.pid}-${randomUUID()}`;
  try {
    fs.writeFileSync(tmp, body);
    fs.linkSync(tmp, file);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
    // a filesystem without hard links: exclusive create (the body follows the create immediately)
    try {
      fs.writeFileSync(file, body, { flag: "wx" });
      return true;
    } catch {
      return false;
    }
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

function isStale(body: string, ageMs: number, staleMs: number): boolean {
  const owner = parseOwner(body);
  if (!owner) return ageMs > UNREADABLE_GRACE_MS;
  if (owner.host === HOST && owner.ns === PID_NS) {
    if (owner.boot !== BOOT) return true; // rebooted since: every process of that boot is gone
    if (!alive(owner.pid)) return true;
    const start = processStart(owner.pid);
    if (owner.start !== undefined && start !== undefined) return start !== owner.start;
  }
  return ageMs > staleMs; // an owner we cannot check is alive while it refreshes its heartbeat
}

function parseOwner(body: string): LockOwner | undefined {
  try {
    const v = JSON.parse(body) as Partial<LockOwner> | null;
    if (typeof v !== "object" || v === null || !Number.isInteger(v.pid) || v.pid! <= 0) return undefined;
    if (typeof v.host !== "string" || typeof v.ns !== "string" || typeof v.boot !== "string")
      return undefined;
    return v as LockOwner;
  } catch {
    return undefined;
  }
}

/** Heartbeat: refresh the mtime while the lock is still ours. */
function touch(file: string, body: string): void {
  try {
    if (fs.readFileSync(file, "utf8") !== body) return;
    const now = new Date();
    fs.utimesSync(file, now, now);
  } catch {
    /* released or reclaimed */
  }
}

/** Removes the lock only if it is still ours (never a lock another process took over). */
function release(file: string, body: string): void {
  if (readText(file) === body) fs.rmSync(file, { force: true });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM"; // exists, owned by another user
  }
}
