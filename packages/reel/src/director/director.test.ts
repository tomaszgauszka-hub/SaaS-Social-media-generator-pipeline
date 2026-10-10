import fs from "node:fs";
import { resolveFromRoot } from "@cre/config";
import type { GoogleAI } from "@cre/providers";
import { beforeAll, describe, expect, it } from "vitest";
import { DeterministicProductAnalyzer } from "../analysis/deterministic.ts";
import type { CallContext, DirectorInput } from "../capabilities/types.ts";
import { validateCopy, quantities, sameQuantity } from "../claims/validate.ts";
import { ReelJob } from "../contracts/job.ts";
import type { LocaleCopy } from "../contracts/plan.ts";
import type { ProductProfile, ProductSource } from "../contracts/product.ts";
import { PLATFORM_PROFILES, TIER_PROFILES, type BrandProfile } from "../contracts/profiles.ts";
import { CostTracker } from "../cost/tracker.ts";
import { loadBrandProfile } from "../factory/profiles.ts";
import { ingestAboProduct } from "../ingest/abo.ts";
import { TemplateTranscreation } from "../localize/template.ts";
import { compilePlan, snapBoundaries, techniqueFor } from "./compile.ts";
import { GeminiDirector, decisionProblems } from "./gemini.ts";
import { applicableHooks, chooseHook } from "./hooks.ts";
import { detectConcepts } from "./lexicon.ts";
import { TemplateDirector, templateDecision } from "./template.ts";

const LAMP = resolveFromRoot(".data/products/abo/B075X2FZSM");
const hasLamp = fs.existsSync(`${LAMP}/listing.json`);
const ctx = (): CallContext => ({
  workDir: "/tmp",
  cacheDir: "/tmp",
  scope: "test",
  tracker: new CostTracker(),
});
const platform = PLATFORM_PROFILES.tiktok;

function directorInput(
  source: ProductSource,
  profile: ProductProfile,
  brand: BrandProfile,
  locale = "pl-PL",
): DirectorInput {
  return {
    product: profile,
    facts: source.facts.map((f) => ({ id: f.id, kind: f.kind, text: f.text })),
    brand: {
      brandName: brand.brandName,
      visualStyle: brand.visualStyle,
      musicStyle: brand.musicStyle,
      forbiddenPhrases: brand.forbiddenPhrases,
      preferredCTA: brand.preferredCTA,
      voicePersona: brand.voicePersona,
    },
    platform: {
      id: platform.id,
      durationMs: platform.durationMs,
      avgShotMs: platform.avgShotMs,
      maxOverlayWords: platform.maxOverlayWords,
    },
    locale,
    market: locale.slice(3),
    targetDurationS: 12,
    objective: "conversion",
    options: {
      shotPresets: [],
      hookStrategies: [],
      environments: [],
      sfxKinds: [],
      musicGenres: [],
      musicMoods: [],
    },
    assets: [],
    history: [],
  };
}

