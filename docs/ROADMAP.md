# ForgeCloud — Roadmap

A phased build order adapted from the blueprint to a **TypeScript + Fastify + BullMQ** stack. Each phase ends with something runnable and, where possible, something *visible on the dashboard* (this is a visual-first project). Check items off as you go.

The blueprint's original order started with a raw HTTP server; since we chose Fastify, Phase 0–1 fold that "HTTP lifecycle" learning into the Fastify setup instead.

---

## Phase 0 — Foundations
Goal: the monorepo boots, connects to Postgres + Redis, and returns a health check.

- [x] pnpm workspace + `tsconfig.base.json`, ESLint/Prettier, `.env.example`.
- [x] `packages/config` — Zod env parsing + `pino` logger.
- [x] `infra/docker-compose.yml` — Postgres + Redis.
- [x] `packages/db` — Kysely client + `node-pg-migrate` set up; first migration (`users`, `organizations`, `org_members`).
- [x] `apps/api` — Fastify boots, `/health` returns `{ ok: true }` after checking DB + Redis.
- [x] `apps/api` — global error-handler plugin + request-id + graceful shutdown.
- [x] `apps/dashboard` — Next.js boots, hits `/health`.
- [x] `packages/shared` — `AppError`, status/role enums, Redis key + channel names (added early: config, db and api all needed it).

**Demo checkpoint:** `pnpm dev` brings everything up; dashboard shows API health green. ✅ **Done — see [PROGRESS.md](../PROGRESS.md).**

---

## Phase 1 — Auth, orgs & RBAC
Goal: a user can register, log in, create an org, and permissions are enforced.

- [x] Register/login (argon2), opaque sessions in Redis, logout.
- [x] `auth` Fastify plugin: attach `user` + `org` + `role` to requests.
- [x] RBAC helper (`requireRole('admin')`) used on mutating routes.
- [x] Organizations + members CRUD; invite/add member with a role.
- [x] API keys: create (show once), list, revoke; API-key auth path.
- [x] Rate limiting (Redis) on auth + write endpoints.
- [x] Dashboard: auth screens, org switcher, members/RBAC view.

**Demo checkpoint:** log in, create org, add a member as `viewer`, show a forbidden action. ✅ **Done — see [PROGRESS.md](../PROGRESS.md).**

---

## Phase 2 — Projects & env vars
Goal: manage the thing we'll deploy.

- [x] Projects CRUD (name, slug, commands, port, health path/timeout).
- [x] Env vars CRUD with encrypted-at-rest secrets (never returned in plaintext).
- [x] Source intake: file **upload** (streamed, size-limited) into local object storage; store a `files` row. (Git source can come later.)
- [x] Dashboard: project list + settings + env vars + upload.

**Demo checkpoint:** create a project, set env vars, upload a sample app. ✅ **Done — see [PROGRESS.md](../PROGRESS.md).**

---

## Phase 3 — Storage & streams
Goal: real streaming IO for uploads/downloads/artifacts.

- [x] `packages/storage` local object-store abstraction (`put/get/list/delete`) — all streamed with backpressure.
- [x] Gzip compression of artifacts via `node:zlib` in a **worker thread**; checksums (sha256).
- [x] Download endpoint streams artifacts/logs back out.

**Demo checkpoint:** upload → stored + checksummed; download streams back identical bytes. ✅ **Done — see [PROGRESS.md](../PROGRESS.md).**

---

## Phase 4 — Queue & worker skeleton
Goal: clicking Deploy creates a job that a worker picks up (no real build yet).

- [x] `packages/queue` — BullMQ `deployments` queue + typed job payload (Zod in `@forge/shared`).
- [x] `POST /deployments` — insert `deployment` (status `queued`), enqueue job, return `202`. Idempotency key honored.
- [x] `apps/worker` — BullMQ processor: claim job → `assigned` → walk through fake stages with delays → `live`.
- [x] Persist every transition to `deployments` + `deployment_events`; worker registry + heartbeat.

**Demo checkpoint:** click Deploy → see it go `queued → assigned → … → live` in the DB and worker logs. ✅ **Done — see [PROGRESS.md](../PROGRESS.md).**

---

## Phase 5 — Realtime (WebSockets + Pub/Sub)
Goal: the dashboard shows the pipeline moving *live*.

- [x] `@fastify/websocket` gateway: subscribe/unsubscribe to topics.
- [x] Redis Pub/Sub bridge: worker publishes `deployment:<id>` events; API fans out to sockets.
- [x] Shared WS event contract in `@forge/shared` (`log | status | metric | error`).
- [x] Reconnect replay: on subscribe, send recent `deployment_events` tail.
- [x] Dashboard: animated pipeline + live status, driven by WS.

**Demo checkpoint:** two browser tabs both watch the same deployment advance in real time. ✅ **Done — see [PROGRESS.md](../PROGRESS.md).**

---

## Phase 6 — Real builds via `child_process`
Goal: actually run install + build and stream real logs.

