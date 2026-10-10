import type {
  Capability,
  LightingPreset,
  ShotPreset,
  ShotTechnique,
  SfxKind,
  Transition,
} from "../contracts/ids.ts";
import type { ReelJob } from "../contracts/job.ts";
import { lightSwitchFrame } from "../contracts/media.ts";
import {
  REEL_PLAN_VERSION,
  ReelPlan,
  type CopySlot,
  type DirectorDecision,
  type MusicEvent,
  type PlanShot,
} from "../contracts/plan.ts";
import type { ProductProfile, ProductSource } from "../contracts/product.ts";
import type { BrandProfile, PlatformProfile, TierProfile } from "../contracts/profiles.ts";
import { CONCEPTS, disclosureFor, langOf, type Lang } from "./lexicon.ts";

/**
 * PlanCompiler: DirectorDecision (WHAT, from a model or the template) → ReelPlan (HOW, decided by code).
 * Shot boundaries are snapped to the music beat grid and to frames, the CTA window is at least the platform
 * minimum, techniques are chosen per preset (plate / relight / sequence), every word goes into a copy slot.
 * Same input → byte-identical plan.
 */

const SEQUENCE = new Set<ShotPreset>([
  "turntable",
  "slow_turntable",
  "orbit",
  "floating_product",
  "product_drop",
  "impact",
  "exploded_view",
  "parts_reveal",
  "assembly",
  "light_sweep",
]);
const MACRO = new Set<ShotPreset>([
  "macro_push",
  "macro_pull",
  "detail_closeup",
  "feature_highlight",
  "technical_cutaway",
]);

/**
 * relight (off / on plates) only for a product that emits light: without a light of its own both plates are the
 * same pixels, so a silhouette_reveal / light_on of anything else is planned like any other shot.
 */
export function techniqueFor(
  preset: ShotPreset,
  animation: PlanShot["productAnimation"],
  emitsLight: boolean,
): ShotTechnique {
  if (emitsLight && (animation === "light_on" || preset === "silhouette_reveal")) return "relight";
  if (SEQUENCE.has(preset) || animation === "rotate" || animation === "drop" || animation === "float")
    return "sequence";
  return "plate";
}

const TRANSITION_MS: Record<Transition, number> = {
  cut: 0,
  fade: 320,
  dissolve: 320,
  fadeblack: 360,
  fadewhite: 360,
  slideleft: 280,
  slideup: 280,
  smoothleft: 300,
  wipeleft: 280,
  circleopen: 320,
  zoomin: 300,
};

const SFX_GAIN: Record<SfxKind, number> = {
  whoosh: -12,
  impact: -6,
  metal_hit: -8,
  metal_click: -10,
  mechanical_click: -10,
  motor: -10,
  snap: -10,
  air_release: -12,
  electronic_beep: -14,
  transition: -12,
  riser: -12,
  bass_hit: -6,
  ui_click: -14,
  shimmer: -14,
  light_switch: -6,
};

const ANGLES = [-25, 22, -35, 30, -18, 26];

/**
 * Hook framing: the product's top at (0.565 − 0.55 / 2) × 1920 ≈ 557 px, below the tallest hook band of any
 * platform (Instagram: top bar 220 + band offset 74 + a two-line panel 242 = 536 px) — the headline never
 * covers the product while it is revealed. The bottom (0.84) matches the CTA hero framing.
 */
const HOOK_FRAMING = { fill: 0.55, centerY: 0.565 } as const;
/** CTA framing: the headline + button stack ends near 560 px on Instagram; the product starts at ~614 px */
const CTA_FRAMING = { fill: 0.54, centerY: 0.59 } as const;

/** Boundaries (ms) snapped to beats, then frames; every shot keeps ≥ minMs. */
export function snapBoundaries(
  seconds: number[],
  totalMs: number,
  bpm: number,
  fps: number,
  minMs = 900,
): number[] {
  const beat = 60_000 / bpm;
  const frame = 1000 / fps;
  const scale = totalMs / (seconds.reduce((a, b) => a + b, 0) * 1000);
  const out = [0];
  let acc = 0;
  for (let i = 0; i < seconds.length - 1; i++) {
    acc += seconds[i]! * 1000 * scale;
    const snapped = Math.round(acc / beat) * beat;
    const prev = out[out.length - 1]!;
    let b = snapped - prev >= minMs ? snapped : acc;
    b = Math.round(Math.round(b / frame) * frame);
    const remaining = seconds.length - 1 - i;
    b = Math.min(Math.max(b, prev + minMs), totalMs - remaining * minMs);
    out.push(b);
  }
  out.push(totalMs);
  return out;
}

