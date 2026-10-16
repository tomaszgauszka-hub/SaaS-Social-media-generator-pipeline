import { spawn, spawnSync } from "node:child_process";
import { FatalError, RetryableError } from "@cre/shared";

/**
 * Runs an engine process (Blender, UnrealEditor-Cmd, FFmpeg) WITHOUT a shell: a configured executable and an
 * argument array, so no text can be interpreted as shell syntax. Unlike a plain spawn it
 *   - reports the child pid (resource sampling: RAM / CPU of the whole process tree),
 *   - kills the whole process tree on abort / timeout (Unreal starts ShaderCompileWorker children),
 *   - keeps only the tail of stdout / stderr and hands every stdout line to `onLine` (progress parsing).
 */
export interface EngineProcResult {
  code: number;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  wallMs: number;
  pid: number;
}

export interface EngineProcOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
  maxOutputBytes?: number;
  onLine?: (line: string) => void;
  onSpawn?: (pid: number) => void;
  /** throw on a non-zero exit (default true) */
  check?: boolean;
}

/** Kill a process and its children (process group on POSIX, taskkill /T on Windows). */
export function killTree(pid: number): void {
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    return;
  }
  try {
    process.kill(-pid, "SIGKILL"); // the child leads its own process group (detached)
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

export async function runEngineProcess(
  command: string,
  args: readonly string[],
  opts: EngineProcOptions = {},
): Promise<EngineProcResult> {
  const max = opts.maxOutputBytes ?? 512 * 1024;
  const started = Date.now();
  if (opts.signal?.aborted) throw new RetryableError(`${command} aborted before start`);
  return await new Promise<EngineProcResult>((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    const pid = child.pid ?? -1;
    if (pid > 0) opts.onSpawn?.(pid);
    let stdout = "";
    let stderr = "";
    let lineBuf = "";
    let killedFor: string | null = null;
    const append = (cur: string, chunk: string) =>
      cur.length + chunk.length > max ? (cur + chunk).slice(-max) : cur + chunk;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d: string) => {
      stdout = append(stdout, d);
      if (opts.onLine) {
        lineBuf += d;
        const lines = lineBuf.split(/\r?\n/);
        lineBuf = lines.pop() ?? "";
        for (const l of lines) opts.onLine(l);
      }
    });
    child.stderr.on("data", (d: string) => {
      stderr = append(stderr, d);
    });
    const stop = (why: string) => {
      killedFor = why;
      if (pid > 0) killTree(pid);
    };
    const timer = opts.timeoutMs
      ? setTimeout(() => stop(`timed out after ${opts.timeoutMs} ms`), opts.timeoutMs)
      : null;
    const onAbort = () => stop("aborted");
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    };
    child.on("error", (e) => {
      cleanup();
      reject(new FatalError(`cannot start ${command}: ${e.message}`));
    });
    child.on("close", (code, signal) => {
      cleanup();
      if (lineBuf && opts.onLine) opts.onLine(lineBuf);
      const res: EngineProcResult = {
        code: code ?? -1,
        signal,
        stdout,
        stderr,
        wallMs: Date.now() - started,
        pid,
      };
      if (killedFor) {
        reject(new RetryableError(`${command} ${killedFor}`));
        return;
      }
      if ((opts.check ?? true) && res.code !== 0) {
        const err = new FatalError(
          `${command} exited with ${res.code}${signal ? ` (${signal})` : ""}: ${stderr.slice(-1500) || stdout.slice(-1500)}`,
        );
        (err as FatalError & { result?: EngineProcResult }).result = res;
        reject(err);
        return;
      }
      resolve(res);
    });
  });
}

/** Only what an engine needs — API keys and other secrets of the worker never reach the render process. */
export function engineEnv(
  extra: Record<string, string> = {},
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PYTHONDONTWRITEBYTECODE: "1", PYTHONNOUSERSITE: "1" };
  for (const k of [
    "PATH",
    "HOME",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "SYSTEMROOT",
    "SystemRoot",
    "TEMP",
    "TMP",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "TZ",
    "LD_LIBRARY_PATH",
    "DISPLAY",
    "XDG_RUNTIME_DIR",
  ])
    if (base[k]) env[k] = base[k];
  return { ...env, ...extra };
}
