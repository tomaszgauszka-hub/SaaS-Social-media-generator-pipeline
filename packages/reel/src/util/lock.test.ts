import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RetryableError } from "@cre/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withResourceLock } from "./lock.ts";

const linux = fs.existsSync("/proc/self/stat");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("withResourceLock", () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "lock-"));
    file = path.join(dir, "blender.0.lock");
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const take = (
    fn: () => Promise<unknown> = () => Promise.resolve("ran"),
    timeoutMs = 400,
    staleMs?: number,
  ) =>
    withResourceLock(dir, "blender", 1, fn, {
      pollMs: 20,
      timeoutMs,
      ...(staleMs !== undefined ? { staleMs } : {}),
    });
  /** the lock body this process writes (read while holding the lock) */
  const ownBody = async () =>
    JSON.parse(String(await take(() => Promise.resolve(fs.readFileSync(file, "utf8"))))) as Record<
      string,
      unknown
    >;
  const age = (ms: number) => {
    const t = new Date(Date.now() - ms);
    fs.utimesSync(file, t, t);
  };

  it("serialises holders of one slot and lets two run with two slots", async () => {
    for (const slots of [1, 2]) {
      let running = 0;
      let peak = 0;
      const job = () =>
        withResourceLock(
          dir,
          `r${slots}`,
          slots,
          async () => {
            peak = Math.max(peak, ++running);
            await sleep(40);
            running--;
          },
          { pollMs: 5 },
        );
      await Promise.all([job(), job(), job(), job()]);
      expect(peak).toBe(slots);
    }
    expect(fs.readdirSync(dir)).toEqual([]); // released, no temp files left
  });

  it("respects a live owner and times out retryably", async () => {
    const me = await ownBody();
    fs.writeFileSync(file, JSON.stringify({ ...me, nonce: "other" }));
    await expect(take()).rejects.toBeInstanceOf(RetryableError);
    expect(fs.existsSync(file)).toBe(true);
  });

  it("reclaims the lock of a dead process at once", async () => {
    const me = await ownBody();
    fs.writeFileSync(file, JSON.stringify({ ...me, pid: 99_999_999, nonce: "dead" }));
    await expect(take()).resolves.toBe("ran");
    expect(fs.existsSync(file)).toBe(false);
  });

  it.runIf(linux)(
    "reclaims a lock whose PID now belongs to another process (restart with the same PID)",
    async () => {
      const me = await ownBody();
      expect(me.start).toMatch(/^\d+$/);
      fs.writeFileSync(file, JSON.stringify({ ...me, start: "1", nonce: "previous-incarnation" }));
      await expect(take()).resolves.toBe("ran");
    },
  );

  it("treats an empty or garbled lock as stale only after a grace period", async () => {
    for (const body of ["", "4242", "{not json"]) {
      fs.writeFileSync(file, body);
      await expect(take(undefined, 120)).rejects.toThrow(/timed out/);
      age(10_000);
      await expect(take()).resolves.toBe("ran");
    }
  });

  it("trusts another host's lock while its heartbeat is fresh", async () => {
    const me = await ownBody();
    fs.writeFileSync(file, JSON.stringify({ ...me, host: "other-host", nonce: "x" }));
    await expect(take(undefined, 150, 1000)).rejects.toThrow(/timed out/);
    age(2000);
    await expect(take(undefined, 150, 1000)).resolves.toBe("ran");
  });

  it("refreshes its heartbeat while held and never removes a lock it no longer owns", async () => {
    let first = 0;
    let later = 0;
    await take(
      async () => {
        first = fs.statSync(file).mtimeMs;
        await sleep(150);
        later = fs.statSync(file).mtimeMs;
      },
      400,
      100,
    );
    expect(later).toBeGreaterThan(first);
    await take(() => {
      fs.writeFileSync(file, '{"pid":1,"host":"x","ns":"","boot":"","nonce":"taken-over"}');
      return Promise.resolve();
    });
    expect(fs.readFileSync(file, "utf8")).toContain("taken-over");
  });
});
