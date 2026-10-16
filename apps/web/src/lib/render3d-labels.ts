/**
 * Display labels for the 3D studio (pure, no imports — shared by the server page and client components).
 * Values are the closed sets of packages/render3d (Recipe3D / Asset3D); unknown values fall back to a readable
 * form of the raw value.
 */

export const humanize = (v: string) =>
  v
    .toLowerCase()
    .replace(/_/g, " ")
    .replace(/^\w/, (c) => c.toUpperCase());

export function templateLabel(t: string | null | undefined): string {
  if (!t) return "—";
  return t.startsWith("UE_") ? `UE5 · ${humanize(t.slice(3))}` : humanize(t);
}

export function materialLabel(m: string | null | undefined): string {
  if (!m) return "—";
  return m === "3D_CINEMATIC" ? "Cinematic (UE5)" : humanize(m.replace(/^3D_/, ""));
}

export const ENGINE_MODE_LABEL: Record<string, string> = {
  AUTO: "Auto (router decides)",
  BLENDER: "Blender",
  UNREAL: "Unreal Engine 5",
  "2D_ONLY": "2D only (no 3D render)",
  EXISTING_ASSET: "Existing asset only",
};

/** Route decision engines (packages/render3d/src/routing/router.ts RouteEngine). */
export const ROUTE_ENGINE_LABEL: Record<string, string> = {
  EXISTING_ASSET: "Existing clip (library)",
  BLENDER: "Blender",
  UNREAL: "Unreal Engine 5",
  PROGRAMMATIC_2D: "2D pipeline (no 3D)",
  EXTERNAL_AI: "External AI",
  DEFER: "Queued — waits for the render station",
  BLOCKED: "Blocked by policy",
};

export type BadgeTone = "gray" | "blue" | "indigo" | "green" | "amber" | "red" | "violet";

/** How faithfully the model shows the real product (Asset3D.fidelity). */
export function fidelityBadge(
  fidelity: string,
  isDemoOnly: boolean,
): { label: string; tone: BadgeTone; title: string } {
  if (fidelity === "FICTIONAL_DEMO" || isDemoOnly)
    return {
      label: "DEMO_ONLY",
      tone: "red",
      title: "Fictional demo product — for development and demos only, never published",
    };
  switch (fidelity) {
    case "VERIFIED_MANUFACTURER":
      return { label: "verified model", tone: "green", title: "Model delivered by the manufacturer / brand" };
    case "TECHNICAL_RECONSTRUCTION":
      return {
        label: "technical reconstruction",
        tone: "blue",
        title: "Built from sufficient technical data (catalogue model, drawings, measurements)",
      };
    case "APPROXIMATE_VISUALIZATION":
      return {
        label: "approximate visualisation",
        tone: "amber",
        title: "Illustrative only — must not suggest unconfirmed properties, parts or features",
      };
    default:
      return { label: humanize(fidelity), tone: "gray", title: fidelity };
  }
}

export const APPROVAL_LABEL: Record<string, { label: string; tone: BadgeTone }> = {
  PENDING: { label: "awaiting approval", tone: "amber" },
  APPROVED: { label: "approved", tone: "green" },
  REJECTED: { label: "rejected", tone: "red" },
};

/** "1 min 12 s" / "8.4 s" */
export function durationLabel(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "—";
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
  const min = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  if (min < 60) return s ? `${min} min ${s} s` : `${min} min`;
  const h = Math.floor(min / 60);
  return `${h} h ${min % 60} min`;
}

/** Local render cost (USD, small amounts): "$0.0031" */
export function localCostLabel(usd: number | null | undefined): string {
  if (usd === null || usd === undefined || !Number.isFinite(usd)) return "—";
  return `$${usd.toFixed(usd < 0.01 ? 4 : usd < 1 ? 3 : 2)}`;
}
