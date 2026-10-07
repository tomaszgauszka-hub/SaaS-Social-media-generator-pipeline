# Local-first AI policy

**Local first. Cache first. Reuse first. AI only where semantic intelligence is actually needed.**

## What never uses AI

| Step                                                       | How it is done                                                         |
| ---------------------------------------------------------- | ---------------------------------------------------------------------- |
| Creative direction (structure, beats, pacing, transitions) | deterministic director, style kits, structure recipes                  |
| Layout, typography, text fitting, safe zones               | layout grid + fontkit measurement with the renderer's own font files   |
| Motion graphics, transitions, overlays                     | Remotion compositions rendered by a local headless Chromium            |
| Music and sound design                                     | deterministic synthesis (seeded DSP)                                   |
| Loudness, encoding, muxing, posters                        | FFmpeg                                                                 |
| Technical QA                                               | FFmpeg probes + local frame statistics (luma, frame difference, dHash) |
| Creative / factual / compliance / localization QA          | deterministic rules and scores                                         |
| Number and date formatting per locale                      | `Intl`                                                                 |

The Creative Engine V2 benchmark renders six complete reels with **0 AI tokens** and **$0 external generation
cost** (see `/creative-benchmark` and `.data/benchmark/report.json`).

## Where AI is allowed (and how much)

| Need                                        | Phase | Budget rule                                                                                 |
| ------------------------------------------- | ----- | ------------------------------------------------------------------------------------------- |
| Master creative copy (hook, features, CTA)  | G     | **one batched, schema-validated call per product master**, cached by input hash             |
| Transcreation of a master into a new locale | K/L   | translation memory + brand glossary first; only unseen strings go to the model, then cached |
| Product research summaries                  | G     | existing cached research step; reused across markets and variants                           |
| Generated imagery / AI video                | —     | never before an idea has performance evidence (tier rules in `COST_MODEL.md`)               |
| Voice-over                                  | G     | only after the master is approved                                                           |

Rules that hold for every model call:

1. A deterministic implementation is preferred whenever one exists.
2. Every call has a schema, a cache key (normalised input hash + prompt version) and a budget check.
3. Cached outputs are reused across variants, markets and re-renders; a re-render never re-asks a model.
4. Avoided calls (cache hits, deterministic replacements) are counted so the saving is visible.

Phase G adds the `AiUsageRecord` view, the `LlmOutputCache` and a `/settings/ai-usage` page with tokens, cache
hit rate and avoided calls per step.
