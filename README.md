# Content Revenue Engine

Automated multi-brand **content → distribution → analytics → revenue** engine for Instagram, Facebook and TikTok.

> Status: under active development. See [`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md).

## Quick start

```bash
pnpm install                 # also generates the Prisma client
cp .env.example .env         # defaults are SAFE: mock providers, publishing disabled
docker compose up -d         # PostgreSQL + Redis
pnpm db:migrate              # apply migrations
pnpm db:seed                 # Demo Beauty / Demo Tools / Demo SaaS
```

## Commands

| Command                        | Purpose                                                |
| ------------------------------ | ------------------------------------------------------ |
| `pnpm dev`                     | Next.js dashboard on http://localhost:3000             |
| `pnpm worker`                  | Background worker (job dispatcher + BullMQ processors) |
| `pnpm test`                    | Unit tests                                             |
| `pnpm test:integration`        | Integration tests (PostgreSQL required)                |
| `pnpm typecheck` / `pnpm lint` | Static checks                                          |
