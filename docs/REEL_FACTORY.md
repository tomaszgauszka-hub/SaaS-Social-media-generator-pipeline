# Sales reel factory

`@cre/reel` turns a **real product** into short vertical **sales** reels — and into their localized and A/B
variants — automatically, without an agent at runtime. Models direct, local code produces:

> The model is the director. Blender is the studio. Lyria is the composer. TTS is the voice. The local cache is
> the library. FFmpeg is the editor. The application is the factory.

## Hierarchy: who is allowed to do what

```
CACHE / EXISTING ASSET          content-addressed file cache, asset index, ProductProfile cache
  ↓
LOCAL DETERMINISTIC CODE        template director, plan compiler, layout, captions, claims, QA rules
  ↓
LOCAL BLENDER / FFMPEG          product studio (Cycles), ReelComposer
  ↓
CHEAP API                       Gemini Flash-Lite for decisions (small JSON)
  ↓
LLM (larger)                    escalation model when the cheap one fails validation
  ↓
IMAGE / AUDIO GENERATION        Lyria music, TTS voices, (optional) background plates
  ↓
GENERATIVE VIDEO                last resort, off by default, capped per reel
```

A model is never asked to do what code can do (timing, keyframes, layout, encoding, loudness, captions,
alignment, retries). A model's answer is **data**: a schema-validated JSON object built from whitelisted ids
and bounded numbers. It is never a shell command, a filter graph or a path.

## Pipeline

```
PRODUCT SOURCE (feed / ABO dataset / DB / JSON)
  → ingestion → ProductSource (ground-truth facts with ids, names per locale, photos, 3D model)
  → product analysis → ProductProfile (cached per source hash + analyzer version)
  → asset retrieval (studio renders for this model, music, SFX, backgrounds — lexical + embeddings)
  → ReelDirector (Gemini with the template director as fallback) → DirectorDecision (small JSON)
  → PlanCompiler → ReelPlan (the contract; master copy)
  → claim validation (every number / claim traces to a fact)
  → generative-video ladder (existing → local render → local approximation → special shot within limits)
  ┌─ visual: Blender product studio (plates / relight pairs / sequences, cached per shot) → shot clips
  │          → ReelComposer master pass → MASTER VIDEO (no text, no voice — shared by every locale)
  └─ audio:  music (Lyria | cached | local procedural, fitted to the timeline) + SFX (cache → local → API)
  → per locale: transcreation → claim validation → voice (TTS chain) → word timings → captions → text layout
     → ReelComposer localized pass (mix, ducking, loudness, captions, overlays, CTA, logo, encode)
  → QA (technical + product visibility + safe areas + CTA + branding + loudness + accuracy + visual QA)
     → deterministic retry (reframe, reposition captions, extend CTA, renormalize) when fixable
  → manifest (providers, models, shots, timings, tokens, cost breakdown, fallbacks, QA, outputs)
```

## The ReelPlan contract

`packages/reel/src/contracts/plan.ts`. One plan per variant (locale × A/B arm). Everything a viewer sees or
hears as **words** lives in `plan.copy` (a `LocaleCopy` of slots with fact ids); everything else (shots,
camera, lighting, music intent, SFX, timing, branding, render profile, providers, fallbacks, budget) is
language-free. Two plans with the same visual part render the same master video — that is how a new language
costs one audio pass and one video pass instead of a Blender render.