- [x] Pipeline stages `cloning` (copy source from storage to a sandbox dir) → `installing` → `building` via `spawn` (`shell:false`).
- [x] Line-split Transform stream → publish log lines → WS; dual-write to log file + `deployment_events`.
- [x] Timeouts + kill + cleanup on failure; capture exit codes.
- [x] Path sandboxing: all paths validated against the deployment's root.
- [x] Dashboard: live scrolling build log.

**Demo checkpoint:** real `npm install && npm run build` output streams to the browser. ✅ **Done — see [PROGRESS.md](../PROGRESS.md).**

---

## Phase 7 — Docker deployment via `dockerode`
Goal: run the built app in a container and go truly LIVE.

- [x] `creating_container` → build/prepare image, create container with **resource limits** (memory, CPU, pids), non-root, no host net by default.
- [x] `starting` → start container; map a host port; stream container logs (demuxed) to WS.
- [x] `health_check` → HTTP GET `health_path` until 2xx or timeout.
- [x] On success → `live` (+ url, container_id, host_port, duration); set `projects.active_deployment_id`.
- [x] Stop/restart deployment; remove container on stop; Redis lock = one live container per project.
- [x] Dashboard: running containers list, app URL, per-container CPU/mem.

**Demo checkpoint:** deploy a sample app end-to-end and open its URL locally. ✅ **Done — see [PROGRESS.md](../PROGRESS.md).**

---

## Phase 8 — Retries, rollback, idempotency, dead-letter
Goal: the resilience story.

- [x] BullMQ retry with backoff; `attempt` tracked; exhausted → **dead-letter** queue + `failed`.
- [x] Rollback: start a new deployment from a prior `live` artifact/image, health check, swap active, stop old (record `parent_deployment_id`).
- [x] Idempotency: duplicate deploy click returns existing deployment, no duplicate container.
- [x] Dashboard: retry button, rollback button, build history with failures.

**Demo checkpoint:** ✅ force a failure → auto-retry → then rollback to the last good deployment.

---

## Phase 9 — Observability
Goal: the metrics dashboard.

- [x] Event-loop lag (`perf_hooks`), CPU/mem (`process.*`), per-container stats (Docker API).
- [x] Queue depth/active/failed; deployment durations; success/failure counts; health.
- [x] `/metrics` (Prometheus text) + `metrics` WS topic.
- [x] Dashboard: charts for CPU/memory/queue/duration + system activity view.

**Demo checkpoint:** ✅ metrics update live while a deployment runs — see [PROGRESS.md](../PROGRESS.md).

---

## Phase 10 — Local scaling
Goal: prove horizontal architecture on one laptop.

- [x] Run multiple API replicas behind a reverse proxy (hand-written Node proxy, `apps/proxy`); sessions already in Redis (no sticky).
- [x] Run multiple workers competing on the queue (`pnpm cluster --api N --workers M`).
- [x] Show a worker crash mid-build → job retried on another worker.
- [x] Dashboard: worker fleet + which worker ran which deployment.

**Demo checkpoint:** ✅ kill a worker mid-deploy, watch another finish the job — see [PROGRESS.md](../PROGRESS.md).

---

## Phase 11 — Hardening & failure demos
Goal: everything the final demo intentionally breaks.

- [ ] Failed builds, build timeouts, app crashes, failed health checks — all surfaced cleanly.
- [ ] Redis/Postgres unavailability → graceful degradation + visible error state (not a silent crash).
- [ ] Duplicate deployment requests handled by idempotency.
- [ ] CPU-heavy task offloaded to a worker thread (show event loop stays responsive).
- [ ] Security pass: command-injection attempt blocked, path-traversal blocked, resource limits enforced, secrets never leaked.

**Demo checkpoint:** run the whole "Failure Demonstrations" section from the blueprint.

---

## Phase 12 — Polish for presentation
- [ ] DNS/custom-domain concept (`*.localhost` routing via the proxy) — optional stretch.
- [ ] HTTPS/TLS locally (self-signed) — optional stretch.
- [ ] Seed/demo script that sets up a project + sample app for a clean live demo.
- [ ] Architecture view in the dashboard + the "how this distributes to real VMs" explainer slide.

---

## Presentation script (maps to the blueprint's demo)
1. Create a project, set build/start commands.
2. Deploy → job enters queue.
3. Worker picks up the job.
4. Live logs stream in (streams + WebSockets).
5. Build runs.
6. Docker creates + runs the container.
7. Health check passes; open the running app.
8. Show CPU/memory/container/queue metrics.
9. Trigger a failed deployment → retries.
10. Rollback to a previous successful deployment.
11. Show multiple workers / API processes.
12. Explain how the same architecture distributes across real VMs/cloud.

---

## Suggested order if time is tight
Foundations → Auth → Projects → Queue/Worker skeleton → Realtime → Real builds → Docker → Retries/Rollback are the **core spine** that makes a compelling demo. Observability, scaling, and hardening deepen it; DNS/TLS are stretch goals. Don't let the stretch goals starve the spine.