/** A stable slot tag: the lexicon concept a line came from (same id in every language), else the role. */
function tagFor(text: string, lang: Lang, fallback: string): string {
  const c = CONCEPTS.find((x) => x.line[lang] === text || x.short[lang] === text || x.hook?.[lang] === text);
  return c ? c.id : fallback;
}

export interface CompileInput {
  decision: DirectorDecision;
  job: ReelJob;
  source: ProductSource;
  profile: ProductProfile;
  brand: BrandProfile;
  platform: PlatformProfile;
  tier: TierProfile;
  locale: string;
  market: string;
  variantKey: string;
  director: { provider: string; model: string; promptVersion: string; fallbackUsed: boolean };
  providers: Partial<Record<Capability, string>>;
  fallbacks: Partial<Record<Capability, string[]>>;
  configVersion: string;
  estimatedApiCostUsd?: number;
}

export function compilePlan(a: CompileInput): ReelPlan {
  const d = a.decision;
  const lang: Lang = langOf(a.locale) ?? "en";
  const fps = a.platform.fps;
  const frame = 1000 / fps;
  const seconds = Math.min(
    a.platform.durationMs.max / 1000,
    Math.max(a.platform.durationMs.min / 1000, d.durationS),
  );
  const durationMs = Math.round(Math.round((seconds * 1000) / frame) * frame);
  const bounds = snapBoundaries(
    d.shots.map((s) => s.seconds),
    durationMs,
    d.music.bpm,
    fps,
  );
  // CTA window ≥ platform minimum: take the time from the shot before the CTA shot if needed
  const last = d.shots.length - 1;
  const ctaMin = a.platform.cta.minMs;
  if (d.shots[last]?.role === "CTA" && bounds[last + 1]! - bounds[last]! < ctaMin && last > 0) {
    const want = Math.round(Math.round((durationMs - ctaMin) / frame) * frame);
    bounds[last] = Math.max(bounds[last - 1]! + 900, Math.min(bounds[last]!, want));
  }

  const slots: Record<string, CopySlot> = {};
  slots.hook = { kind: "hook", text: d.hook.text, factIds: d.hook.factIds };
  const shots: PlanShot[] = d.shots.map((s, i) => {
    const id = `sh${String(i + 1).padStart(2, "0")}`;
    const startMs = bounds[i]!;
    const durMs = bounds[i + 1]! - startMs;
    const productAnimation = s.productAnimation;
    const technique = techniqueFor(s.preset, productAnimation, a.profile.traits.emitsLight);
    const macro = MACRO.has(s.preset) || s.focus === "detail";
    const lighting: LightingPreset =
      technique === "relight" && i === 0 ? "rim_dramatic" : d.visualStyle.lighting;
    let overlaySlot: string | undefined;
    if (s.overlay) {
      overlaySlot = `overlay.${id}.${tagFor(s.overlay.text, lang, s.role.toLowerCase())}`.slice(0, 64);
      slots[overlaySlot] = { kind: "overlay", text: s.overlay.text, factIds: s.overlay.factIds };
    }
    const transitionType: Transition = i === 0 ? "cut" : s.transition;
    return {
      id,
      role: s.role,
      startMs,
      durationMs: durMs,
      preset: s.preset,
      technique,
      environment: d.visualStyle.environment,
      lighting,
      params: {
        intensity: Math.round((0.35 + 0.5 * d.visualStyle.energy) * 100) / 100,
        angleDeg: ANGLES[i % ANGLES.length]!,
        height: s.preset === "low_angle" ? 0.25 : s.preset === "top_down" ? 1.4 : 0.55,
        focus: s.focus,
        fill: macro
          ? 1.5
          : s.role === "CTA"
            ? CTA_FRAMING.fill
            : s.role === "HOOK"
              ? HOOK_FRAMING.fill
              : 0.62,
        sweepDeg:
          s.preset === "turntable" ? 90 : s.preset === "slow_turntable" ? 40 : s.preset === "orbit" ? 60 : 30,
        // the hook headline and the CTA stack sit in the top text band: the product starts below them on every
        // platform (the panels never cover the product while it is revealed or offered)
        ...(s.role === "HOOK" && !macro ? { centerY: HOOK_FRAMING.centerY } : {}),
        ...(s.role === "CTA" && !macro ? { centerY: CTA_FRAMING.centerY } : {}),
      },
      productAnimation,
      transitionIn: { type: transitionType, ms: TRANSITION_MS[transitionType] },
      source: "blender",
      ...(overlaySlot ? { overlaySlot } : {}),
    };
  });

  // voice: each line starts on the first unused shot of its role (in order), never before the previous one
  const segments: { slot: string; atMs: number }[] = [];
  const usedShots = new Set<number>();
  let cursor = 0;
  d.voiceover.lines.forEach((line, i) => {
    const idx = shots.findIndex(
      (s, k) => s.role === line.role && !usedShots.has(k) && s.startMs >= cursor - 1,
    );
    const shot = idx >= 0 ? shots[idx]! : undefined;
    if (idx >= 0) usedShots.add(idx);
    const atMs = Math.max(cursor, (shot?.startMs ?? cursor) + (i === 0 ? 250 : 140));
    const slot = `voice.${i + 1}.${tagFor(line.text, lang, line.role.toLowerCase())}`.slice(0, 64);
    slots[slot] = { kind: "voice", text: line.text, factIds: line.factIds };
    segments.push({ slot, atMs });
    cursor = atMs + 600;
  });

  slots.cta = { kind: "cta", text: d.cta.text, factIds: d.cta.factIds };
  slots.button = { kind: "button", text: d.cta.buttonText, factIds: [] };
  const disclosure = disclosureFor(a.brand, a.locale);
  if (disclosure) slots.disclosure = { kind: "disclosure", text: disclosure, factIds: [] };

  const ctaShot = shots[shots.length - 1]!;
  const ctaStart = Math.min(ctaShot.startMs, durationMs - ctaMin);
  const beat = 60_000 / d.music.bpm;
  const events: MusicEvent[] = (
    [
      // energy changes snap to a nearby cut so the music moves with the picture
      ...d.music.energyCurve.map((p) => {
        const t = Math.min(durationMs, Math.round(p.atS * 1000));
        const cut = shots.map((s) => s.startMs).find((c) => Math.abs(c - t) <= 600);
        return { timeMs: cut ?? t, energy: p.energy };
      }),
      ...(shots[1] ? [{ timeMs: shots[1].startMs, event: "drop" as const }] : []),
      { timeMs: Math.max(0, Math.round(ctaShot.startMs - 4 * beat)), event: "riser" as const },
      // the final hit lands on the CTA downbeat (the snapped CTA cut), whatever the decision's unsnapped estimate
      {
        timeMs:
          d.music.finalHitAtS !== undefined && d.music.finalHitAtS * 1000 < ctaShot.startMs - 1500
            ? Math.round(d.music.finalHitAtS * 1000)
            : ctaShot.startMs,
        event: "final_hit" as const,
      },
    ] as MusicEvent[]
  ).sort(
    (x: MusicEvent, y: MusicEvent) =>
      x.timeMs - y.timeMs || String(x.event ?? "").localeCompare(String(y.event ?? "")),
  );
  const sfx = d.sfx
    .filter((c) => c.shotIndex < shots.length)
    .map((c) => {
      const s = shots[c.shotIndex]!;
      // a relight's switch click lands on the frame the light starts to come on (the clip's crossfade)
      const switchOn =
        c.kind === "light_switch" && s.technique === "relight"
          ? s.startMs + Math.round((lightSwitchFrame(Math.round((s.durationMs * fps) / 1000)) * 1000) / fps)
          : undefined;
      const atMs =
        switchOn ??
        (c.at === "start"
          ? s.startMs
          : c.at === "mid"
            ? s.startMs + Math.round(s.durationMs / 2)
            : s.startMs + s.durationMs - 150);
      return { atMs: Math.max(0, Math.min(durationMs - 100, atMs)), kind: c.kind, gainDb: SFX_GAIN[c.kind] };
    })
    .sort((x, y) => x.atMs - y.atMs);
  const meanEnergy = d.music.energyCurve.reduce((s, p) => s + p.energy, 0) / d.music.energyCurve.length;
  const quality = a.tier.blender === "QUALITY";

  return ReelPlan.parse({
    version: REEL_PLAN_VERSION,
    metadata: {
      planId: `${a.job.jobId}-${a.variantKey}`,
      jobId: a.job.jobId,
      variantKey: a.variantKey,
      configVersion: a.configVersion,
      seed: `${a.job.seed}:${a.variantKey}`,
      hookStrategy: d.hook.strategy,
      director: a.director,
    },
    product: {
      id: a.source.id,
      name: a.profile.shortName,
      brand: a.source.brand,
      factIds: a.source.facts.map((f) => f.id),
      ...(a.source.model3d?.sha256 ? { model3dSha: a.source.model3d.sha256 } : {}),
    },
    masterLocale: a.locale,
    language: a.locale,
    market: a.market,
    platform: a.platform.id,
    durationMs,
    resolution: { width: a.platform.width, height: a.platform.height },
    fps,
    objective: d.objective,
    targetAudience: d.targetAudience,
    structure: shots.map((s) => ({ role: s.role, startMs: s.startMs, endMs: s.startMs + s.durationMs })),
    visual_style: {
      environment: d.visualStyle.environment,
      energy: d.visualStyle.energy,
      lighting: d.visualStyle.lighting,
      palette: { primary: a.brand.colors.primary, accent: a.brand.colors.accent, text: a.brand.colors.text },
    },
    camera: { lensMm: 65, dof: { enabled: true, fStop: 4 }, motionBlur: quality },
    product_animation: { default: "none" },
    shots,
    voiceover: {
      enabled: d.voiceover.enabled && segments.length > 0,
      personaId: a.brand.voicePersona.id,
      pace: Math.round(d.voiceover.pace * a.brand.voicePersona.pace * 100) / 100,
      style: a.brand.voicePersona.style,
      segments,
    },
    music: {
      intent: {
        genre: d.music.genre,
        mood: d.music.mood,
        bpm: d.music.bpm,
        energy: Math.round(meanEnergy * 100) / 100,
        instrumental: true,
        durationMs,
        brandFeel: `${a.brand.brandName}: ${a.brand.musicStyle.moods.join(", ")}`.slice(0, 120),
        events,
        seed: `${a.source.id}:${d.music.genre}:${d.music.mood}:${d.music.bpm}:${durationMs}`.slice(0, 80),
      },
      gainDb: -10,
      ducking: { enabled: true, depthDb: 10, attackMs: 80, releaseMs: 350 },
    },
    sfx,
    captions: {
      enabled: d.voiceover.enabled && segments.length > 0,
      style: a.brand.captionStyle.preset ?? d.captions.style,
      source: "voiceover",
      maxWordsPerPhrase: a.brand.captionStyle.maxWordsPerPhrase,
    },
    cta: {
      slot: "cta",
      buttonSlot: "button",
      startMs: ctaStart,
      endMs: durationMs,
      style: a.platform.cta.style,
    },
    branding: {
      logo: {
        enabled: Boolean(a.brand.logo),
        position: a.brand.logo?.position ?? "top_right",
        startMs: 0,
        endMs: durationMs,
      },
      ...(disclosure ? { disclosureSlot: "disclosure" } : {}),
      brandName: a.brand.brandName,
    },
    render_profile: {
      blender: a.tier.blender,
      // measured on a 12 s 1080×1920 master: veryfast/CRF 16 matches medium/CRF 18 (SSIM 0.9958 vs 0.9957) at
      // 2.5× the speed — the localized encode is the bottleneck of a multi-locale job; QUALITY keeps medium
      encode: { crf: 16, preset: quality ? "medium" : "veryfast" },
      audio: {
        sampleRate: 48_000,
        lufs: a.platform.loudness.lufs,
        truePeakDb: a.platform.loudness.truePeakDb,
      },
    },
    providers: a.providers,
    fallbacks: a.fallbacks,
    budget: {
      maxApiCostUsd: a.job.maxApiCost ?? a.tier.defaultMaxApiCostUsd,
      estimatedApiCostUsd: a.estimatedApiCostUsd ?? 0,
    },
    copy: {
      locale: a.locale,
      market: a.market,
      slots,
      transcreation: {
        provider: a.director.provider,
        model: a.director.model,
        sourceLocale: a.locale,
        isMaster: true,
      },
    },
  });
}
