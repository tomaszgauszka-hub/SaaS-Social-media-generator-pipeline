# Architecture

Content Revenue Engine turns product data into short vertical videos, publishes them, measures what happens
and feeds the results back into what gets made next. Everything is optimised for one chain:

**CONTENT → ATTENTION → CLICK → CONVERSION → REVENUE**, at the lowest generation cost that still works.

The owner's recurring job is to **approve, reject or regenerate**. Everything else is automated, budget-guarded
and logged.

## System overview

```mermaid
flowchart TD
    SRC[Products & offers<br/>manual · CSV] --> OPP
    PROF[(Brand performance profile)] --> OPP
    OPP[Opportunity scoring<br/>estimated CTR · CVR · value · cost · novelty] --> IDEAS[Ideas]
    IDEAS --> RES[Research brief] --> SCR[Script + visual plan<br/>DeepSeek · strict JSON · Zod]
    SCR --> ROUTE[MediaGenerationRouter<br/>Tier 0–3 with reasons]
    ROUTE --> GUARD{BudgetGuard<br/>reserve before every paid call}
    GUARD -->|fits| ASSETS[Assets<br/>product cut-outs · generated images · optional AI shot · TTS · music]
    GUARD -->|exceeds| BB[BUDGET_BLOCKED<br/>resumes when budget allows]
    ASSETS --> RENDER[FFmpeg compositor<br/>JSON VideoProject → 1080×1920 MP4]
    RENDER --> QA[Automated QA<br/>0–100 score, blockers, one auto-fix]
    QA --> APPR[Approval queue<br/>mobile: approve · reject · regenerate · edit]
    APPR --> SCHED[Scheduler<br/>brand slots per platform]
    SCHED --> PUB[SocialPublisher<br/>Mock · Meta · TikTok]
    PUB --> SNAP[(Analytics snapshots<br/>append-only time series)]
    PUB -.caption / bio link.-> GO["/go/:code redirect"]
    GO --> CLK[(Clicks — privacy-minimised)]
    CLK --> CONV[(Conversions & revenue<br/>manual · CSV · postback)]
    SNAP --> LEARN[Learning loop]
    CONV --> LEARN
    LEARN --> PROF
```

## Runtime topology

```mermaid
flowchart LR
    OWNER[Owner<br/>phone / desktop] --> WEB
    VISITOR[Social media visitor] --> WEB
    NET[Affiliate network] -->|postback| WEB
    WEB[apps/web<br/>Next.js dashboard · route handlers] -->|state + job rows| PG[(PostgreSQL)]
    WRK[apps/worker<br/>outbox dispatcher · BullMQ processors · maintenance tick] --> PG
    WRK <--> RD[(Redis<br/>BullMQ)]
    WRK --> FF[FFmpeg / ffprobe]
    WRK --> API[DeepSeek · fal.ai · TTS · Meta · TikTok]
    WRK --> ST[(Object storage<br/>local FS · S3 / R2)]
    WEB --> ST
```

- **Two processes, one database.** The web app never does heavy work; it writes state and job rows. The worker
  executes jobs. The web app does not need Redis.
