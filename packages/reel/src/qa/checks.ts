import { measureText } from "@cre/media";
import type { QaIssue, QaReport } from "../contracts/manifest.ts";
import type { CaptionTrack, ShotClip, TextElement, VoiceTrack } from "../contracts/media.ts";
import type { ReelPlan } from "../contracts/plan.ts";
import type { BrandProfile, PlatformProfile, Rect } from "../contracts/profiles.ts";

/**
 * Pure QA rules. Each returns named checks and issues; an issue carries a deterministic `fix` code when the
 * factory can repair it without a model (planRetry): reframe:<shot>:+fill|-fill, reposition_captions,
 * extend_cta, renormalize. Text over the product and text over the logo have no deterministic fix (the layout
 * already avoids both where it can): they lower the score and are left for review.
 */

export type Check = QaReport["checks"][number];
export interface RuleResult {
  checks: Check[];
  issues: QaIssue[];
}

const empty = (): RuleResult => ({ checks: [], issues: [] });
const merge = (...rs: RuleResult[]): RuleResult => ({
  checks: rs.flatMap((r) => r.checks),
  issues: rs.flatMap((r) => r.issues),
});

export const area = (r: Rect) => Math.max(0, r.w) * Math.max(0, r.h);

export function intersect(a: Rect, b: Rect): Rect {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  return { x, y, w: Math.max(0, x2 - x), h: Math.max(0, y2 - y) };
}

export function overlaps(a: Rect, b: Rect): boolean {
  return area(intersect(a, b)) > 0;
}

/** Rects may arrive normalised (0..1) or in pixels; QA works in pixels. */
export function toPx(r: Rect, W: number, H: number): Rect {
  const normalised = Math.max(Math.abs(r.x), Math.abs(r.y), r.w, r.h) <= 1.5;
  return normalised ? { x: r.x * W, y: r.y * H, w: r.w * W, h: r.h * H } : r;
}

/* ---------------------------------------------------------------- technical -------------------- */

export interface TechMeasure {
  durationMs: number;
  width: number;
  height: number;
  fps: number;
  videoCodec: string;
  pixFmt: string;
  audioCodec: string;
  audioSampleRate: number;
  audioChannels: number;
  frameCount: number;
  decodeErrors: number;
  sizeBytes: number;
  loudness: { I: number | null; TP: number | null; LRA: number | null };
  black: { startMs: number; endMs: number }[];
  freezes: { startMs: number; endMs: number }[];
}

/** Windows where black is intended (fade-through-black transitions). */
function intendedBlack(plan: ReelPlan): { startMs: number; endMs: number }[] {
  return plan.shots
    .filter((s) => s.transitionIn.type === "fadeblack")
    .map((s) => ({ startMs: s.startMs - 60, endMs: s.startMs + s.transitionIn.ms + 60 }));
}

