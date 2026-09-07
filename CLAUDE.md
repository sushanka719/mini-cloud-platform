# CLAUDE.md

Operating manual for working on **ForgeCloud**. Read this before touching code. If anything here conflicts with a file you're editing, prefer this file and flag the conflict.

---

## 1. What we're building

ForgeCloud is a miniature, locally-hosted deployment platform (a tiny Vercel/Coolify). A user creates a project and deploys it; the system queues a job, a worker builds it, streams logs live to the browser, runs it in a Docker container, health-checks it, and marks it LIVE — with retries, rollback, RBAC and live metrics.

It is a **final-year learning project**. The point is to exercise real Node.js internals (queues, workers, `child_process`, streams, WebSockets, Docker orchestration, graceful shutdown, multi-process shared state). It is explicitly **not** a production Vercel clone.

Full context lives in `docs/ARCHITECTURE.md`, `docs/DATA_MODEL.md`, `docs/CONVENTIONS.md`, `docs/ROADMAP.md`.

---

## 2. Operating mode: **build fast**

The user has asked for fast execution over teaching. That means:

- **Write complete, working, runnable code.** No `// TODO: implement`, no pseudo-code stubs, no "you could add X here." If a function is referenced, it exists.
- **Don't stop to explain concepts** unless the user asks "why" or "explain." A one-line comment on genuinely non-obvious code is fine; a tutorial paragraph is not.
- **Make reasonable decisions and keep moving.** When a small choice is ambiguous (a column name, a folder, a status string), pick the sensible option, note it in one line, and continue. Only stop to ask when a choice is expensive to reverse (schema shape, auth model, queue semantics, public API contract).
- **Prefer established libraries** over hand-rolling, *except* where the blueprint's learning goal is the whole point (see §4).
- **Deliver in vertical slices.** A task should end with something runnable end-to-end, not five disconnected files.
- **State assumptions inline, briefly.** e.g. "Assuming health check = HTTP 200 on `/` within 30s; configurable per project."

Keep prose tight. The user wants code and momentum.

---

## 3. Tech stack (do not swap without asking)

- **TypeScript**, strict mode, ESM.
- **Fastify** for the API (HTTP + WebSocket). Use Fastify plugins for encapsulation; use its schema validation with **Zod** (via `fastify-type-provider-zod`).
- **Next.js** (App Router) + React + Tailwind + **TanStack Query** for the dashboard.
- **PostgreSQL** via **Kysely** (typed query builder — write SQL, get types). Migrations with **`node-pg-migrate`**. No heavyweight ORM.
- **Redis** for cache, Pub/Sub, rate limiting, distributed locks, and shared state.
- **BullMQ** (Redis-backed) for the job queue — gives retries, backoff, delayed jobs, and dead-letter handling.
- **dockerode** for the Docker Engine API (create/start/stop/remove containers, stream logs, set resource limits).
- **`child_process`** (`spawn`) for running install/build commands and capturing stdout/stderr streams.
- **`worker_threads`** for CPU-bound work (artifact compression via `node:zlib`, checksums).
- **`ws`** (through `@fastify/websocket`) for realtime; fan out across API instances with Redis Pub/Sub.
- **pino** for structured logging (Fastify default).
- **argon2** for password hashing; opaque session tokens in Redis; hashed API keys in Postgres.
- **pnpm** workspaces monorepo.
- Tests (when written): **Vitest** + Fastify `.inject()`.

If a task seems to need a library not listed here, add it — but pick the boring, well-maintained option and say why in one line.

---

## 4. Where we deliberately go low-level (learning goals — do NOT over-abstract these)

These are the parts the project exists to teach. Keep them hand-written and visible, not buried under a library:

