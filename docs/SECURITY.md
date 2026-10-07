# Security, privacy and compliance

## Secrets

- Secrets live only in environment variables. `.env.example` documents every variable without values; `.env*`
  files are git-ignored. `packages/config` is the only code that reads `process.env`, validated with Zod.
- Third-party credentials obtained in the app (Meta/TikTok OAuth tokens) are encrypted at rest with
  **AES-256-GCM** using `CREDENTIALS_ENCRYPTION_KEY` (32 random bytes, base64: `openssl rand -base64 32`). Each
  ciphertext stores its key version for rotation. Tokens are decrypted only inside server code that needs them
  (publishing, analytics) and are never logged or sent to the browser; the UI shows masked metadata only.
- Provider errors and logs strip query strings (signatures, tokens) from URLs.

## Authentication and authorization

| Control          | Implementation                                                                                                                                                                                                             |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Passwords        | scrypt (N=16384, r=8, p=1, 64-byte key, random salt), constant-time comparison                                                                                                                                             |
| Sessions         | Random token in an `httpOnly`, `SameSite=Lax` cookie (`Secure` in production), 30-day lifetime; only its SHA-256 is stored, so a database leak does not leak sessions                                                      |
| Login throttling | 8 attempts per 15 minutes per IP + e-mail (in-memory; use a shared limiter for multiple web instances)                                                                                                                     |
| Roles            | `OWNER`, `ADMIN` (settings, OAuth, budgets), `EDITOR` (content decisions), `VIEWER` (read-only)                                                                                                                            |
| Authorization    | Server-side in every page, server action and route handler: session → membership → role → the entity belongs to the user's workspace. `proxy.ts` only redirects signed-out visitors (optimistic, not a security boundary). |
| Input validation | Zod schemas for server actions, route handlers, postbacks and CSV imports                                                                                                                                                  |
| Media            | `/api/assets/:id` streams only READY assets of the user's workspace; S3/R2 objects via 5-minute presigned URLs                                                                                                             |
| Headers          | `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy`; no `X-Powered-By`                                                                    |

Public endpoints are limited to: `/login`, `/go/:code`, `/b/:slug`, `/api/webhooks/*` (token-authenticated),
`/api/oauth/*/callback` (state-verified, session required) and `/api/health`.

## OAuth connections

- Only owners/admins can start a connection, and only for a brand of their workspace.
- The OAuth `state` is a random nonce bound to (user, brand, provider), HMAC-signed into a 10-minute `httpOnly`
  cookie scoped to `/api/oauth`; the callback rejects any mismatch.
- Requested scopes are the minimum for publishing and insights (see [SOCIAL_APIS.md](SOCIAL_APIS.md)).
- Disconnecting an account removes the credential link (revoking the credential when no other account uses it);
  its scheduled publications are marked `ACCOUNT_DISCONNECTED` and cannot be published.

## Click tracking and personal data

The tracking redirect `/go/<code>` is designed for data minimisation:

| Stored                                                                                                                 | Never stored                      |
| ---------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| Link, content, brand, platform, product, campaign, UTM parameters                                                      | Raw IP address                    |
| Referrer **host** only                                                                                                 | Full user-agent string            |
| Device type, OS family, browser family                                                                                 | Cookies or cross-site identifiers |
| Country from a trusted CDN header (if present)                                                                         | Precise location                  |
| Visitor hash: HMAC(secret, day + IP + user agent), truncated — rotates daily, cannot be reversed or linked across days |                                   |

- Bots and link-preview crawlers are flagged and excluded from metrics; `HEAD` requests (previews, uptime checks)
  are never counted.
- A visitor IP is limited to 30 recorded clicks per link per minute; beyond that people are still redirected
  but clicks are not recorded (protects metrics and the database from click floods). The limiter uses
  `X-Forwarded-For` — run the app behind a proxy/CDN that sets it.
