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
│   ├── proxy/        # hand-written reverse proxy in front of the API replicas
│   └── dashboard/    # Next.js dashboard
├── packages/
│   ├── db/           # Kysely client, types, migrations, shared repositories
│   ├── queue/        # Redis connection factory + BullMQ queue/job definitions
│   ├── storage/      # local object store, streamed IO, gzip on worker threads
│   ├── metrics/      # process sampling (perf_hooks) + Prometheus rendering
│   ├── shared/       # Zod schemas, domain types, WS event contracts, constants
│   └── config/       # env parsing (Zod) + logger factory
├── examples/
│   └── hello-forge/  # zero-dependency sample app to deploy through ForgeCloud
├── infra/
│   └── docker-compose.yml
├── scripts/
│   └── cluster.mjs   # runs N api replicas + M workers + the proxy, with kill/stop/start
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

Then deploy something. Pack the sample app, upload it in the project's **Source** panel and hit
**Deploy** — the worker unpacks it into a sandbox, runs `npm install` and `npm run build` under
`spawn(shell:false)`, and streams the real output to the browser:

```bash
tar -czf /tmp/hello-forge.tgz -C examples hello-forge   # or: (cd examples && zip -qr /tmp/hello-forge.zip hello-forge)
```

Builds run under `BUILD_ROOT` (`./builds` by default), one sandbox per deployment attempt, removed
when it finishes. See [examples/README.md](./examples/README.md).

Then open the dashboard at http://localhost:3000 — the health panel should show Postgres and
Redis green. (Container host ports are 5433/6380 so they don't collide with a locally installed
Postgres/Redis on the default ports.)

| Service | URL |
|---|---|
| Dashboard | http://localhost:3000 |
| API | http://localhost:4000 |
| API health | http://localhost:4000/health |

## Running a fleet

`pnpm dev` is one API and one worker. To run the horizontally-scaled version — several API replicas
behind the reverse proxy, several workers competing for the same queue:

```bash
pnpm cluster                    # 2 api replicas + 2 workers + proxy (:4100) + dashboard (:3000)
pnpm cluster --api 3 --workers 3
```

The dashboard is pointed at the proxy, so it talks to one address and has no idea how many API
processes are behind it. Sessions are opaque tokens in Redis, so there is no sticky routing.

`pnpm cluster` reads commands on stdin while it runs:

| Command | What it does |
|---|---|
| `list` | every process, with pids |
| `kill worker-2` | **SIGKILL** — the crash demo. Nothing is recorded; the heartbeat key expires on its own, BullMQ returns the job to the queue when its lock lapses (~30–45s), and another worker takes the deployment over and starts it again. Watch the timeline say so. |
| `stop worker-2` | **SIGTERM** — the graceful-shutdown demo. The worker drains: it stops taking jobs, aborts its builds, records them as failed, and the retry lands elsewhere within seconds. |
| `start worker-2` | bring a stopped one back |
| `quit` | SIGTERM everything and exit |

The same works for `api-1` — kill a replica and the proxy drops it from rotation on the failed
request itself, retrying that request on a survivor, so the browser sees no error.

The **Fleet** page in the dashboard shows all of it: the proxy's request split and which replica
served your last request, a card per API replica (marking the one holding your WebSocket), queue
depth, every worker with its build history, and the dead-letter queue.

| Service | URL |
|---|---|
| Proxy | http://localhost:4100 |
| Proxy status | http://localhost:4100/__forge/proxy |
| API replicas | http://localhost:4001, :4002, … |

## Documentation

- **[CLAUDE.md](./CLAUDE.md)** — operating manual for building this repo (read first).
- **[docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)** — components, data flow, deployment pipeline, scaling.
- **[docs/DATA_MODEL.md](./docs/DATA_MODEL.md)** — Postgres schema.
- **[docs/CONVENTIONS.md](./docs/CONVENTIONS.md)** — code style and patterns.
- **[docs/ROADMAP.md](./docs/ROADMAP.md)** — phased build order and milestones.
- **[PROGRESS.md](./PROGRESS.md)** — what is actually built and verified, phase by phase.

## Security note

ForgeCloud **executes untrusted project code**. Container isolation, resource limits, path-traversal and command-injection prevention, and secret handling are core requirements, not afterthoughts. See the Security sections in `CLAUDE.md` and `ARCHITECTURE.md`.