export function technicalRules(m: TechMeasure, plan: ReelPlan, platform: PlatformProfile): RuleResult {
  const out = empty();
  const add = (
    id: string,
    passed: boolean,
    value: unknown,
    note: string,
    issue?: Omit<QaIssue, "message">,
  ) => {
    out.checks.push({ id, passed, value, note });
    if (!passed && issue) out.issues.push({ ...issue, message: note });
  };
  const frameMs = 1000 / plan.fps;
  const expectedFrames = Math.round((plan.durationMs * plan.fps) / 1000);
  add("integrity", m.decodeErrors === 0, m.decodeErrors, `${m.decodeErrors} decode errors`, {
    code: "decode_errors",
    severity: "blocker",
  });
  add(
    "codecs",
    m.videoCodec === "h264" && m.pixFmt === "yuv420p" && m.audioCodec === "aac",
    `${m.videoCodec}/${m.pixFmt}+${m.audioCodec || "none"}`,
    "expected h264/yuv420p + aac",
    { code: "codecs", severity: "major" },
  );
  add(
    "resolution",
    m.width === plan.resolution.width && m.height === plan.resolution.height,
    `${m.width}x${m.height}`,
    `expected ${plan.resolution.width}x${plan.resolution.height}`,
    { code: "resolution", severity: "blocker" },
  );
  add("fps", Math.abs(m.fps - plan.fps) < 0.05, m.fps, `expected ${plan.fps} fps`, {
    code: "fps",
    severity: "blocker",
  });
  add(
    "duration",
    Math.abs(m.durationMs - plan.durationMs) <= frameMs + 1,
    m.durationMs,
    `${m.durationMs} ms vs planned ${plan.durationMs} ms (±1 frame)`,
    { code: "duration", severity: "major" },
  );
  add(
    "platform_duration",
    m.durationMs >= platform.durationMs.min && m.durationMs <= platform.durationMs.max,
    m.durationMs,
    `${platform.displayName} accepts ${platform.durationMs.min}–${platform.durationMs.max} ms`,
    { code: "platform_duration", severity: "major" },
  );
  add(
    "frames",
    Math.abs(m.frameCount - expectedFrames) <= 1,
    m.frameCount,
    `${m.frameCount} frames vs ${expectedFrames} expected`,
    { code: "missing_frames", severity: "major" },
  );
  add(
    "audio_present",
    m.audioChannels >= 1 && m.audioSampleRate >= 44_100,
    `${m.audioChannels} ch @ ${m.audioSampleRate}`,
    "an audio stream (48 kHz stereo) is required",
    { code: "audio_missing", severity: "blocker" },
  );
  const { I, TP } = m.loudness;
  const lufsOk = I !== null && Math.abs(I - platform.loudness.lufs) <= 1.5;
  add("loudness", lufsOk, I, `integrated ${I ?? "n/a"} LUFS vs ${platform.loudness.lufs} ±1.5`, {
    code: "loudness",
    severity: I === null || I < -40 ? "blocker" : "major",
    fix: "renormalize",
  });
  add(
    "true_peak",
    TP !== null && TP <= platform.loudness.truePeakDb,
    TP,
    `true peak ${TP ?? "n/a"} dBTP ≤ ${platform.loudness.truePeakDb}`,
    {
      code: "true_peak",
      severity: "major",
      fix: "renormalize",
    },
  );
  const intended = intendedBlack(plan);
  const black = m.black.filter((b) => !intended.some((w) => b.startMs >= w.startMs && b.endMs <= w.endMs));
  const blackMs = black.reduce((s, b) => s + (b.endMs - b.startMs), 0);
  add("black_frames", blackMs < 200, black, `${blackMs} ms of unintended black`, {
    code: "black_frames",
    severity: "major",
    ...(black[0] ? { atMs: black[0].startMs } : {}),
  });
  const longFreeze = m.freezes.filter((f) => f.endMs - f.startMs > 2500);
  add("frozen", longFreeze.length === 0, m.freezes, `${longFreeze.length} frozen stretches > 2.5 s`, {
    code: "frozen_video",
    severity: "minor",
    ...(longFreeze[0] ? { atMs: longFreeze[0].startMs } : {}),
  });
  add(
    "file_size",
    m.sizeBytes <= platform.maxFileMb * 1024 * 1024,
    m.sizeBytes,
    `${(m.sizeBytes / 1e6).toFixed(1)} MB ≤ ${platform.maxFileMb} MB`,
    { code: "file_size", severity: "major" },
  );
  return out;
}

/* ---------------------------------------------------------------- product visibility ----------- */

/** presets that frame a detail on purpose: the product may exceed the frame */
const CLOSEUPS = new Set([
  "macro_push",
  "macro_pull",
  "detail_closeup",
  "feature_highlight",
  "technical_cutaway",
]);

const isCloseup = (shot: ReelPlan["shots"][number]) =>
  CLOSEUPS.has(shot.preset) || shot.params.focus === "detail";

/** Product box at a reel time, from the shot clip's product track (clip-local times). */
export function productRectAt(plan: ReelPlan, clips: readonly ShotClip[], atMs: number): Rect | null {
  const shot = plan.shots.find((s) => atMs >= s.startMs && atMs < s.startMs + s.durationMs);
  const track = shot ? clips.find((c) => c.shotId === shot.id)?.productTrack : undefined;
  if (!shot || !track?.length) return null;
  const local = atMs - shot.startMs;
  const best = track.reduce((a, b) => (Math.abs(b.tMs - local) < Math.abs(a.tMs - local) ? b : a));
  return toPx(best.rect, plan.resolution.width, plan.resolution.height);
}