- **PostgreSQL is the source of truth**, including for jobs. Redis only transports work; losing Redis loses no
  work (see [Jobs](#jobs-and-queues)).
- **Media lives in object storage**; rows keep storage keys and provenance only.

## Monorepo

| Path                  | Responsibility                                                                                                                                                                                                                  |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web`            | Next.js 16 dashboard (all pages), mobile approval UI, `/go/:code` tracking redirect, `/b/:slug` bio pages, postback webhooks, OAuth start/callback, authenticated media streaming, health endpoint.                             |
| `apps/worker`         | Worker process (`pnpm worker`) and the end-to-end mock demo (`pnpm demo`).                                                                                                                                                      |
| `packages/shared`     | Money in micro-USD, error taxonomy (retryable / fatal / budget-blocked), logger, hashing & AES-GCM, text similarity, time helpers.                                                                                              |
| `packages/config`     | The only place that reads `process.env` (Zod-validated), provider selection, model catalog, pricing catalog, tier plans, job defaults.                                                                                          |
| `packages/db`         | Prisma 7 schema and migrations, client factory, seed data (Demo Beauty / Demo Tools / Demo SaaS).                                                                                                                               |
| `packages/ai`         | `LLMProvider` (DeepSeek default, any OpenAI-compatible API, mock), versioned prompts, structured output with a Zod repair loop.                                                                                                 |
| `packages/providers`  | Image, image-to-video, background removal, TTS, music and storage providers — real adapters and free local mocks.                                                                                                               |
| `packages/media`      | `VideoProject` schema, FFmpeg timeline compositor, libass kinetic typography, scene renderers, ffprobe/QA probes.                                                                                                               |
| `packages/publishing` | `SocialPublisher` (mock, Meta, TikTok), OAuth helpers, platform limits.                                                                                                                                                         |
| `packages/analytics`  | Pure metric math (CTR, RPM, ROI, profit), latest-snapshot aggregation, performance evidence levels, performance profiles.                                                                                                       |
| `packages/core`       | Domain services shared by web and worker: state machines, cost ledger & BudgetGuard, router, opportunity scoring, text QA, approval & regeneration, scheduling, tracking links, revenue import, job outbox, KPI/profit reports. |
| `packages/pipeline`   | Step executors (one per job type), job runner, inline and BullMQ dispatchers, A/B experiments, learning loop.                                                                                                                   |

Dependency direction has no cycles: `shared ← config ← db ← analytics ← core ← pipeline ← worker`;
`ai`, `providers`, `media` and `publishing` depend only on `shared`/`config` (+ `media` for probing). The web app
depends on `core` (plus `publishing` for OAuth and `providers` for storage). Packages are consumed as TypeScript
source — there is no build step in development.

## Data model

Full definitions: `packages/db/prisma/schema.prisma`. Money is `Decimal(18,6)` USD in the database and integer
micro-USD in code. Rows created by mocks carry `isMock` / `isSimulated` so simulated numbers can never be
mistaken for real money.

```mermaid
erDiagram
    Workspace ||--o{ Brand : owns
    Brand ||--o{ SocialAccount : publishes_to
    Brand ||--o{ PublishingSlot : schedules
    Brand ||--o{ DisclosureRule : complies_with
    Brand ||--o{ Product : promotes
    Product ||--o{ Offer : sold_via
    AffiliateProgram ||--o{ Offer : pays
    Offer ||--o{ AffiliateLink : resolves_to
    Brand ||--o{ ContentIdea : proposes
    ContentIdea ||--o| OpportunityScore : estimated_by
    ContentIdea ||--o{ ContentProject : becomes
    ContentProject ||--o{ Scene : contains
    ContentProject ||--o{ Asset : generates
    ContentProject ||--o{ ContentVariant : adapts_to
    ContentVariant ||--o{ Publication : published_as
    Publication ||--o{ AnalyticsSnapshot : measured_by
    ContentVariant ||--o| TrackedLink : links_via
    TrackedLink ||--o{ Click : records
    Click ||--o{ Conversion : attributes
    Conversion ||--o{ RevenueEntry : books
    ContentProject ||--o{ GenerationJob : runs
    GenerationJob ||--o{ JobEvent : logs
    GenerationJob ||--o{ GenerationUsage : costs
    ContentProject ||--o{ Experiment : tests
    Brand ||--o{ BrandPerformanceProfile : learns
```

Key separations the model enforces:

- **Idea ≠ master creative ≠ platform variant ≠ publication.** One `ContentProject` (master video) fans out to one
  `ContentVariant` per platform (caption, hashtags, disclosure, tracked link) and each variant to `Publication`s.
- **Estimates ≠ actuals.** `OpportunityScore` holds estimates; `AnalyticsSnapshot`, `Click`, `Conversion` and
  `RevenueEntry` hold measurements. `GenerationUsage` keeps `estimatedCostUsd` and `actualCostUsd` side by side.
- **Snapshots are never overwritten.** Platforms report cumulative metrics, so reports use the latest snapshot per
  publication; the history stays for time-series charts.
- **Provenance per asset**: source, provider, model, prompt, inputs (`AssetInput`), cost, licence, timestamps.

## State machines

All status changes go through table-driven state machines (`packages/core/src/lifecycle/state-machine.ts`) and
are applied with optimistic concurrency (`UPDATE … WHERE status = $from`); a lost race raises
`StateConflictError` instead of silently overwriting. Each transition is audited.

```mermaid
stateDiagram-v2
    [*] --> IDEA
    IDEA --> RESEARCHING
    RESEARCHING --> SCRIPTING
    SCRIPTING --> ASSET_PLANNING
    ASSET_PLANNING --> GENERATING_ASSETS
    GENERATING_ASSETS --> RENDERING
    RENDERING --> QA
    QA --> WAITING_APPROVAL: passed
    QA --> REJECTED: auto-reject
    WAITING_APPROVAL --> APPROVED
    WAITING_APPROVAL --> REJECTED
    WAITING_APPROVAL --> SCRIPTING: regenerate script / hook / caption
    WAITING_APPROVAL --> GENERATING_ASSETS: regenerate image / scene / voice, edit on-screen text
    WAITING_APPROVAL --> QA: edit caption
    REJECTED --> SCRIPTING: regenerate
    APPROVED --> SCHEDULED
    SCHEDULED --> PUBLISHING
    PUBLISHING --> PUBLISHED
    PUBLISHED --> ANALYTICS_PENDING
    ANALYTICS_PENDING --> ARCHIVED
    GENERATING_ASSETS --> BUDGET_BLOCKED
    BUDGET_BLOCKED --> GENERATING_ASSETS: budget available
    RENDERING --> FAILED
    FAILED --> RENDERING: retry
```

Simplified: every working state can move to `FAILED` (and paid states to `BUDGET_BLOCKED`); both remember where to
resume. Variants, publications and jobs have their own machines:

- `ContentVariant`: `PENDING → READY → APPROVED | REJECTED | SKIPPED → SCHEDULED → PUBLISHING → PUBLISHED | FAILED`
- `Publication`: `SCHEDULED → PUBLISHING → PUBLISHED | FAILED`, `FAILED → SCHEDULED` (retry), `CANCELLED`
- `GenerationJob`: `QUEUED → DISPATCHED → RUNNING → SUCCEEDED | RETRYING | FAILED | DEAD_LETTER | BUDGET_BLOCKED`

## Jobs and queues

```mermaid
sequenceDiagram
    participant W as Web / handler
    participant DB as PostgreSQL
    participant D as Dispatcher (worker)
    participant Q as BullMQ (Redis)
    participant R as Job runner
    W->>DB: state change + GenerationJob row (one transaction)
    loop every DISPATCHER_POLL_MS
        D->>DB: claim due QUEUED rows (FOR UPDATE SKIP LOCKED)
        D->>Q: add(jobId = row id + attempt)
    end
    Q->>R: deliver
    R->>DB: QUEUED/DISPATCHED/RETRYING → RUNNING (conditional update)
    R->>R: handler with timeout + AbortSignal
    alt success
        R->>DB: SUCCEEDED + next job rows
    else retryable error
        R->>DB: RETRYING (exponential backoff, runAt in the future)
    else fatal / attempts exhausted
        R->>DB: FAILED / DEAD_LETTER (manual retry in /jobs)
    else BudgetBlockedError
        R->>DB: BUDGET_BLOCKED (never retried automatically)
    end
```

- **Transactional outbox.** A job row is written in the same transaction as the state change that needs it, keyed
  by an `idempotencyKey` (`ON CONFLICT DO NOTHING`). Redis loss or a crash never loses or duplicates work.
- **Idempotent handlers.** Re-delivering a job is a no-op: assets are content-addressed (a READY asset with the same
  input hash is reused, never re-bought), async provider requests persist their request id before polling so a
  restarted worker resumes instead of paying twice, and cost rows are keyed per operation.
- **Fan-out / fan-in.** One job per asset; rendering starts when all assets are READY, guarded by a row lock on
  the project.
- **Queues** (`QUEUE_NAMES`): `strategy`, `research`, `scripts`, `images`, `video_generation`, `tts`, `render`,
  `qa`, `publish`, `analytics`, `maintenance`; final failures are mirrored to `dead_letter`. Heavy queues can run in
  separate worker processes: `WORKER_QUEUES=render pnpm worker`.
- **Observability.** Every job writes `START / SUCCESS / FAILURE / RETRY / COST` events (pino JSON logs with
  `runId`, `brandId`, `contentId`, `jobId`) and mirrors them into `JobEvent` for the dashboard timeline (`/jobs`,
  `/content/[id]`).
- **Inline dispatcher.** The same handlers run in-process with a simulated clock — used by tests and `pnpm demo`,
  no Redis needed.

## Providers

Business code depends on interfaces only; `packages/config` decides which implementation and model is used.
Every provider exposes `healthCheck`, `estimateCost` and `execute`. Details: [PROVIDERS.md](PROVIDERS.md).

## Money and safety rails

1. **Estimate → reserve → execute → commit/release** for every paid call (`CostLedger` + `BudgetGuard`). If any
   budget would be exceeded the call does not happen; the job becomes `BUDGET_BLOCKED` with machine-readable
   reasons. See [COST_MODEL.md](COST_MODEL.md).
2. **Tiered generation.** Unproven ideas get Tier 0 (cents); premium spend requires measured performance.
3. **Mock mode by default.** `MOCK_AI`, `MOCK_MEDIA`, `MOCK_SOCIAL` default to `true` and still produce real
   files, so the compositor, QA, dashboard and analytics run end to end for free.
4. **Publishing kill switch.** `PUBLISHING_ENABLED=false` (default) refuses every real publication, even with
   connected accounts and an approved item.
5. **Human approval** before anything is scheduled.

## Learning loop

```mermaid
flowchart LR
    SNAP[(Snapshots)] --> REC[Per-post records<br/>impressions · clicks · revenue · completion]
    CLK[(Clicks)] --> REC
    REV[(Revenue)] --> REC
    REC --> PROF[BrandPerformanceProfile<br/>hook style · angle · CTA · duration · template · product · time · platform · tier]
    PROF -->|prompt text| LLM[Ideation & script prompts]
    REC --> EVID[Evidence level per product<br/>UNPROVEN → PROVEN_WINNER]
    EVID --> ROUTER[Tier router]
    EXP[A/B experiments<br/>hook or caption opening] --> REC
```

No machine learning: the profile compares each dimension value against the brand baseline (RPM once there is
revenue, CTR before) with a minimum sample size, and the strongest/weakest patterns are injected into prompts.
Experiments vary one cheap variable on shared assets and are decided conservatively (see
[PIPELINE.md](PIPELINE.md#ab-experiments)).

## Security

Server-side sessions and authorization on every page, action and route; encrypted third-party credentials;
privacy-minimised click tracking; signed OAuth state; authenticated postbacks. See [SECURITY.md](SECURITY.md).
