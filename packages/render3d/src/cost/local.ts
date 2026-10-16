import { z } from "zod";

/*
 * Local production cost. Rendering on owned hardware is not free: it costs energy and wears the machine. Cost of
 * one render = wall-clock hours × (device power × energy price + hardware price / service life) + external
 * services. Every number is a configurable assumption (env RENDER3D_*), reported next to the result so a
 * reader sees what it rests on. LLM tokens are NOT added to renders: production runs saved recipes and scripts.
 */

export const LocalCostAssumptions = z
  .object({
    /** average wall power of the render host while rendering on CPU (W) */
    cpuPowerW: z.number().min(1).max(5000).default(140),
    /** average wall power while rendering on the GPU (W, whole system) */
    gpuPowerW: z.number().min(1).max(5000).default(380),
    /** electricity price (USD per kWh) */
    energyUsdPerKwh: z.number().min(0).max(5).default(0.3),
    /** purchase price of the render host (USD) */
    hardwareUsd: z.number().min(0).max(1_000_000).default(2200),
    /** hours of rendering over the host's service life (3 years × ~8 h/day ≈ 8 760 h) */
    hardwareLifetimeHours: z.number().min(1).default(8760),
    /** any other per-hour cost: rented station, maintenance (USD/h) */
    extraUsdPerHour: z.number().min(0).default(0),
  })
  .strict();
export type LocalCostAssumptions = z.infer<typeof LocalCostAssumptions>;

export interface LocalCost {
  usd: number;
  hours: number;
  energyKwh: number;
  energyUsd: number;
  amortizationUsd: number;
  extraUsd: number;
  externalUsd: number;
  assumptions: LocalCostAssumptions;
  device: "CPU" | "GPU";
}

export function localRenderCost(
  wallMs: number,
  device: "CPU" | "GPU",
  a: LocalCostAssumptions = LocalCostAssumptions.parse({}),
  externalUsd = 0,
): LocalCost {
  const hours = Math.max(0, wallMs) / 3_600_000;
  const watts = device === "GPU" ? a.gpuPowerW : a.cpuPowerW;
  const energyKwh = (hours * watts) / 1000;
  const energyUsd = energyKwh * a.energyUsdPerKwh;
  const amortizationUsd = (hours * a.hardwareUsd) / a.hardwareLifetimeHours;
  const extraUsd = hours * a.extraUsdPerHour;
  const usd = energyUsd + amortizationUsd + extraUsd + externalUsd;
  return {
    usd: round6(usd),
    hours: round6(hours),
    energyKwh: round6(energyKwh),
    energyUsd: round6(energyUsd),
    amortizationUsd: round6(amortizationUsd),
    extraUsd: round6(extraUsd),
    externalUsd: round6(externalUsd),
    assumptions: a,
    device,
  };
}

const round6 = (x: number) => Math.round(x * 1e6) / 1e6;

/** Assumptions from RENDER3D_* environment variables (unset → defaults). */
export function costAssumptionsFromEnv(env: NodeJS.ProcessEnv = process.env): LocalCostAssumptions {
  const num = (k: string) => (env[k] !== undefined && env[k] !== "" ? Number(env[k]) : undefined);
  return LocalCostAssumptions.parse({
    cpuPowerW: num("RENDER3D_CPU_POWER_W"),
    gpuPowerW: num("RENDER3D_GPU_POWER_W"),
    energyUsdPerKwh: num("RENDER3D_ENERGY_USD_PER_KWH"),
    hardwareUsd: num("RENDER3D_HARDWARE_USD"),
    hardwareLifetimeHours: num("RENDER3D_HARDWARE_LIFETIME_HOURS"),
    extraUsdPerHour: num("RENDER3D_EXTRA_USD_PER_HOUR"),
  });
}