| Field group                               | Content                                                                                                                                            |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| metadata                                  | plan / job / variant ids, seed, config version, hook strategy, director provider + model + prompt version                                          |
| product                                   | id, name, brand, fact ids the copy may use, model sha                                                                                              |
| language / market / platform              | locale tag, market, platform profile id                                                                                                            |
| duration / resolution / fps               | 1080×1920, 30 fps, platform-bounded duration                                                                                                       |
| structure                                 | sales roles over time (HOOK, PROBLEM, BENEFIT, PROOF, DEMO, DESIRE, VALUE, CTA)                                                                    |
| shots                                     | preset (21 procedural shots), technique (plate / relight / sequence), environment, lighting, bounded params, product animation, transition, source |
| visual_style / camera / product_animation | studio environment, energy, palette, lens, DOF, motion blur                                                                                        |
| voiceover                                 | persona, pace, style, segments (slot + start time)                                                                                                 |
| music                                     | intent (genre, mood, BPM, energy, events: riser / drop / final hit) + ducking parameters                                                           |
| sfx                                       | timed cues from the SFX library                                                                                                                    |
| captions / cta / branding                 | caption style and source, CTA window + slots, logo window, disclosure slot                                                                         |
| render_profile                            | Blender FAST / QUALITY, encode settings, audio loudness target                                                                                     |
| providers / fallbacks                     | chain head per capability and the full ordered chain                                                                                               |
| budget                                    | max and estimated API cost                                                                                                                         |
| copy                                      | locale copy (slots + fact ids + transcreation provenance)                                                                                          |

## Directors and copy

- **TemplateDirector** (local, always available) — a per-category shot grammar (lighting: HOOK silhouette reveal
  with the light switching on → BENEFIT slow turntable → PROOF macro push on the brass / walnut → DESIRE camera
  slide → CTA hero; tools / kitchen / electronics: impact → turntable demo → detail → feature → CTA; generic
  grammar otherwise), music from the brand style with an energy curve that follows the sales structure, SFX
  cues on the sales beats (light switch, whoosh, shimmer, bass hit), copy from the native lexicon.
- **GeminiDirector** (`GOOGLE_DIRECTOR_MODEL`, then `GOOGLE_DIRECTOR_FALLBACK_MODEL`) — minimal JSON payload
  (profile, facts by id filtered to the copy language + English, brand / platform essentials, reusable assets,
  hook history), structured output constrained by the `DirectorDecision` schema, one repair round with the
  concrete problems, then the next provider.
- **Native copy lexicon** (`director/lexicon.ts`) — whole sentences per language (pl, en, de, fr, es, it) written
  as a copywriter would, never assembled word by word. Product claims exist only as _concepts_ that are used when
  the product's own facts contain them (walnut + brass + fabric, curved brass stem, LED bulb included, easy
  assembly, mid-century style, room fit …); every line carries the ids of the facts that prove it, preferring
  the facts written in the copy's language. Slot ids carry the concept id (`voice.2.materials_walnut_brass_fabric`),
  so **template transcreation** re-writes the same claim natively in another language instead of translating it.
  Example (lamp, PL / EN / DE): „Orzechowa podstawa, mosiężny trzon i abażur z tkaniny." / "A walnut base, a brass
  stem and a fabric shade." / „Sockel aus Walnuss, Stange aus Messing, Schirm aus Stoff."
- **PlanCompiler** — shot boundaries snapped to the music beat grid and to frames, CTA window ≥ the platform
  minimum, technique per preset (plate / relight / sequence), voice segments on their sales roles, music events
  (energy changes on cuts, drop after the hook, riser before the CTA, final hit on the CTA downbeat), SFX gains
  per kind, caption / CTA / logo / disclosure configuration, render profile from the tier. Same input → the
  same bytes.

## Sales-first direction

The director composes for conversion, not for spectacle: HOOK → PROBLEM / NEED → BENEFIT → PROOF / FEATURE →
DESIRE → CTA, compressed to the duration (a 12 s reel is typically hook 0–1.5 s, benefit 1.5–4 s,
demonstration 4–8 s, strongest value 8–10 s, CTA 10–12 s). Hooks come from a library of twelve strategies
(problem, visual surprise, price, comparison, before/after, question, pain point, benefit first, curiosity,
social proof, speed demo, feature reveal); the director picks one, the hook engine fills a native-language
template and excludes strategies the facts cannot support (no price → no price hook, no reviews → no social
proof). Hook outcomes are stored for later analysis; there is no self-"learning" without real data.

## Product accuracy and claims