- **Realtime layer** — own the `ws` connection lifecycle, message framing, channel/subscription logic, and Redis Pub/Sub fan-out. Don't reach for Socket.IO.
- **Build execution** — drive `child_process.spawn` ourselves, pipe stdout/stderr as streams, handle backpressure, timeouts, and process kill/cleanup.
- **Log streaming** — real Node `Readable`/`Writable` streams and `Buffer` handling from process → Redis → WebSocket → browser. No shortcut buffering-everything-into-a-string.
- **Container orchestration** — call the Docker API through `dockerode` directly; manage the container lifecycle, log stream demux, resource limits, and cleanup ourselves.
- **Graceful shutdown** — real `SIGTERM`/`SIGINT` handlers: stop accepting work, drain in-flight jobs/connections, close DB/Redis/Docker handles, then exit.
- **Observability** — measure event-loop lag (`perf_hooks.monitorEventLoopDelay`), CPU/memory (`process.cpuUsage`, `process.memoryUsage`), queue depth, deployment duration ourselves and expose them.
- **Multi-process shared state** — never keep authoritative state in process memory; it lives in Postgres/Redis so multiple API/worker processes agree.

BullMQ (queue) and Kysely (DB) are the two acceptable "framework" conveniences because the learning value there is lower and the correctness risk of hand-rolling is high.

---

## 5. Commands

```bash
pnpm install                                   # install all workspaces
docker compose -f infra/docker-compose.yml up -d   # postgres + redis (+ optional extra API/worker replicas)
pnpm --filter @forge/db migrate up             # apply migrations
pnpm --filter @forge/db migrate create <name>  # new migration
pnpm dev                                        # run api + worker + dashboard together
pnpm --filter @forge/api dev                    # run just the API
pnpm --filter @forge/worker dev                 # run just a worker
pnpm build                                       # build all
pnpm test                                        # run tests
pnpm typecheck                                   # tsc --noEmit across workspaces
pnpm lint                                         # eslint
```

