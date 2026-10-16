import { Recipe3D } from "@cre/render3d/contracts";
import { describe, expect, it } from "vitest";
import { recipeFieldErrors, recipeInputFromForm, renderJobId } from "./render3d";
import { durationLabel, fidelityBadge, localCostLabel, templateLabel } from "./render3d-labels";

const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};

const VALID = {
  productAssetId: "demo-drill-20v",
  engine: "AUTO",
  template: "PRODUCT_HERO",
  camera: "orbit_closeup",
  movement: "slow",
  lighting: "premium_studio",
  background: "dark_gradient",
  durationSec: "4",
};

describe("3D studio form → Recipe3D", () => {
  it("builds a valid recipe (empty environment / focus are left out)", () => {
    const r = Recipe3D.parse(recipeInputFromForm(form({ ...VALID, environment: "", focus: "" }), "preview"));
    expect(r).toMatchObject({ template: "PRODUCT_HERO", durationSec: 4, quality: "preview", seed: 1 });
    expect(r.environment).toBeUndefined();
    expect(r.focus).toBeUndefined();
  });

  it("maps validation issues onto form fields", () => {
    const lifestyle = Recipe3D.safeParse(
      recipeInputFromForm(form({ ...VALID, template: "LIFESTYLE" }), "preview"),
    );
    expect(lifestyle.success).toBe(false);
    expect(recipeFieldErrors(lifestyle.error!)).toHaveProperty("environment");

    const bad = Recipe3D.safeParse(
      recipeInputFromForm(form({ ...VALID, durationSec: "99", camera: "drone" }), "preview"),
    );
    expect(Object.keys(recipeFieldErrors(bad.error!)).sort()).toEqual(["camera", "durationSec"]);

    const unreal = Recipe3D.safeParse(
      recipeInputFromForm(form({ ...VALID, engine: "BLENDER", template: "UE_LUXURY_STUDIO" }), "preview"),
    );
    expect(recipeFieldErrors(unreal.error!)).toHaveProperty("template");
  });

  it("derives a deterministic job id per workspace + full recipe (double submit enqueues once)", () => {
    const preview = Recipe3D.parse(recipeInputFromForm(form(VALID), "preview"));
    const again = Recipe3D.parse(recipeInputFromForm(form({ ...VALID, durationSec: "4.0" }), "preview"));
    const production = Recipe3D.parse({ ...preview, quality: "production" });
    const reseeded = Recipe3D.parse({ ...preview, seed: 2 });
    const id = renderJobId("ws1", preview);
    expect(id).toMatch(/^r3d-[0-9a-f]{32}$/);
    expect(renderJobId("ws1", again)).toBe(id);
    expect(renderJobId("ws1", production)).not.toBe(id);
    expect(renderJobId("ws1", reseeded)).not.toBe(id);
    expect(renderJobId("ws2", preview)).not.toBe(id);
  });
});

describe("3D studio labels", () => {
  it("flags demo and approximate models", () => {
    expect(fidelityBadge("FICTIONAL_DEMO", true).label).toBe("DEMO_ONLY");
    expect(fidelityBadge("VERIFIED_MANUFACTURER", true).label).toBe("DEMO_ONLY");
    expect(fidelityBadge("APPROXIMATE_VISUALIZATION", false)).toMatchObject({
      label: "approximate visualisation",
      tone: "amber",
    });
  });

  it("formats templates, durations and local cost", () => {
    expect(templateLabel("UE_LUXURY_STUDIO")).toBe("UE5 · Luxury studio");
    expect(templateLabel("TURNTABLE_360")).toBe("Turntable 360");
    expect(durationLabel(8_400)).toBe("8.4 s");
    expect(durationLabel(72_000)).toBe("1 min 12 s");
    expect(localCostLabel(0.0031)).toBe("$0.0031");
  });
});