- The product is shown from its own 3D model (or real photos), with its own PBR materials. AI images are never
  used to depict or edit the product.
- `validateCopy` rejects unknown fact ids, numbers that do not match a fact (with unit conversions), price /
  promotion / warranty / certificate wording without a fact of that kind, forbidden phrases, absolute claims
  and feature words the facts do not contain (e.g. "dimmable" for a lamp whose source does not say so).
- `checkRenderedColors` compares the rendered product region with the catalog palette.

## Fallback matrix

| Capability       | Chain (first available + within budget wins)                                       |
| ---------------- | ---------------------------------------------------------------------------------- |
| Director         | Gemini Flash-Lite → Gemini Flash → template director                               |
| Product analysis | cached profile → Gemini → deterministic analyzer                                   |
| Transcreation    | Gemini (one batched call) → template transcreation                                 |
| Music            | exact cache → Lyria (commercial use confirmed) → cached library → local procedural |
| Voice            | Google TTS → ElevenLabs → Piper (local) → flite (English)                          |
| Word timings     | provider timestamps → transcription → local forced alignment                       |
| SFX              | cache → local synthesis → ElevenLabs                                               |
| Images           | existing product images → Gemini image (plates only)                               |
| Video            | Blender → asset reuse → generative video (opt-in, capped)                          |
| Visual QA        | Gemini on 5 representative frames → deterministic frame checks                     |

Every skip and failure is recorded with its reason in the manifest (`fallbacks`).

## Cost, budgets and tiers

`CostTracker` records every call (tokens, units, micro-USD, latency, cache hits at 0) and every local compute
step (Blender, FFmpeg, audio synthesis, QA). `BudgetGate` reserves an estimate before a paid call and refuses
it when the job's `maxApiCost` would be exceeded; the chain then falls back to a local provider, so a reel
never fails for budget reasons — it gets cheaper.

| Tier     | Director | Music | Voice         | Blender | AI images   | Generative video | Visual QA     | Default budget |
| -------- | -------- | ----- | ------------- | ------- | ----------- | ---------------- | ------------- | -------------- |
| ECONOMY  | template | local | local (Piper) | FAST    | no          | 0 s              | deterministic | $0             |
| STANDARD | Gemini   | Lyria | Google TTS    | FAST    | no          | 0 s              | Gemini        | $0.20          |
| PREMIUM  | Gemini   | Lyria | premium voice | QUALITY | plates only | ≤ 2 s            | Gemini        | $1.50          |

## Blender product studio

`tools/blender/studio` (bpy, Cycles CPU) builds the set once per job — product import with untouched PBR
materials, centring and scaling, 9:16 camera framing, six environments, six lighting presets, shadow catcher,
DOF, motion blur, an internal light for light-emitting products — and renders 21 parametric shots whose
keyframes are computed by a pure Python module. On CPU the studio is the bottleneck, so it renders smart:

- **plate** — one realistic still with overscan; the camera move (push, pull, slide) is done in FFmpeg;
- **relight** — two plates (light off / on) blended over the shot — exact for a light switching on;
- **sequence** — real frames for object motion (turntable, orbit, drop) at a reduced frame rate,
  interpolated to 30 fps.

Every shot is cached by product model hash + studio version + shot spec + profile, so localized and A/B
variants never re-render.

## ReelComposer (FFmpeg)

Pure argument builders (`composer/master.ts`, `audio.ts`, `subtitles.ts`) + a no-shell runner.

- **Master pass** — clips scaled / cropped to 1080×1920 @ plan fps; a transition into shot _k_ starts exactly at
  the planned cut and the outgoing shot holds its last frame for the transition length (`tpad`), so
  `xfade offset = start(k)` and the total is exactly `plan.durationMs` (frame-quantised: 12 s → 360 frames). Cuts
  are `concat`. The brand logo is overlaid outside every platform UI zone with an alpha fade. Output: H.264 CRF 14,
  no audio. The master is cached by a **visual hash** (clip file hashes + visual plan fields + logo + composer
  version — never copy, voice or captions), so every locale and every QA retry that does not touch the visuals
  reuses it.
