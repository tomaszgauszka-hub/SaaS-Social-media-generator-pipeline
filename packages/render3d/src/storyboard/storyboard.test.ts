import { CreativeBrief, CreativeStoryboard, directCreative, resolveRenderPlan } from "@cre/creative";
import { BENCH_TOOLS } from "@cre/creative/benchmark";
import { fontAssets, FontkitMeasurer } from "@cre/creative/node";
import { describe, expect, it } from "vitest";
import { Asset3D } from "../contracts/asset.ts";
import { Recipe3D } from "../contracts/recipe.ts";
import { DEMO_PRODUCTS } from "../library/products.ts";
import { apply3dClips, midAnchors, nearestAnchor, plan3dRequests, textAwareFraming } from "./storyboard.ts";

const d = DEMO_PRODUCTS["demo-drill-20v"]!;
const drill = Asset3D.parse({
  assetId: "demo-drill-20v",
  assetType: "PRODUCT_MODEL",
  productId: d.productId,
  category: "tools",
  source: "procedural:drill_driver_20v@1",
  license: "own",
  licenseEvidence: "repo",
  isSynthetic: true,
  isDemoOnly: true,
  isProductVerified: false,
  fidelity: "FICTIONAL_DEMO",
  structureVerified: true,
  engine: "blender",
  generator: { name: d.generator, version: 1, params: {} },
  version: 1,
  createdAt: "2026-10-16T00:00:00Z",
  parts: d.parts.map((p) => ({ name: p.name, role: p.role, verified: true, internal: p.internal ?? false })),
});
const { storyboard: sb, localePack } = directCreative(CreativeBrief.parse(BENCH_TOOLS));

const clipFor = (beatId: string, materialType: Asset3D["materialType"]) =>
  Asset3D.parse({
    ...drill,
    assetId: `clip-${beatId}`,
    assetType: "RENDER_CLIP",
    source: `render:${beatId}`,
    recipeHash: `h-${beatId}`,
    materialType,
    resolution: [540, 960],
    fps: 30,
    durationMs: 3000,
  });

describe("storyboard ⇄ 3D clips", () => {
  const requests = plan3dRequests(sb, drill, {
    only: ["HOOK_VISUAL", "PRODUCT_HERO", "PRODUCT_MACRO", "PRODUCT_IN_USE", "CTA_CARD"],
    environment: "workshop",
  });

  it("asks for a clip per mapped beat with a valid, language-free recipe", () => {
    expect(requests.map((r) => [r.beatId, r.materialType])).toEqual([
      ["s01", "3D_PRODUCT_HERO"],
      ["s02", "3D_PRODUCT_HERO"],
      ["s03", "3D_MACRO"],
      ["s05", "3D_MACRO"],
      ["s06", "3D_LIFESTYLE"],
      ["s08", "3D_TURNTABLE"],
    ]);
    for (const r of requests) {
      const recipe = Recipe3D.parse(r.recipe);
      expect(JSON.stringify(recipe)).not.toMatch(/drill\*|Every spec|price|link/i);
    }
  });

  it("macro beats focus the part their 2D media focused (chuck, clutch); lifestyle uses the workshop", () => {
    const byBeat = Object.fromEntries(requests.map((r) => [r.beatId, Recipe3D.parse(r.recipe)]));
    expect(byBeat.s03!.focus).toBe("chuck");
    expect(byBeat.s05!.focus).toBe("clutch");
    expect(byBeat.s06!.environment?.preset).toBe("workshop");
  });

  it("keeps the product clear of the beat's text and panels", () => {
    const hook = sb.beats.find((b) => b.id === "s01")!; // headline at the top
    expect(textAwareFraming(hook, 0.6).centerY).toBeGreaterThan(0.6);
    const cta = sb.beats.find((b) => b.id === "s08")!; // panel over the lower half
    const f = textAwareFraming(cta, 0.58);
    expect(f.centerY).toBeLessThan(0.45);
    expect(f.fill).toBeLessThan(0.45);
  });

  it("never asks a model without a verified structure for an exploded view", () => {
    const flat = Asset3D.parse({ ...drill, structureVerified: false, fidelity: "FICTIONAL_DEMO" });
    const spec = plan3dRequests(sb, flat, { only: ["SPEC_CALLOUT"] });
    expect(spec[0]?.materialType).toBe("3D_TURNTABLE");
  });

  it("swaps the media, keeps every text slot and still resolves in another locale", () => {
    const placed = requests.map((r) => ({
      beatId: r.beatId,
      asset: clipFor(r.beatId, r.materialType),
      src: `clip-${r.beatId}.mp4`,
      anchors: { chuck: { x: 0.3, y: 0.4 } },
    }));
    const sb3 = apply3dClips(sb, placed);
    expect(CreativeStoryboard.safeParse(sb3).success).toBe(true);
    expect(Object.keys(sb3.textSlots)).toEqual(Object.keys(sb.textSlots));
    expect(sb3.flags.demoOnly).toBe(true);
    const s03 = sb3.beats.find((b) => b.id === "s03")!;
    expect(s03.media[0]).toMatchObject({ assetId: "clip-s03", slot: "primary", crop: "cover" });
    expect(s03.overlays.some((o) => o.kind === "highlight")).toBe(false); // drawn for the 2D drawing
    const cta = sb3.beats.find((b) => b.id === "s08")!;
    expect(cta.overlays.map((o) => o.kind)).toEqual(["panel", "badge"]); // CTA card kept
    const ref = sb3.media.find((m) => m.id === "clip-s03")!;
    expect(ref.render3d).toMatchObject({ materialType: "3D_MACRO", fidelity: "FICTIONAL_DEMO" });
    expect(ref.demoOnly).toBe(true);
    // the 2D beats keep their vector drawing
    expect(sb3.beats.find((b) => b.id === "s04")!.media[0]!.assetId).toBe("drill");
    const { assets } = fontAssets(sb3.style);
    const pl = {
      locale: "pl-PL",
      strings: { ...localePack.strings, "s01.hook": "Każdy parametr tej *wiertarki 20V*" },
    };
    const { plan, issues } = resolveRenderPlan(sb3, pl, new FontkitMeasurer(), {
      fonts: assets,
      storyboardHash: "x",
      mediaUrls: { "clip-s03": "http://127.0.0.1:1/clip-s03.mp4" },
    });
    expect(plan.locale).toBe("pl-PL");
    expect(plan.media["clip-s03"]?.url).toBe("http://127.0.0.1:1/clip-s03.mp4");
    expect(issues.filter((i) => i.severity === "blocker")).toEqual([]);
  });

  it("maps a callout to the nearest anchor of the old media", () => {
    const ref = { anchors: { chuck: { x: 0.25, y: 0.18 }, battery: { x: 0.7, y: 0.9 } } };
    expect(nearestAnchor(ref, { x: 0, y: 0, w: 800, h: 720 }, { x: 205, y: 135 })).toBe("chuck");
    expect(nearestAnchor(ref, { x: 0, y: 0, w: 800, h: 720 }, { x: 420, y: 420 })).toBeNull();
    expect(midAnchors({ chuck: [[0.1, 0.1], [0.3, 0.4], null] })).toEqual({ chuck: { x: 0.3, y: 0.4 } });
  });
});