/**
 * Product boxes (px) every `stepMs` over [startMs, endMs) — none while a close-up (or any framing where the
 * product fills most of the frame) makes the product the backdrop: text there is over the product by design.
 */
export function productRectsDuring(
  plan: ReelPlan,
  clips: readonly ShotClip[],
  startMs: number,
  endMs: number,
  stepMs = 100,
): Rect[] {
  const { width: W, height: H } = plan.resolution;
  const frame = { x: 0, y: 0, w: W, h: H };
  const out: Rect[] = [];
  for (let t = startMs; t < endMs; t += stepMs) {
    const shot = plan.shots.find((s) => t >= s.startMs && t < s.startMs + s.durationMs);
    const r = shot && !isCloseup(shot) ? productRectAt(plan, clips, t) : null;
    if (r && area(intersect(r, frame)) <= 0.6 * area(frame)) out.push(r);
  }
  return out;
}

export function productRules(plan: ReelPlan, clips: readonly ShotClip[]): RuleResult {
  const out = empty();
  const { width: W, height: H } = plan.resolution;
  const frame = { x: 0, y: 0, w: W, h: H };
  for (const shot of plan.shots) {
    const clip = clips.find((c) => c.shotId === shot.id);
    const track = clip?.productTrack ?? [];
    if (!track.length) {
      out.checks.push({ id: `product:${shot.id}`, passed: true, note: "no product track (not measurable)" });
      continue;
    }
    const rects = track.map((t) => toPx(t.rect, W, H));
    const visible = Math.min(...rects.map((r) => (area(r) ? area(intersect(r, frame)) / area(r) : 0)));
    const heightShare = Math.min(...rects.map((r) => Math.min(r.h, H) / H));
    const closeup = isCloseup(shot);
    // a close-up shows part of the product on purpose: it is "missing" only when the product barely covers the frame
    const coverage = Math.min(...rects.map((r) => area(intersect(r, frame)) / area(frame)));
    const cut = !closeup && visible < 0.9;
    const small = !closeup && heightShare < 0.22;
    const lost = closeup ? coverage < 0.15 : visible < 0.25;
    out.checks.push({
      id: `product:${shot.id}`,
      passed: !cut && !small && !lost,
      value: {
        visible: Number(visible.toFixed(3)),
        heightShare: Number(heightShare.toFixed(3)),
        coverage: Number(coverage.toFixed(3)),
        closeup,
      },
      note: `${Math.round(visible * 100)} % of the product inside the frame, ${Math.round(heightShare * 100)} % of the height`,
    });
    if (lost)
      out.issues.push({
        code: "product_missing",
        severity: "blocker",
        message: `${shot.id}: the product is mostly outside the frame`,
        atMs: shot.startMs,
        fix: `reframe:${shot.id}:-fill`,
      });
    else if (cut)
      out.issues.push({
        code: "product_cut",
        severity: "major",
        message: `${shot.id}: ${Math.round((1 - visible) * 100)} % of the product is cut off`,
        atMs: shot.startMs,
        fix: `reframe:${shot.id}:-fill`,
      });
    if (small)
      out.issues.push({
        code: "product_small",
        severity: "major",
        message: `${shot.id}: product only ${Math.round(heightShare * 100)} % of the frame height`,
        atMs: shot.startMs,
        fix: `reframe:${shot.id}:+fill`,
      });
  }
  return out;
}

/* ---------------------------------------------------------------- safe areas & text ------------ */

function panelRect(t: TextElement): Rect {
  const p = t.panel?.padding ?? 0;
  return { x: t.box.x - p, y: t.box.y - p, w: t.box.w + 2 * p, h: t.box.h + 2 * p };
}