describe.skipIf(!hasLamp)("director on the real lamp (ABO B075X2FZSM)", () => {
  let source: ProductSource;
  let profile: ProductProfile;
  let brand: BrandProfile;
  beforeAll(async () => {
    source = await ingestAboProduct(LAMP);
    profile = await new DeterministicProductAnalyzer().analyze(source, ctx());
    brand = loadBrandProfile("assets/brands/homely-finds/brand.json");
  });

  it("ingests traceable facts incl. derived metric dimensions", () => {
    const h = source.facts.find((f) => f.id === "dim.height.cm")!;
    expect(h).toMatchObject({ value: 55.1, unit: "cm", source: "derived:dim.height" });
    expect(source.facts.some((f) => f.id === "bp.de-DE.4" && f.kind === "included")).toBe(true);
    expect(source.model3d?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(profile).toMatchObject({ category: "lighting", shortName: "Rivet Table Lamp" });
    expect(profile.traits).toMatchObject({ emitsLight: true, hasScreen: false });
    expect(profile.palette.length).toBeGreaterThan(1);
  });

  it("excludes hooks the facts cannot support", () => {
    const concepts = detectConcepts(source.facts, "lighting");
    const hc = { category: "lighting" as const, profile, facts: source.facts, concepts };
    const ok = applicableHooks(hc);
    expect(ok).not.toContain("price_hook");
    expect(ok).not.toContain("social_proof");
    expect(ok).not.toContain("speed_demo");
    expect(ok).toContain("before_after");
    expect(chooseHook(hc)).toBe("visual_surprise");
    expect(chooseHook(hc, { forced: "price_hook" })).toBe("visual_surprise");
    expect(chooseHook(hc, { history: [{ hookStrategy: "question", score: 9, n: 4 }] })).toBe("question");
  });

  it("compiles a contiguous, beat-snapped 12 s plan with a CTA ≥ platform minimum (deterministic)", async () => {
    const { decision } = await new TemplateDirector().direct(directorInput(source, profile, brand), ctx());
    const job = ReelJob.parse({
      jobId: "t",
      productId: source.id,
      brandId: brand.brandId,
      locales: [{ locale: "pl-PL", market: "PL" }],
    });
    const args = {
      decision,
      job,
      source,
      profile,
      brand,
      platform,
      tier: TIER_PROFILES.ECONOMY,
      locale: "pl-PL",
      market: "PL",
      variantKey: "A",
      director: { provider: "template", model: "t", promptVersion: "1", fallbackUsed: false },
      providers: {},
      fallbacks: {},
      configVersion: "test",
    };
    const plan = compilePlan(args);
    expect(JSON.stringify(compilePlan(args))).toBe(JSON.stringify(plan));
    expect(plan.durationMs).toBe(12_000);
    let t = 0;
    for (const s of plan.shots) {
      expect(s.startMs).toBe(t);
      expect(s.durationMs).toBeGreaterThanOrEqual(900);
      t += s.durationMs;
    }
    expect(t).toBe(12_000);
    expect(plan.shots[0]).toMatchObject({ role: "HOOK", technique: "relight", productAnimation: "light_on" });
    // the switch click lands on the first frame of the relight crossfade (round(0.3·N) of the shot's N frames),
    // not on the shot midpoint
    const hookFrames = Math.round((plan.shots[0]!.durationMs * plan.fps) / 1000);
    expect(plan.sfx.find((c) => c.kind === "light_switch")?.atMs).toBe(
      Math.round((Math.round(0.3 * hookFrames) * 1000) / plan.fps),
    );
    // a product without a light of its own never gets the off / on plates (they would be identical)
    const unlit = compilePlan({
      ...args,
      profile: { ...profile, traits: { ...profile.traits, emitsLight: false } },
    });
    expect(unlit.shots.some((s) => s.technique === "relight")).toBe(false);
    expect(plan.cta.endMs - plan.cta.startMs).toBeGreaterThanOrEqual(platform.cta.minMs);
    expect(
      plan.voiceover.segments.every((v, i, a) => v.atMs < 12_000 && (i === 0 || v.atMs > a[i - 1]!.atMs)),
    ).toBe(true);
    const ev = plan.music.intent.events;
    expect(ev.every((e, i) => i === 0 || e.timeMs >= ev[i - 1]!.timeMs)).toBe(true);
    expect(ev.find((e) => e.event === "final_hit")?.timeMs).toBe(plan.shots[plan.shots.length - 1]!.startMs);
    expect(validateCopy(plan.copy, source, brand, profile)).toEqual([]);

    // native PL / EN / DE copy from the same concepts and facts
    const copies = await new TemplateTranscreation().transcreate(
      {
        master: plan.copy,
        targets: [
          { locale: "en-US", market: "US" },
          { locale: "de-DE", market: "DE" },
        ],
        product: profile,
        productNames: source.names,
        facts: source.facts.map((f) => ({ id: f.id, kind: f.kind, text: f.text })),
        sourceFacts: source.facts,
        brand,
        limits: {},
        hookStrategy: plan.metadata.hookStrategy,
      },
      ctx(),
    );
    const all: LocaleCopy[] = [plan.copy, ...copies];
    const texts = all.map((c) => Object.fromEntries(Object.entries(c.slots).map(([k, v]) => [k, v.text])));
    expect(texts[0]!["voice.2.materials_walnut_brass_fabric"]).toBe(
      "Orzechowa podstawa, mosiężny trzon i abażur z tkaniny.",
    );
    expect(texts[2]!["voice.2.materials_walnut_brass_fabric"]).toBe(
      "Sockel aus Walnuss, Stange aus Messing, Schirm aus Stoff.",
    );
    expect(texts[2]!.disclosure).toBe("Werbung · Affiliate-Link");
    expect(Object.keys(texts[1]!)).toEqual(Object.keys(texts[0]!));
    for (const c of all) {
      expect(validateCopy(c, source, brand, profile)).toEqual([]);
      for (const s of Object.values(c.slots))
        expect(s.text.length).toBeLessThanOrEqual(s.kind === "voice" ? 140 : 60);
    }
    // the German copy cites the German facts
    expect(copies[1]!.slots["overlay.sh04.led_bulb_included"]!.factIds[0]).toBe("bp.de-DE.4");
  });

  it("rejects invented claims, wrong numbers, prices, forbidden phrases and risky features", () => {
    const copy = (text: string, factIds: string[] = [], kind: "voice" | "overlay" = "voice"): LocaleCopy => ({
      locale: "pl-PL",
      market: "PL",
      slots: { s: { kind, text, factIds } },
      transcreation: { provider: "t", model: "t", sourceLocale: "pl-PL", isMaster: true },
    });
    const codes = (c: LocaleCopy) =>
      validateCopy(c, source, { forbiddenPhrases: ["gwarancja satysfakcji"] }, profile).map((i) => i.code);
    expect(codes(copy("Wysokość 55 cm", ["dim.height.cm"]))).toEqual([]);
    expect(codes(copy("Wysokość 21.7 in", ["dim.height"]))).toEqual([]);
    expect(codes(copy("Wysokość 80 cm", ["dim.height.cm"]))).toContain("invented_number");
    expect(codes(copy("Teraz tylko 199 zł"))).toContain("unsupported_price");
    expect(codes(copy("-30% tylko dziś"))).toContain("unsupported_price");
    expect(codes(copy("Lampa ze ściemniaczem, ściemnialna"))).toContain("unsupported_feature");
    expect(codes(copy("Najlepsza lampa na rynku"))).toContain("absolute_claim");
    expect(codes(copy("2 lata gwarancji"))).toContain("unsupported_warranty");
    expect(codes(copy("Ocena 4.8/5 od klientów"))).toContain("unsupported_reviews");
    expect(codes(copy("Pełna gwarancja satysfakcji"))).toContain("forbidden_phrase");
    expect(codes(copy("Czerwony abażur"))).toContain("color_mismatch");
    expect(codes(copy("Lampa", ["nope"]))).toContain("unknown_fact");
  });

  it("converts units when matching numbers", () => {
    const [cm] = quantities("55 cm");
    const [inch] = quantities('21.7"');
    expect(sameQuantity(cm!, inch!)).toBe(true);
    expect(sameQuantity(quantities("36 cm")[0]!, quantities("14.3 in")[0]!)).toBe(true);
    expect(sameQuantity(quantities("40 cm")[0]!, quantities("14.3 in")[0]!)).toBe(false);
  });

  it("Gemini director: schema-validated decision, unknown fact ids trigger one repair round", async () => {
    const good = templateDecision(directorInput(source, profile, brand));
    const bad = { ...good, hook: { ...good.hook, factIds: ["invented.1"] } };
    const answers = [bad, good];
    let calls = 0;
    const ai = {
      hasApiKey: true,
      hasCloudToken: false,
      estimateGenerateMicros: (_m: string, i: number, o: number) => Math.round(i * 0.3 + o * 2.5),
      generate: (req: { parts: unknown[] }) => {
        calls++;
        if (calls === 2) expect(JSON.stringify(req.parts)).toContain("unknown fact ids invented.1");
        return Promise.resolve({
          text: "",
          json: answers[calls - 1],
          usage: { inputTokens: 2000, outputTokens: 700, thoughtsTokens: 0, cachedTokens: 0 },
          model: "gemini-test",
          latencyMs: 900,
          costMicros: 2350,
        });
      },
    } as unknown as GoogleAI;
    const c = ctx();
    const d = new GeminiDirector(ai, "gemini-test");
    const input = directorInput(source, profile, brand);
    expect(d.estimateMicros(input)).toBeGreaterThan(0);
    const out = await d.direct(input, c);
    expect(calls).toBe(2);
    expect(decisionProblems(out.decision, input)).toEqual([]);
    expect((c.tracker as CostTracker).spentMicros()).toBe(4700);
    await expect(new GeminiDirector({ ...ai, hasApiKey: false }, "m").available()).resolves.toMatchObject({
      ok: false,
    });
  });
});

describe("techniqueFor", () => {
  it("plans a relight only for a product that emits light", () => {
    expect(techniqueFor("silhouette_reveal", "none", true)).toBe("relight");
    expect(techniqueFor("hero_reveal", "light_on", true)).toBe("relight");
    expect(techniqueFor("silhouette_reveal", "none", false)).toBe("plate");
    expect(techniqueFor("hero_reveal", "light_on", false)).toBe("plate");
    expect(techniqueFor("silhouette_reveal", "rotate", false)).toBe("sequence");
    expect(techniqueFor("slow_turntable", "none", false)).toBe("sequence");
  });
});

describe("beat snapping", () => {
  it("snaps cuts to beats and frames, keeps ≥ 900 ms shots and the exact total", () => {
    const b = snapBoundaries([2, 3, 2.4, 2, 2.6], 12_000, 105, 30);
    expect(b[0]).toBe(0);
    expect(b[b.length - 1]).toBe(12_000);
    for (let i = 1; i < b.length; i++) expect(b[i]! - b[i - 1]!).toBeGreaterThanOrEqual(900);
    // on a frame (ms are integers, so within 1/30 of a frame)
    for (const x of b) expect(Math.abs((x * 30) / 1000 - Math.round((x * 30) / 1000))).toBeLessThan(0.034);
    // on the beat grid where that keeps shots long enough (105 BPM → 571.4 ms)
    expect(Math.abs(b[2]! / (60_000 / 105) - Math.round(b[2]! / (60_000 / 105)))).toBeLessThan(0.06);
  });
});

describe("tools category (synthetic cordless drill facts)", () => {
  const drill: ProductSource = {
    id: "DRILL1",
    source: { kind: "json", ref: "test", license: "test" },
    brand: "Acme",
    names: { "en-US": "Acme 18V Cordless Drill Driver" },
    category: "Drills",
    categoryPath: "/Tools/Power Tools/Drills",
    facts: [
      {
        id: "bp.en-US.1",
        kind: "included",
        text: "2.0 Ah battery and charger included",
        source: "t",
        locale: "en-US",
      },
      {
        id: "bp.en-US.2",
        kind: "feature",
        text: "Keyless chuck for fast bit changes",
        source: "t",
        locale: "en-US",
      },
      {
        id: "bp.en-US.3",
        kind: "feature",
        text: "Built-in LED work light for the drilling area",
        source: "t",
        locale: "en-US",
      },
      { id: "bp.en-US.4", kind: "included", text: "Delivered in a carry case", source: "t", locale: "en-US" },
    ],
    images: [],
  };

  it("uses tool concepts proven by the facts and keeps claims valid in PL and DE", async () => {
    const profile = await new DeterministicProductAnalyzer().analyze(drill, ctx());
    expect(profile.category).toBe("tools");
    const brand = loadBrandProfile("assets/brands/homely-finds/brand.json");
    for (const locale of ["pl-PL", "de-DE"]) {
      const d = templateDecision(directorInput(drill, profile, brand, locale));
      const all = [
        d.hook.text,
        ...d.voiceover.lines.map((l) => l.text),
        ...d.shots.flatMap((s) => (s.overlay ? [s.overlay.text] : [])),
      ];
      expect(all.join(" ")).toMatch(
        locale === "pl-PL" ? /Akumulator|Szybkozaciskowy|LED/ : /Akku|Schnellspann|LED/,
      );
      expect(d.shots[0]!.preset).toBe("impact");
      const job = ReelJob.parse({
        jobId: "d",
        productId: "DRILL1",
        brandId: "b",
        locales: [{ locale, market: locale.slice(3) }],
      });
      const plan = compilePlan({
        decision: d,
        job,
        source: drill,
        profile,
        brand,
        platform,
        tier: TIER_PROFILES.ECONOMY,
        locale,
        market: locale.slice(3),
        variantKey: "A",
        director: { provider: "template", model: "t", promptVersion: "1", fallbackUsed: false },
        providers: {},
        fallbacks: {},
        configVersion: "test",
      });
      expect(validateCopy(plan.copy, drill, brand, profile).filter((i) => i.severity !== "minor")).toEqual(
        [],
      );
    }
  });
});
