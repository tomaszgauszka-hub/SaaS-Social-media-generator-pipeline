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

Pure argument builders + a no-shell runner. Master pass: concat / trim / transitions / logo → master video.
Localized pass: music + voice + SFX with automatic ducking under the voice, two-pass loudness normalisation to
the platform target, burned-in dynamic captions (libass: word highlight, phrase pop, karaoke fill, minimal),
overlays, CTA, disclosure, H.264 + AAC encode, poster frame.

## Mass production

Jobs run through the existing DB-outbox job system (`reel.produce`): retries with backoff, DLQ, budget
blocking, idempotency keys, a host-wide Blender resource lock, a process-wide Google request cap, and caches
for profiles, renders, music, SFX, TTS, captions and translations. Variants of the same product reuse the
master video and every cached render.

## Security

- Model output never reaches a shell: binaries are configured paths, arguments are arrays, `shell: false`.
- Everything a model may choose is a whitelisted id or a bounded number (`contracts/ids.ts`).
- Caption / overlay text is sanitised for libass; SSML is escaped.
- Downloads are restricted to known hosts; API keys are never logged.

## Development vs. production

Claude Code (with terminal, debuggers or a Blender MCP) is a development tool for building the factory. A
production reel needs no agent: `pnpm reel …` or a `reel.produce` job runs the whole line programmatically.
