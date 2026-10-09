import { spawn } from "node:child_process";
import { FatalError, RetryableError } from "@cre/shared";

/**
 * Runs a local binary (Blender, Piper, FFprobe helpers …) WITHOUT a shell: the command is a configured path and
 * every argument is a separate array element, so no text — least of all model output — can be interpreted as
 * shell syntax. stdout/stderr are captured (tail-limited), the process is killed on abort / timeout.
 */
export interface ProcResult {
  code: number;
  stdout: string;
  stderr: string;
  wallMs: number;
}

export async function runProcess(
  command: string,
  args: readonly string[],
  opts: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    input?: string | Buffer;
    timeoutMs?: number;
    signal?: AbortSignal;
    /** keep at most this many bytes of stdout/stderr */
    maxOutputBytes?: number;
    /** throw on non-zero exit (default true) */
    check?: boolean;
    /** called with each stdout line (progress parsing) */
    onLine?: (line: string) => void;
  } = {},
): Promise<ProcResult> {
  const max = opts.maxOutputBytes ?? 256 * 1024;
  const started = Date.now();
  return await new Promise<ProcResult>((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    let lineBuf = "";
    const append = (cur: string, chunk: string) =>
      cur.length + chunk.length > max ? (cur + chunk).slice(-max) : cur + chunk;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d: string) => {
      stdout = append(stdout, d);
      if (opts.onLine) {
        lineBuf += d;
        const lines = lineBuf.split("\n");
        lineBuf = lines.pop() ?? "";
        for (const l of lines) opts.onLine(l);
      }
    });
    child.stderr.on("data", (d: string) => {
      stderr = append(stderr, d);
    });
    let timer: NodeJS.Timeout | undefined;
    const kill = (why: string) => {
      child.kill("SIGKILL");
      reject(new RetryableError(`${command} ${why}`));
    };
    if (opts.timeoutMs)
      timer = setTimeout(() => kill(`timed out after ${opts.timeoutMs} ms`), opts.timeoutMs);
    const onAbort = () => kill("aborted");
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", (e) => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      reject(new FatalError(`cannot start ${command}: ${e.message}`));
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      const res = { code: code ?? -1, stdout, stderr, wallMs: Date.now() - started };
      if ((opts.check ?? true) && res.code !== 0) {
        reject(
          new FatalError(`${command} exited with ${res.code}: ${stderr.slice(-1200) || stdout.slice(-1200)}`),
        );
        return;
      }
      resolve(res);
    });
    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}
