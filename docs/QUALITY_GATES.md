# Quality gates

Five separate quality layers, each with its own report and gate. A technically perfect file can still be a weak
creative; a strong creative can still contain a claim the brief does not support. All checks are deterministic
and local — no model is asked to judge quality or truth.

| Gate         | Passes when                                                                 | Report                                               |
| ------------ | --------------------------------------------------------------------------- | ---------------------------------------------------- |
| Technical    | no check fails                                                              | `technicalQa(file, plan)` — `packages/motion/src/qa` |
| Creative     | CreativeQualityScore ≥ **80** and no hard fail                              | `creativeQa(...)` — `packages/creative/src/quality`  |
| Factual      | score ≥ **95** (every on-screen number traces to the brief's product facts) | `factualQa(...)`                                     |
| Compliance   | no check fails                                                              | `complianceQa(...)`                                  |
| Localization | score ≥ **90**                                                              | `localizationQa(...)`                                |

Thresholds are configurable (`evaluateGates({ thresholds })`). **Placeholder or demo media is never production
ready**, whatever the scores (label `NOT_PRODUCTION_READY`); real media that passes every gate is
`PRODUCTION_READY`, anything else `NEEDS_WORK`.

## Technical QA (on the delivered MP4)

| Check                 | Rule                                                                              |
| --------------------- | --------------------------------------------------------------------------------- |
| Container & codecs    | H.264 yuv420p + AAC                                                               |
| Geometry / frame rate | 1080×1920, 30 fps                                                                 |
| Duration              | within ±150 ms of the render plan                                                 |
| Audio                 | stereo, 48 kHz                                                                    |
| Decode                | FFmpeg decodes every frame without errors                                         |
| Black frames          | `blackdetect` finds no black segment (≥ 1 frame)                                  |
| Blank frames          | no uniform frame in the 10 fps / 108×192 proxy (luma spread < 2.5)                |
| Frozen video          | no run of identical frames ≥ 1.5 s (fail) / ≥ 0.8 s (warning) — a stalled picture |
| Loudness              | −14 ±1.5 LUFS integrated (warning to ±3)                                          |
| True peak             | ≤ −1 dBTP                                                                         |
| Silence               | no dropout ≥ 1 s (except the final fade)                                          |
| Upload size           | ≤ 50 MB (warning)                                                                 |

The frame proxy also yields per-beat motion, a 64-bit perceptual difference hash (dHash) per beat and the
**static segments** (see Scene dynamics below), used by Creative QA. Fixture tests generate a black segment, a landscape clip and a frozen picture and assert that each
is caught (`technical.int.test.ts`).

## Creative QA — CreativeQualityScore

Weighted average of 15 factors (0–100 each):

| Factor (weight)                 | Measures                                                                                        |
| ------------------------------- | ----------------------------------------------------------------------------------------------- |
| Hook (14)                       | first beat is a hook, ≤ 10 words, text by 0.4 s, product on screen by 1 s, sound accent, motion |
| Product visibility (12)         | share of beats showing the product, average frame share, product in the CTA                     |
| Scene / shot variety (9)        | distinct shots (layout × main image × framing) and different images                             |
| Meaningful visual coverage (12) | share of the reel carried by imagery (see below); text-only share                               |
| Visual storytelling (10)        | the structure's required beats, at least one demonstration beat, ≥ 6 beats                      |
| Pacing (9)                      | 15–30 s, beats 1.2–5.5 s, average ≤ 4.2 s                                                       |
| Text density (8)                | words per beat, reading time vs visible time, words per second overall                          |
| Typography (8)                  | everything fits at readable sizes, glyph coverage, ≤ 2 families                                 |
| Legibility & safe zones (9)     | platform safe zones, scrims on imagery, WCAG contrast (4.5:1 body, 3:1 large accent labels)     |
| Brand / kit consistency (5)     | one style kit for every beat                                                                    |
| Commercial clarity (7)          | named product, feature / spec beats, a concrete number                                          |
| CTA quality (6)                 | final CTA beat ≥ 2.2 s, short verb-first button, product present                                |
| Visual repetition (6)           | perceptual-hash distance between beats, media over-use                                          |
| Production polish (7)           | sound design density, transition variety, technical status, frozen holds                        |
| Scene dynamics (7)              | no visually unchanged stretch longer than ~2.5 s                                                |

**Hard rules** (cap the score at 59 and fail the gate): product never shown · no CTA at the end · text that does
not fit at the minimum size · missing glyphs · missing copy · fewer than 4 beats · technical QA failed ·
**text-only frames for more than 25 % of the reel**.

### Meaningful visual coverage and text-only ratio

Computed deterministically from the render plan, every 100 ms: the frame share covered by meaningful media layers
(product, product detail, lifestyle / context scene, demonstration, diagram, UI, comparison — kit backgrounds and
gradients excluded; contained images count by their fitted area, full-bleed and macro shots count fully).

- **meaningful** — imagery covers ≥ 15 % of the frame, or ≥ 6 % together with an information graphic (gauge,
  callout leader lines, slider, steps synced to media, pictogram chips).
- **text-only** — imagery covers < 12 % and no information graphic is on screen (a thumbnail above a text card
  does not make it a visual).

Targets for product affiliate reels: **meaningfulVisualCoverage ≥ 80 %**, **textOnlyDurationRatio ≤ 15 %**;
above 25 % text-only the creative gate fails.

### Scene dynamics (static scene rule)

From the 10 fps proxy: a moment is _static_ when the frame 2.5 s later is still nearly identical (mean |Δ| < 4/255
and dHash distance ≤ 5). Overlapping static windows merge into segments; each segment costs 20 points (30 when
≥ 4 s). This is a creative judgement, not a technical defect, so it lives in Creative QA; the technical gate only
fails truly frozen (identical) frames. The renderer prevents stills by moving the "world" layer (media and anchored
overlays) with a slow camera on every beat while text and UI stay fixed.

What the score is **not**: a prediction of performance or a verdict on taste. It means "no known structural or
technical defects". Masters still need a human visual review before approval.

## Factual QA

Every number in the on-screen copy and every animated counter must appear in the brief's product facts (name,
tagline, feature titles, stat values, spec items, steps, recap). Structural numbering ("No. 01") is exempt. For a
localized pack, every number of the source copy must survive translation. Each unverified number costs 20 points.

## Compliance QA

- Affiliate / sponsored content shows a disclosure for the whole reel.
- Placeholder / demo media carries the burned-in DEMO label.
- No prohibited or absolute claims (cure, guaranteed, risk-free, #1, clinically proven, …).
- No medical or skin-treatment claims (anti-aging, wrinkles, acne, treatment, …).
- No fake reviews, tests or testimonials ("I tested", "5 stars", "customers love", …).
- Fabricated urgency ("only 3 left", "today only") is a warning.

## Localization QA

Every slot has copy · copy fits at readable sizes · the fonts cover every character · copy stays within the
slot's character budget (+15 % tolerance, warning).
