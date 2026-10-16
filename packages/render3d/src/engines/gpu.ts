import { spawnSync } from "node:child_process";
import type { GpuInfo } from "../contracts/engine.ts";

/**
 * GPU discovery and sampling through nvidia-smi (NVIDIA only — the common render-station GPU). Other vendors are
 * reported as "no GPU telemetry" rather than guessed; Blender still probes its own backends (HIP, METAL, ONEAPI).
 */

let cached: GpuInfo | undefined;

export function parseNvidiaSmi(csv: string): GpuInfo {
  const line = csv.split(/\r?\n/).find((l) => l.trim().length > 0);
  if (!line) return { available: false, name: null, vramMb: null };
  const [name, mem] = line.split(",").map((s) => s.trim());
  const vram = Number.parseFloat((mem ?? "").replace(/[^0-9.]/g, ""));
  return { available: Boolean(name), name: name ?? null, vramMb: Number.isFinite(vram) ? vram : null };
}

export function detectGpu(force = false): GpuInfo {
  if (cached && !force) return cached;
  const r = spawnSync("nvidia-smi", ["--query-gpu=name,memory.total", "--format=csv,noheader,nounits"], {
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
  });
  cached = r.status === 0 ? parseNvidiaSmi(r.stdout) : { available: false, name: null, vramMb: null };
  return cached;
}

export interface GpuSample {
  utilPct: number;
  memUsedMb: number;
}

export function parseGpuSample(csv: string): GpuSample | null {
  const line = csv.split(/\r?\n/).find((l) => l.trim().length > 0);
  if (!line) return null;
  const [u, mem] = line.split(",").map((s) => Number.parseFloat(s.trim()));
  if (!Number.isFinite(u) || !Number.isFinite(mem)) return null;
  return { utilPct: u!, memUsedMb: mem! };
}

export function sampleGpu(): GpuSample | null {
  const r = spawnSync(
    "nvidia-smi",
    ["--query-gpu=utilization.gpu,memory.used", "--format=csv,noheader,nounits"],
    {
      encoding: "utf8",
      timeout: 5_000,
      windowsHide: true,
    },
  );
  return r.status === 0 ? parseGpuSample(r.stdout) : null;
}
