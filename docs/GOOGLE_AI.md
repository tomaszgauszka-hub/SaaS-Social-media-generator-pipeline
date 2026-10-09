# Google AI in the reel factory

Google is the factory's preferred **intelligence and selected-asset** provider: it is used for decisions
(director, product analysis, transcreation, visual QA) and for a few assets (music, voice, optional images,
optional 1–2 s generative video). It never renders the reel itself — Blender is the studio and FFmpeg the
editor. Every Google capability sits behind a capability interface (`packages/reel/src/capabilities`) and a
fallback chain, so a missing key, a price change or a retired model degrades to the next provider instead of
breaking production.

All model ids are configuration (`packages/config/src/env.ts`) — business logic never names a model:

| Capability                                           | Env key                                                 | Default (checked 2026-10-08) | Status                    | Price (paid tier)                                                           |
| ---------------------------------------------------- | ------------------------------------------------------- | ---------------------------- | ------------------------- | --------------------------------------------------------------------------- |
| Director, product analysis, transcreation, visual QA | `GOOGLE_DIRECTOR_MODEL`                                 | `gemini-3.5-flash-lite`      | GA (2026-07-21)           | $0.30 / 1M input (text·image·audio·video), $2.50 / 1M output incl. thinking |
| Escalation / fallback model                          | `GOOGLE_DIRECTOR_FALLBACK_MODEL`                        | `gemini-3.8-flash`           | GA (2026-09-02)           | $0.75 / $3.75 per 1M until 2026-12-31, then $1.50 / $7.50                   |
| Image generation / editing                           | `GOOGLE_IMAGE_MODEL`                                    | `gemini-nano-banana-2.1`     | GA (2026-10-06)           | ≈ $0.034 per 1K image, ≈ $0.050 per 2K (9:16 supported)                     |
| Music                                                | `GOOGLE_MUSIC_MODEL`                                    | `lyria-3.5`                  | GA (2026-09-03)           | $0.08 per song (no free tier)                                               |
| Voice (TTS)                                          | `GOOGLE_TTS_MODEL`                                      | `gemini-3.8-flash-tts`       | Preview (2026-09-28)      | ≈ $0.0135 per minute until 2026-12-31 ($9 / 1M audio tokens, 25 tokens/s)   |
| Word timings for captions                            | `GOOGLE_TRANSCRIPTION_MODEL`                            | `gemini-3.5-transcribe`      | Preview on Agent Platform | ≈ $0.005 per audio minute                                                   |
| Embeddings (asset retrieval)                         | `GOOGLE_EMBEDDING_MODEL`, `GOOGLE_EMBEDDING_DIMENSIONS` | `gemini-embedding-2`, 768    | GA (2026-04-22)           | text $0.20 / 1M, image ≈ $0.00012, audio ≈ $0.00016/s                       |
| Generative video (last resort)                       | `GOOGLE_VIDEO_MODEL`                                    | `veo-3.1-fast-generate-001`  | see note                  | per second of video; capped per reel                                        |

Sources: the Gemini API models, pricing, changelog and deprecations pages, the Cloud Text-to-Speech and Agent
Platform pricing pages, the `googleapis/python-genai` / `js-genai` changelogs and the `google-gemini/cookbook`
notebooks, read on 2026-10-08 (some `ai.google.dev` pages only through search excerpts — the proxy of the build
environment blocks that host). **Re-check before production**: previews can be retired with two weeks' notice
and 3.8-generation prices double on 2027-01-01.

## Surfaces and authentication

- **Gemini API** — `https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent` (and
  `:batchEmbedContents`), header `x-goog-api-key: $GOOGLE_API_KEY`. Used for Gemini, Gemini image, Lyria 3.5,
  Gemini TTS, embeddings and Veo.
- **Google Cloud** (Cloud TTS v1beta1, Speech-to-Text, Agent Platform) — `Authorization: Bearer
$GOOGLE_CLOUD_ACCESS_TOKEN` (for example `gcloud auth print-access-token`), project `GOOGLE_CLOUD_PROJECT`,
  location `GOOGLE_CLOUD_LOCATION` (default `global`).

One shared client (`packages/providers/src/google`) owns authentication, retries with `Retry-After`, a
process-wide request cap (`GOOGLE_MAX_RPM`), logging with redaction, and cost accounting from the usage the API
reports (thinking tokens are billed at the output rate).

## How each capability is used

- **Director** — receives only a ProductProfile, facts by id, the brand/platform essentials, whitelisted options
  and retrieved assets; returns a small `DirectorDecision` through structured output (`responseMimeType:
application/json` + `responseJsonSchema`, thinking level `minimal`). The decision is validated with zod and
  post-checked (fact ids exist, numbers trace to facts, forbidden phrases); one repair attempt, then the
  deterministic template director.
- **Music (Lyria 3.5)** — the intent (genre, mood, BPM, energy curve, final hit) becomes a deterministic prompt
  with timestamped sections and "Instrumental only, no vocals." Lyria has no duration or seed parameter, so the
  result is fitted locally to the timeline (bar-aligned cut, fade, final hit). Every Lyria output carries a
  SynthID watermark and C2PA metadata. **No Lyria-specific commercial licence was found on official pages**:
  Lyria is therefore skipped for commercial reels until `GOOGLE_MUSIC_COMMERCIAL_USE=true` is set after checking
  your terms; the chain then falls back to cached or local music.
- **Voice** — Gemini TTS (30 prebuilt voices, style direction, Polish/German/French/Spanish/Italian/English).
  Google's TTS models return **no word timestamps**; caption timing comes from a transcription pass or, when exact
  timing matters, from Cloud TTS v1beta1 with an SSML `<mark>` per word (Standard/WaveNet/Neural2 voices only).
- **Embeddings (gemini-embedding-2)** — one vector space for text, images, audio and video. Retrieval uses task
  prefixes ("task: search result | query: …" for queries, "title: … | text: …" for assets). Google notes that
  audio embeddings are optimised for speech, so music/SFX retrieval also uses tags.
- **Images** — Gemini image models for background plates, storyboards and stylised elements only. They are never
  used to depict or edit the product itself: Google gives no guarantee that a product stays unchanged, and the
  factory's product-accuracy rule forbids it.
- **Generative video** — disabled by default (`GENERATIVE_VIDEO_ENABLED=false`, `REEL_MAX_GENERATIVE_VIDEO_SECONDS=0`).
  See docs/REEL_FACTORY.md for the decision ladder.

## Without any Google key

Nothing breaks: each chain falls back to its local provider (template director, deterministic analysis,
template transcreation, local procedural music, Piper TTS + local forced alignment, local SFX, lexical asset
retrieval, deterministic visual QA). The manifest records every fallback and its reason.