- **Localized pass** — music (trim, fades, gain) with a **deterministic ducking envelope** computed from the
  voice's word timings (`gain = 10^(−depth·s(t)/20)`, trapezoid attack before each speech region, release after;
  the music dips _before_ the first syllable instead of reacting to it), voice on the reel timeline, SFX
  (`adelay`, per-kind gain), `amix normalize=0`, limiter, then **two-pass loudnorm** to the plan's mastering
  target (platform −14 LUFS; true peak mastered 1.5 dB under the delivery ceiling for AAC overshoot). Video:
  libass captions (word highlight, phrase pop, karaoke fill with `\kf` per word, minimal lower) and text
  elements (hook, overlays, CTA headline, CTA button with a pulse, disclosure) on rounded panels, fonts loaded
  from the brand's files (`fontsdir`), every string sanitised for ASS; H.264 + AAC 48 kHz 192 kbps,
  `+faststart`, poster frame from the CTA.
- Measured on synthetic inputs (5 s reel): master pass ≈ 2 s, localized pass ≈ 3 s per locale; ducking verified
  numerically (the 150 Hz music bed is 8–12 dB lower inside speech), loudness within ±1 LU of target.

## QA and deterministic retry

`qa/run.ts` checks the delivered MP4, not the plan: full decode (integrity), frame count, duration ±1 frame,
resolution, FPS, codecs, platform duration and file size, EBU R128 loudness and true peak (platform-specific),
unintended black (fade-through-black windows excluded), long freezes; product visibility per shot from the
studio's product track (cut / too small / missing, close-up presets exempt); captions and text elements against
the platform's unsafe zones, reading time and WCAG contrast; CTA present, long enough and at the end; brand
logo; **affiliate / ad disclosure on screen for the whole reel (blocker if missing)**; voice timing; and colour
accuracy of the rendered product against the catalog palette. Visual QA runs on 5 representative frames
(10/30/50/70/90 %): Gemini (low media resolution, fixed rubric, JSON) when the tier and budget allow, otherwise
local FFmpeg statistics (exposure, flat product region, edge density). Score = 100 − 40 / 12 / 4 per blocker /
major / minor issue, blended 75/25 with the visual score; passed = no blocker and score ≥ 80.

Fix codes drive `planRetry` (no model): `reframe:<shot>:±fill`, `reposition_captions`, `extend_cta:<ms>` (time
taken from the previous shot) and `renormalize` (more true-peak headroom). Only what changed is re-rendered
(Blender shot cache, master cache).

## Mass production

Jobs run through the existing DB-outbox job system: `pnpm reel … --enqueue` (or `enqueueReelProduction()`)
writes a `reel.produce` row (idempotency key `reel.produce:<jobId>`), the dispatcher pushes it to the
`reel_render` BullMQ queue (concurrency = `RENDER_CONCURRENCY`, timeout 1 h, 2 attempts, then the dead-letter
queue). Product and brand are referenced by paths inside `.data/products` / `assets/brands` only. On top of
that: a host-wide Blender resource lock, a process-wide Google request cap with Retry-After back-off, per-job
budget gates, and content-addressed caches for profiles, renders, master videos, music, SFX, TTS, captions and
translations. Variants of the same product reuse the master video and every cached render. Results land in
`ReelJobRecord` / `ReelVariant` (plan, manifest and feature columns for later conversion analysis) and the hook
memory.

## Security

- Model output never reaches a shell: binaries are configured paths, arguments are arrays, `shell: false`.
- Everything a model may choose is a whitelisted id or a bounded number (`contracts/ids.ts`).
- Caption / overlay text is sanitised for libass; SSML is escaped.
- Downloads are restricted to known hosts; API keys are never logged.

## Development vs. production

Claude Code (with terminal, debuggers or a Blender MCP) is a development tool for building the factory. A
production reel needs no agent: `pnpm reel …` or a `reel.produce` job runs the whole line programmatically.