export function captionRules(captions: CaptionTrack | undefined, platform: PlatformProfile): RuleResult {
  const out = empty();
  if (!captions) return out;
  const hits = platform.unsafe.filter((u) => overlaps(captions.box, u.rect)).map((u) => u.name);
  out.checks.push({
    id: "captions_safe_area",
    passed: hits.length === 0,
    value: captions.box,
    note: hits.length ? `caption band overlaps ${hits.join(", ")}` : "caption band clear of the platform UI",
  });
  if (hits.length)
    out.issues.push({
      code: "captions_unsafe",
      severity: "major",
      message: `captions overlap ${hits.join(", ")}`,
      fix: "reposition_captions",
    });
  // a phrase wider than the band on one line is wrapped by the composer into ≤ 2 lines; flag what still overflows
  const tooWide = captions.phrases.filter((p) =>
    p.words.some((w) => measureText(w.text, captions.fontSizePx) > captions.box.w),
  );
  out.checks.push({ id: "captions_fit", passed: tooWide.length === 0, value: tooWide.length });
  if (tooWide.length)
    out.issues.push({
      code: "caption_word_too_wide",
      severity: "minor",
      message: `${tooWide.length} phrases contain a word wider than the band`,
    });
  return out;
}

/** WCAG contrast ratio of two hex colours. */
export function contrastRatio(a: string, b: string): number {
  const lum = (hex: string) => {
    const c = hex.replace("#", "");
    const ch = [0, 2, 4].map((i) => {
      const v = parseInt(c.slice(i, i + 2), 16) / 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * ch[0]! + 0.7152 * ch[1]! + 0.0722 * ch[2]!;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** words a viewer can read per second on screen (comfortable ≈ 3, fast 4.5) */
const READ_WPS = 4.5;

/**
 * How much a text panel covers the product during its window: the largest share of the product box hidden and
 * the largest share of the panel that sits on the product. Boxes are bounding boxes, so a panel grazing the box
 * top (< 3 % of the product hidden) usually covers background and is not reported.
 */
export function productCover(panel: Rect, products: readonly Rect[]): { hidden: number; share: number } {
  let hidden = 0;
  let share = 0;
  for (const p of products) {
    const a = area(intersect(panel, p));
    hidden = Math.max(hidden, a / Math.max(1, area(p)));
    share = Math.max(share, a / Math.max(1, area(panel)));
  }
  return { hidden, share };
}

export function textRules(
  texts: readonly TextElement[],
  platform: PlatformProfile,
  /** product boxes (px) on screen over a window (productRectsDuring); omitted = not measurable */
  productDuring?: (startMs: number, endMs: number) => Rect[],
): RuleResult {
  const out = empty();
  for (const t of texts) {
    const rect = panelRect(t);
    const frame = { x: 0, y: 0, w: platform.width, h: platform.height };
    const inside = area(intersect(rect, frame)) >= area(rect) - 1;
    const hits = platform.unsafe.filter((u) => overlaps(rect, u.rect)).map((u) => u.name);
    const words = t.text.split(/\s+/).filter(Boolean).length;
    const readable =
      t.kind === "disclosure" || (t.endMs - t.startMs) / 1000 >= Math.max(0.8, words / READ_WPS);
    const contrast = t.panel && t.panel.opacity >= 0.55 ? contrastRatio(t.color, t.panel.color) : null;
    // the disclosure has a fixed, mandatory place (bottom-left, whole reel): never judged against the product
    const cover =
      productDuring && t.kind !== "disclosure"
        ? productCover(rect, productDuring(t.startMs, t.endMs))
        : { hidden: 0, share: 0 };
    const overProduct = cover.hidden >= 0.03;
    const passed =
      inside && !hits.length && readable && (contrast === null || contrast >= 4.5) && !overProduct;
    out.checks.push({
      id: `text:${t.id}`,
      passed,
      value: {
        hits,
        readable,
        contrast: contrast && Number(contrast.toFixed(2)),
        productHidden: Number(cover.hidden.toFixed(3)),
      },
      note: `${t.kind} "${t.text.replace(/\n/g, " ").slice(0, 60)}"`,
    });
    // major only when most of the panel sits on the product and hides a real part of it (the hook over the
    // product's top while it lights up); a panel reaching a little into the product box is minor
    if (overProduct)
      out.issues.push({
        code: "text_over_product",
        severity: cover.share >= 0.5 && cover.hidden >= 0.08 ? "major" : "minor",
        message:
          `${t.id} covers ${Math.round(cover.hidden * 100)} % of the product ` +
          `(${Math.round(cover.share * 100)} % of its panel)`,
        atMs: t.startMs,
      });
    if (!inside || hits.length)
      out.issues.push({
        code: "text_unsafe",
        severity: "major",
        message: `${t.id} ${!inside ? "leaves the frame" : `overlaps ${hits.join(", ")}`}`,
        atMs: t.startMs,
      });
    if (!readable)
      out.issues.push({
        code: "text_too_fast",
        severity: "minor",
        message: `${t.id}: ${words} words for ${t.endMs - t.startMs} ms`,
        atMs: t.startMs,
      });
    if (contrast !== null && contrast < 4.5)
      out.issues.push({
        code: "text_contrast",
        severity: t.kind === "cta" || t.kind === "button" ? "major" : "minor",
        message: `${t.id}: contrast ${contrast.toFixed(2)}:1 < 4.5:1`,
      });
  }
  return out;
}

export function ctaRules(
  plan: ReelPlan,
  texts: readonly TextElement[],
  platform: PlatformProfile,
): RuleResult {
  const out = empty();
  const cta = texts.find((t) => t.kind === "cta");
  const windowMs = plan.cta.endMs - plan.cta.startMs;
  const longEnough = windowMs >= platform.cta.minMs;
  const atEnd = plan.cta.endMs >= plan.durationMs - 100;
  out.checks.push({
    id: "cta_visible",
    passed: Boolean(cta) && longEnough && atEnd,
    value: { windowMs, present: Boolean(cta), button: texts.some((t) => t.kind === "button") },
    note: `CTA on screen ${windowMs} ms (min ${platform.cta.minMs} ms) until ${plan.cta.endMs} ms`,
  });
  if (!cta) out.issues.push({ code: "cta_missing", severity: "blocker", message: "no CTA text rendered" });
  if (!longEnough)
    out.issues.push({
      code: "cta_short",
      severity: "major",
      message: `CTA visible ${windowMs} ms < ${platform.cta.minMs} ms`,
      atMs: plan.cta.startMs,
      fix: `extend_cta:${Math.ceil((platform.cta.minMs - windowMs) / 100) * 100}`,
    });
  return out;
}

export function brandingRules(
  plan: ReelPlan,
  brand: BrandProfile,
  texts: readonly TextElement[],
  logoExpected: boolean,
  /** where the composer drew the logo (composeLocalized's logoBox) */
  logoBox?: Rect,
): RuleResult {
  const out = empty();
  const logo = plan.branding.logo;
  const logoMs = logo.enabled
    ? Math.max(0, Math.min(plan.durationMs, logo.endMs) - Math.max(0, logo.startMs))
    : 0;
  const brandText = texts.some((t) => t.text.toLowerCase().includes(brand.brandName.toLowerCase()));
  const branded = logoExpected ? logoMs >= 1500 : logoMs >= 1500 || brandText;
  out.checks.push({
    id: "branding",
    passed: branded,
    value: { logoMs, brandText },
    note: `logo on screen ${logoMs} ms`,
  });
  if (!branded)
    out.issues.push({
      code: "branding_missing",
      severity: "minor",
      message: "brand logo / name barely visible",
    });

  // the logo is burned in under the text: a text panel over it hides the brand (or the panel's text)
  if (logoBox && logo.enabled) {
    const under = texts.filter(
      (t) => t.startMs < logo.endMs && t.endMs > logo.startMs && area(intersect(panelRect(t), logoBox)) > 0,
    );
    out.checks.push({
      id: "logo_clear",
      passed: under.length === 0,
      value: { logo: logoBox, texts: under.map((t) => t.id) },
      note: under.length
        ? `text panels over the logo: ${under.map((t) => t.id).join(", ")}`
        : "logo clear of text",
    });
    for (const t of under)
      out.issues.push({
        code: "logo_text_overlap",
        severity: "major",
        message: `${t.id} panel overlaps the logo`,
        atMs: Math.max(t.startMs, logo.startMs),
      });
  }

  // affiliate / ad disclosure: required whenever the brand defines one — never hidden, whole reel
  const required = Object.keys(brand.disclosure).length > 0;
  const d = texts.find((t) => t.kind === "disclosure");
  const coverage = d ? (Math.min(plan.durationMs, d.endMs) - Math.max(0, d.startMs)) / plan.durationMs : 0;
  const ok = !required || coverage >= 0.95;
  out.checks.push({
    id: "disclosure",
    passed: ok,
    value: { required, coverage: Number(coverage.toFixed(3)) },
    note: d?.text,
  });
  if (!ok)
    out.issues.push({
      code: "disclosure_missing",
      severity: "blocker",
      message:
        required && !d
          ? "affiliate/ad disclosure missing"
          : `disclosure visible for ${Math.round(coverage * 100)} % only`,
    });
  return out;
}

export function voiceRules(voice: VoiceTrack | undefined, plan: ReelPlan): RuleResult {
  const out = empty();
  if (!plan.voiceover.enabled) return out;
  if (!voice) {
    out.checks.push({ id: "voice", passed: false, note: "voice-over planned but missing" });
    out.issues.push({ code: "voice_missing", severity: "major", message: "voice-over planned but missing" });
    return out;
  }
  const last = voice.words[voice.words.length - 1];
  const fits = !last || last.endMs <= plan.durationMs - 150;
  const monotonic = voice.words.every(
    (w, i) => w.endMs >= w.startMs && (i === 0 || w.startMs >= voice.words[i - 1]!.startMs),
  );
  out.checks.push({
    id: "voice_timing",
    passed: fits && monotonic,
    value: { words: voice.words.length, lastEndMs: last?.endMs ?? 0, source: voice.timingsSource },
    note: `${voice.provider}/${voice.voice}, timings: ${voice.timingsSource}`,
  });
  if (!fits)
    out.issues.push({
      code: "voice_overrun",
      severity: "major",
      message: `speech ends at ${last?.endMs} ms, too close to the end`,
    });
  if (!monotonic)
    out.issues.push({ code: "voice_timings", severity: "minor", message: "word timings not monotonic" });
  return out;
}

export function allRules(a: {
  tech: TechMeasure;
  plan: ReelPlan;
  platform: PlatformProfile;
  clips: readonly ShotClip[];
  texts: readonly TextElement[];
  captions?: CaptionTrack;
  voice?: VoiceTrack;
  brand: BrandProfile;
  logoExpected: boolean;
  logoBox?: Rect;
}): RuleResult {
  return merge(
    technicalRules(a.tech, a.plan, a.platform),
    productRules(a.plan, a.clips),
    captionRules(a.captions, a.platform),
    textRules(a.texts, a.platform, (s, e) => productRectsDuring(a.plan, a.clips, s, e)),
    ctaRules(a.plan, a.texts, a.platform),
    brandingRules(a.plan, a.brand, a.texts, a.logoExpected, a.logoBox),
    voiceRules(a.voice, a.plan),
  );
}

/* ---------------------------------------------------------------- score ------------------------ */

/**
 * Score 0–100: 100 − 40 per blocker − 12 per major − 4 per minor (rules), blended 75 / 25 with the visual QA
 * score when one exists. passed = no blocker and score ≥ threshold; rerenderRequired = a blocker / major issue
 * has a deterministic fix, or visual QA asks for it.
 */
export const SEVERITY_PENALTY = { blocker: 40, major: 12, minor: 4 } as const;

export function scoreReport(
  issues: readonly QaIssue[],
  visual: { score: number; rerenderRequired: boolean } | undefined,
  threshold = 80,
): { score: number; passed: boolean; rerenderRequired: boolean } {
  const rules = Math.max(0, 100 - issues.reduce((s, i) => s + SEVERITY_PENALTY[i.severity], 0));
  const score = Math.round(visual ? 0.75 * rules + 0.25 * Math.max(0, Math.min(100, visual.score)) : rules);
  const blocker = issues.some((i) => i.severity === "blocker");
  const fixable = issues.some((i) => i.fix && i.severity !== "minor");
  return {
    score,
    passed: !blocker && score >= threshold,
    rerenderRequired: fixable || Boolean(visual?.rerenderRequired),
  };
}