(If a script doesn't exist yet, add it to the relevant `package.json` as part of the task.)

---

## 6. Architecture in one breath

```
Browser → Next.js dashboard → Fastify API → Postgres / Redis / WebSocket
                                   │
                                   └── enqueue job (BullMQ) → Worker
                                                                 │
                                        child_process build ── dockerode ── Deployment container
                                                                 │
                                             logs/status → Redis Pub/Sub → WebSocket → Browser
```

- The **API** owns HTTP, auth, WebSockets, and enqueues deployment jobs. It never runs builds itself.
- The **worker** consumes jobs and runs the pipeline: clone/copy → install → build → artifact → container → health check → LIVE/FAILED.
- **Postgres** is the source of truth. **Redis** is queue + pub/sub + cache + locks. Progress and logs flow worker → Redis → API WebSocket → browser.

See `docs/ARCHITECTURE.md` for the full picture and the deployment state machine.

---

## 7. Deployment lifecycle (canonical statuses)

`queued → assigned → cloning → installing → building → creating_container → starting → health_check → live`
Terminal/other: `failed`, `stopped`, `rolled_back`, `canceled`.

Rules:
- Every status transition is **persisted to Postgres** and **published to Redis** (`deployment:<id>` channel) so the dashboard updates live.
- Transitions are **append-only events** in `deployment_events` *and* a denormalized `status` column on `deployments` for quick reads.
- A deployment is **idempotent per (project_id, source_ref, idempotency_key)** — duplicate deploy clicks must not create duplicate live containers.

---

## 8. Non-negotiable security rules (we execute untrusted code)

- **Never** interpolate user input into a shell. Use `spawn(cmd, argsArray)` with `shell: false`. No `exec` with string concatenation.
- Resolve and **validate every filesystem path** against the project's sandbox root; reject anything escaping it (`..`, absolute paths, symlinks out).
- Run builds and apps in **Docker with limits**: memory cap, CPU quota, `--pids-limit`, no host network by default, dropped capabilities, read-only root FS where feasible, non-root user inside the container.
- **Secrets** (env vars marked secret, API keys, passwords) are never logged, never returned in API responses in plaintext, and stored encrypted/hashed at rest.
- Every mutating endpoint: **authn + authz (RBAC) + input validation (Zod) + rate limit**.
- Sanitize/limit log output size and upload size; enforce timeouts on every external/child operation.

If a change would weaken any of these, stop and flag it.

---

## 9. Definition of done for a task

A task is done when:
1. It **runs** (`pnpm dev` and the relevant flow works end-to-end).
2. `pnpm typecheck` passes — no `any` smuggling, no ignored errors.
3. New DB changes ship with a **migration** and updated Kysely types.
4. New state transitions are **persisted + published** (see §7).
5. Errors are handled (see §10) — no silent catches, no unhandled rejections.
6. Anything user-facing in the pipeline is **visible on the dashboard** (status, logs, or metric) — this is a visual-first project.

---

## 10. Error handling & resilience

- Use a typed `AppError` with a code, HTTP status, and safe message (see `docs/CONVENTIONS.md`). One error-handling plugin in Fastify maps errors → responses and logs the internals.
- Child processes and Docker ops: always handle `error`, non-zero exit, and timeout; always clean up (kill process, remove container) on failure.
- Jobs: configure BullMQ retries with backoff; after max attempts, move to a **dead-letter** queue and mark the deployment `failed` with the captured reason.
- Redis/Postgres unavailability must degrade gracefully and be observable, not crash the process silently. (The demo intentionally shows these failures — see `docs/ROADMAP.md` §Failure demos.)
- All long-lived processes implement graceful shutdown (§4).

---

## 11. Conventions (summary — full version in docs/CONVENTIONS.md)

- **Package names:** `@forge/api`, `@forge/worker`, `@forge/dashboard`, `@forge/db`, `@forge/queue`, `@forge/storage`, `@forge/metrics`, `@forge/shared`, `@forge/config`.
- **Types & schemas live in `@forge/shared`** and are imported everywhere; don't redefine a deployment status in three places.
- **DB access only through `@forge/db`** (Kysely). No raw `pg` scattered in route handlers.
- **Queue definitions only in `@forge/queue`**; both API (producer) and worker (consumer) import from it.
- Files: `kebab-case.ts`. Types/classes: `PascalCase`. Vars/functions: `camelCase`. DB tables/columns: `snake_case`.
- Prefer pure functions + thin route handlers; put logic in `services/`, IO in `repositories/`.
- Conventional Commits (`feat:`, `fix:`, `chore:` …).

---

## 12. Progress reporting (per-phase rule)

We build `docs/ROADMAP.md` **one phase at a time**, and every phase ends with a written record.

When a phase is finished:

1. **Tick the phase's checkboxes** in `docs/ROADMAP.md` and mark its demo checkpoint done.
2. **Append a section to `PROGRESS.md`** (repo root) for that phase containing:
   - **What shipped** — grouped by package/app, concrete enough that someone can find the code.
   - **Decisions & assumptions** — every judgement call made along the way and why (ports,
     naming, anything deviating from the docs).
   - **Verification** — the commands actually run and their results, including the failure
     paths that were exercised. Only claim what was really run.
   - **Not done / deferred on purpose** — so gaps are explicit, never silent.
   - **Next up** — a one-paragraph handoff to the following phase.
3. **Update the status table** at the top of `PROGRESS.md`.

Rules for `PROGRESS.md`: append, never rewrite history; state facts, not intentions; if
something is half-finished say so plainly. It is the project's build log and the raw material
for the final-year report.

---

## 13. When to STOP and ask the user

Ask before:
- Changing the database schema shape in a way that would need data migration.
- Changing the auth/session/RBAC model.
- Changing queue semantics (retry/idempotency/dead-letter behavior).
- Changing a public API or WebSocket event contract other code depends on.
- Adding a heavy dependency that overlaps a §4 learning goal.

Otherwise: decide, note it, keep building.
