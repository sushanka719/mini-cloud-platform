# ForgeCloud

A visual, locally-hosted miniature cloud / deployment platform — think a tiny, educational Vercel/Netlify/Coolify. You create a project, click **Deploy**, and ForgeCloud queues a job, hands it to a worker, clones and builds the app, streams the logs to your browser in real time, spins up a Docker container, health-checks it, and marks it **LIVE** — with retries, rollback, RBAC and live CPU/memory/queue metrics along the way.

This is a final-year project whose real goal is to learn **Node.js internals** through genuine backend problems: queues, workers, `child_process`, streams, WebSockets, Docker orchestration, graceful shutdown, and multi-process shared state.

> The whole prototype runs on **one laptop** via Docker Compose. That constraint is intentional and does not stop us from demonstrating cloud-style architecture.

## Stack

| Layer | Choice |
|---|---|
| Language | TypeScript (strict) |
| API | Fastify + `pino` |
| Dashboard | Next.js (App Router), React, Tailwind, TanStack Query |
| Realtime | native `ws` (`@fastify/websocket`) + Redis Pub/Sub |
| Queue | BullMQ (Redis-backed) |
| Worker | Node process consuming BullMQ, driving builds via `child_process` |
| Containers | `dockerode` (Docker Engine API) |
| Database | PostgreSQL + Kysely (typed SQL) + `node-pg-migrate` |
| Cache / locks / pubsub | Redis |
| Validation | Zod (shared) |
| Monorepo | pnpm workspaces |

## Repo layout

```
forgecloud/
├── apps/
│   ├── api/          # Fastify HTTP + WebSocket API
│   ├── worker/       # Deployment worker (BullMQ consumer)
│   └── dashboard/    # Next.js dashboard
├── packages/
│   ├── db/           # Kysely client, types, migrations, shared repositories
│   ├── queue/        # Redis connection factory + BullMQ queue/job definitions
│   ├── storage/      # local object store, streamed IO, gzip on worker threads
│   ├── shared/       # Zod schemas, domain types, WS event contracts, constants
│   └── config/       # env parsing (Zod) + logger factory
├── infra/
│   └── docker-compose.yml
├── docs/
│   ├── ARCHITECTURE.md
│   ├── CONVENTIONS.md
│   ├── DATA_MODEL.md
│   └── ROADMAP.md
├── CLAUDE.md
├── PROGRESS.md      # per-phase build log (what's done, decided, verified)
└── README.md
```

## Quick start

```bash
pnpm install
cp .env.example .env                 # defaults work out of the box locally
pnpm infra:up                        # postgres (:5433) + redis (:6380) via docker compose
pnpm --filter @forge/db migrate up   # run migrations
pnpm dev                             # runs api (:4000) + worker + dashboard (:3000)
```

Then open the dashboard at http://localhost:3000 — the health panel should show Postgres and
Redis green. (Container host ports are 5433/6380 so they don't collide with a locally installed
Postgres/Redis on the default ports.)

| Service | URL |
|---|---|
| Dashboard | http://localhost:3000 |
| API | http://localhost:4000 |
| API health | http://localhost:4000/health |

Run a second worker to watch two of them compete for the same queue:

```bash
WORKER_NAME=worker-2 pnpm --filter @forge/worker dev
```

The **Fleet** page in the dashboard shows queue depth and every registered worker.

## Documentation

- **[CLAUDE.md](./CLAUDE.md)** — operating manual for building this repo (read first).
- **[docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)** — components, data flow, deployment pipeline, scaling.
- **[docs/DATA_MODEL.md](./docs/DATA_MODEL.md)** — Postgres schema.
- **[docs/CONVENTIONS.md](./docs/CONVENTIONS.md)** — code style and patterns.
- **[docs/ROADMAP.md](./docs/ROADMAP.md)** — phased build order and milestones.
- **[PROGRESS.md](./PROGRESS.md)** — what is actually built and verified, phase by phase.

## Security note

ForgeCloud **executes untrusted project code**. Container isolation, resource limits, path-traversal and command-injection prevention, and secret handling are core requirements, not afterthoughts. See the Security sections in `CLAUDE.md` and `ARCHITECTURE.md`.