- `TRACKING_HASH_SECRET` keeps visitor hashes stable across restarts; without it a per-process random secret is
  used (unique-visitor counts reset on restart, nothing linkable is stored).
- Redirect responses are `no-store` and `noindex`. A parameter already present in an affiliate URL is never
  overwritten (it may be the affiliate id that pays).
- **Conversion postbacks and CSV imports** keep ids, amounts and statuses for attribution and audit; keys and
  values that look like buyer data (e-mail, names, phone, address, IP, customer ids, card data) are redacted
  before storage.

Other personal data: user accounts (e-mail, name, password hash) and sessions. No social-media audience data is
collected beyond aggregate platform metrics.

## Postback webhooks

`/api/webhooks/conversions/<programId>` (GET or POST):

- authenticated with a per-program token (header `x-postback-token` or `token` query parameter); only the token's
  SHA-256 is stored; constant-time comparison;
- 64 KB body limit, 600 requests per minute per program;
- idempotent per (program, external transaction id) — repeats update status/amount and book adjustments;
- currencies other than USD require a configured rate (`FX_RATES_USD`); unknown currencies are rejected, never
  guessed.

## Safety switches against unintended spend or posting

| Switch                                 | Default     | Effect                                                                           |
| -------------------------------------- | ----------- | -------------------------------------------------------------------------------- |
| `MOCK_AI`, `MOCK_MEDIA`, `MOCK_SOCIAL` | `true`      | No external calls, no spend, nothing leaves the machine                          |
| `PUBLISHING_ENABLED`                   | `false`     | Refuses every real publication, even for approved content and connected accounts |
| `TIKTOK_PRIVACY_LEVEL`                 | `SELF_ONLY` | TikTok posts are private                                                         |
| Budgets + `HARD_DAILY_BUDGET_USD`      | seeded      | Paid calls that would exceed a limit are not executed                            |
| Human approval                         | always      | Nothing is scheduled without an explicit approval                                |
| Unknown publish outcome                | —           | A post interrupted mid-flight is never automatically re-posted (no duplicates)   |
| Rejected tokens                        | —           | Account flagged `NEEDS_REAUTH`; no further attempts until reconnected            |

The worker logs its safety configuration (mock flags, publishing switch, hard cap, providers) at start-up.

## Content compliance

- **Claims come from stored facts only.** Products carry facts with their source and verification date; prompts
  forbid invented features, prices, reviews and results; QA blocks unsupported superlatives, guarantees,
  medical/clinical, safety, income and scarcity claims and "free" offers that no fact supports, plus stale or
  unsourced prices.
- **No fake reviews, testimonials or fabricated experiences.** Every prompt forbids invented reviews,
  testimonials and personal experiences ("I tried", "my skin", "we tested"); the optional LLM QA review checks
  for them as well.
- **Affiliate relationships are disclosed, never hidden.** Per-brand/per-platform disclosure rules (`#ad`,
  affiliate statements, program-specific text such as Amazon's) are placed at the caption start/end and on
  screen; a missing or non-prominent disclosure is a QA blocker. On TikTok, affiliate posts that are visible to
  others also set the branded-content toggle.
- **AI-generated content** is labelled where the platform supports it (TikTok `is_aigc`) and via disclosure rules
  elsewhere.
- **Licensing**: music is generated procedurally; every asset records its source and licence.

## Operational recommendations

- Serve the app over HTTPS only (secure cookies depend on `NODE_ENV=production`).
- Keep PostgreSQL and Redis private (no public ports); Redis with `maxmemory-policy noeviction`.
- Back up PostgreSQL; object storage holds media only.
- `CREDENTIALS_ENCRYPTION_KEY` rotation: each credential stores its key version, but only one key is configured
  at a time — after changing the key, reconnect the social accounts (or re-encrypt with a one-off script).
- Not yet implemented: a Content-Security-Policy header, multi-instance rate limiting (Redis), audit-log export,
  2FA for owner accounts.
