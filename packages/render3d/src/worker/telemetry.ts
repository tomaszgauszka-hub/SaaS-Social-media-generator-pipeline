import fs from "node:fs";
import os from "node:os";
import { sampleGpu } from "../engines/gpu.ts";

/*
 * Resource sampling of a running engine process tree: peak RSS and average CPU (Linux /proc; other platforms
 * report null instead of a guess) and, with an NVIDIA GPU, peak VRAM and average utilisation (nvidia-smi).
 */

const TICK = 100; // USER_HZ on Linux

interface ProcStat {
  ppid: number;
  cpuTicks: number;
  rssPages: number;
}

function readStat(pid: number): ProcStat | null {
  try {
    const s = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const rest = s.slice(s.lastIndexOf(")") + 2).split(" ");
    // fields after the comm: state(0) ppid(1) … utime(11) stime(12) … rss(21)
    return {
      ppid: Number(rest[1]),
      cpuTicks: Number(rest[11]) + Number(rest[12]),
      rssPages: Number(rest[21]),
    };
  } catch {
    return null;
  }
}

/** pid and all its descendants (from /proc). */
export function processTree(root: number): number[] {
  if (!fs.existsSync("/proc")) return [root];
  const children = new Map<number, number[]>();
  for (const d of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(d)) continue;
    const st = readStat(Number(d));
    if (!st) continue;
    const list = children.get(st.ppid) ?? [];
    list.push(Number(d));
    children.set(st.ppid, list);
  }
  const out: number[] = [];
  const stack = [root];
  while (stack.length) {
    const p = stack.pop()!;
    out.push(p);
    for (const c of children.get(p) ?? []) stack.push(c);
  }
  return out;
}

export interface ResourceSummary {
  peakRamMb: number | null;
  cpuUsagePct: number | null;
  peakVramMb: number | null;
  gpuUsagePct: number | null;
}

export class ResourceSampler {
  private timer: NodeJS.Timeout | null = null;
  private pid = -1;
  private peakRss = 0;
  private firstCpu: { ticks: number; at: number } | null = null;
  private lastCpu: { ticks: number; at: number } | null = null;
  private readonly cpuTicks = new Map<number, number>();
  private gpuPeak = 0;
  private gpuUtil: number[] = [];
  private tickN = 0;
  private readonly page = 4096;

  constructor(
    private readonly intervalMs = 1000,
    private readonly gpu = false,
  ) {}

  start(pid: number): void {
    this.pid = pid;
    this.sample();
    this.timer = setInterval(() => this.sample(), this.intervalMs);
    this.timer.unref();
  }

  private sample(): void {
    if (this.pid <= 0) return;
    this.tickN++;
    if (fs.existsSync("/proc")) {
      let rss = 0;
      for (const p of processTree(this.pid)) {
        const st = readStat(p);
        if (!st) continue;
        rss += st.rssPages * this.page;
        this.cpuTicks.set(p, Math.max(this.cpuTicks.get(p) ?? 0, st.cpuTicks));
      }
      this.peakRss = Math.max(this.peakRss, rss);
      let total = 0;
      for (const v of this.cpuTicks.values()) total += v;
      const now = { ticks: total, at: Date.now() };
      this.firstCpu ??= now;
      this.lastCpu = now;
    }
    if (this.gpu && this.tickN % 2 === 1) {
      const g = sampleGpu();
      if (g) {
        this.gpuPeak = Math.max(this.gpuPeak, g.memUsedMb);
        this.gpuUtil.push(g.utilPct);
      }
    }
  }

  stop(): ResourceSummary {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const hasProc = this.firstCpu !== null && this.lastCpu !== null;
    const wallS = hasProc ? Math.max(0.001, (this.lastCpu!.at - this.firstCpu!.at) / 1000) : 0;
    const cpu =
      hasProc && wallS > 0.5
        ? (((this.lastCpu!.ticks - this.firstCpu!.ticks) / TICK / wallS) * 100) / os.availableParallelism()
        : null;
    return {
      peakRamMb: this.peakRss > 0 ? Math.round(this.peakRss / 1048576) : null,
      cpuUsagePct: cpu !== null ? Math.round(cpu * 10) / 10 : null,
      peakVramMb: this.gpuUtil.length ? this.gpuPeak : null,
      gpuUsagePct: this.gpuUtil.length
        ? Math.round((this.gpuUtil.reduce((a, b) => a + b, 0) / this.gpuUtil.length) * 10) / 10
        : null,
    };
  }
}
