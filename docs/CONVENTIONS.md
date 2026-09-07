# ForgeCloud — Conventions

Pragmatic rules so the codebase stays consistent while we build fast. When in doubt, match existing code.

---

## 1. Language & tooling

- **TypeScript strict** everywhere (`strict: true`, `noUncheckedIndexedAccess: true`). No `any` — use `unknown` + narrowing, or a real type. If you truly must, `// eslint-disable-next-line` with a one-line reason.
- **ESM** (`"type": "module"`), Node 20+.
- **Shared base config**: `tsconfig.base.json` at root; each package extends it.
- **ESLint + Prettier**; formatting is not a code-review topic — Prettier decides.
- One tool per job: `pnpm` (packages), `tsx`/`ts-node` for dev run, `tsup`/`tsc` for build.

## 2. Naming

| Thing | Style | Example |
|---|---|---|
| Files/dirs | kebab-case | `deployment-service.ts` |
| Types/interfaces/classes/enums | PascalCase | `DeploymentStatus`, `AppError` |
| Variables/functions | camelCase | `enqueueDeployment` |
| Constants | UPPER_SNAKE | `MAX_BUILD_TIMEOUT_MS` |
| DB tables/columns | snake_case (plural tables) | `deployment_events`, `worker_id` |
| Redis keys | `colon:namespaced` | `deployment:123`, `lock:project:45` |
| Queue names | kebab | `deployments`, `deployments-dlq` |
| Packages | `@forge/<name>` | `@forge/shared` |
| Env vars | UPPER_SNAKE | `DATABASE_URL` |

Don't invent synonyms. It's `deployment` everywhere — not `deploy`, `build`, `release` for the same thing.

## 3. Project structure inside an app

```
apps/api/src/
├── plugins/          # fastify plugins (auth, error-handler, rate-limit, ws)
├── routes/           # route registration only; thin
├── services/         # business logic (pure-ish, testable)
├── repositories/     # DB access via @forge/db (the only place with queries)
├── lib/              # small helpers
├── app.ts            # buildApp(): assembles fastify instance
└── server.ts         # start + graceful shutdown
```

```
apps/worker/src/
├── pipeline/         # one file per stage: clone, install, build, container, health-check
├── services/
├── lib/
├── worker.ts         # BullMQ processor wiring
└── main.ts           # start + heartbeat + graceful shutdown
```

- **Route handlers stay thin**: validate → call a service → shape a response. No SQL, no business rules in routes.
- **Services** contain logic and orchestrate repositories/queue. **Repositories** are the only place that talks to the DB.

## 4. Validation & types (single source of truth)

- Every external input (HTTP body/query/params, WS message, job payload, env) is parsed with a **Zod** schema. If it isn't parsed, it isn't trusted.
- Schemas and their inferred types live in `@forge/shared` and are imported by producer and consumer. Example: the job payload Zod schema is used by the API when enqueuing and by the worker when consuming.
- Derive types from schemas: `type CreateDeployment = z.infer<typeof createDeploymentSchema>`. Don't hand-write a duplicate interface.
- Fastify routes use `fastify-type-provider-zod` so request/response types come from the schema.

## 5. Errors

```ts
export class AppError extends Error {
  constructor(
    public code: string,          // 'PROJECT_NOT_FOUND'
    public statusCode: number,    // 404
    message: string,              // safe, user-facing
    public cause?: unknown,        // internal detail, logged not returned
  ) { super(message); }
}
```

- Throw `AppError` for expected/domain failures; let unexpected errors bubble to the global handler.
- **One** Fastify error-handler plugin maps errors → `{ error: { code, message } }` and logs internals (with request id). Never leak stack traces or `cause` to clients.
- **Never** swallow errors: no empty `catch {}`. Either handle meaningfully or rethrow.
- Attach context: include `deploymentId`, `projectId` where relevant so logs are traceable.
- Async: no floating promises — `await` or explicitly `void` with a handler. Register `unhandledRejection`/`uncaughtException` guards at process entry (log + graceful shutdown).

## 6. Async, streams, and processes

- Prefer streams for anything log/upload/download/artifact sized — never buffer an entire build log into a string.
- Split child-process output into lines with a small Transform stream before publishing.
- Everything external gets a **timeout** and a **cleanup path** (kill process / remove container / release lock) in a `finally`.
- Respect backpressure: check `stream.write()` return / use `pipeline()` from `node:stream/promises`.

## 7. Database

- Migrations only via `node-pg-migrate`; never mutate schema by hand. One logical change per migration, reversible (`up`/`down`).
- Queries via **Kysely** in repositories. Parameterized always — Kysely does this; never string-concat SQL.
- Timestamps: `created_at`, `updated_at` (`timestamptz`, default `now()`), `updated_at` bumped on write.
- IDs: `uuid` primary keys (`gen_random_uuid()`), except append-only event tables which may use `bigint` identity for ordering.
- Money/counts as integers; durations in **ms**; sizes in **bytes**. Store enums as Postgres enums or `text` + a check — keep the source enum in `@forge/shared`.
- Migrations and Kysely generated types are committed together.

## 8. Redis

- Namespaced keys (§2). Set TTLs on ephemeral keys (sessions, rate limits, locks).
- Distributed locks via `SET key val NX PX <ttl>` (or a small helper); always release with a check-and-delete (Lua) so you don't release someone else's lock.
- Separate Redis connections for: commands, BullMQ, and Pub/Sub subscriber (a subscriber connection can't run normal commands).

## 9. WebSocket contract

- One socket per browser; client sends `{ type: 'subscribe', topic }` / `{ type: 'unsubscribe', topic }`.
- Server messages are discriminated unions: `{ type: 'log' | 'status' | 'metric' | 'error', topic, data, ts }`. Define them once in `@forge/shared`.
- Version the contract implicitly by keeping it in shared; changing it is a "stop and ask" event (see CLAUDE.md §12).

## 10. Config / secrets

- All config from env, parsed once through a Zod schema in `@forge/config`; import the typed object, never read `process.env` directly elsewhere.
- `.env.example` lists every var with a comment; real `.env` is git-ignored.
- Secrets never logged, never in responses, never in error messages.

## 11. Logging

- `pino` structured logs. Levels: `error` (action needed), `warn` (recoverable/odd), `info` (lifecycle), `debug` (dev detail).
- Include `reqId`/`jobId`/`deploymentId` context. No `console.log` in committed code.

## 12. Tests (when we write them)

- **Vitest**. Unit-test services with fakes for repositories/queue. Integration-test API routes with Fastify `.inject()` against a test Postgres/Redis (docker compose test profile).
- Test the failure paths the demo relies on: build timeout, health-check fail, duplicate deploy, worker crash/retry.

## 13. Git

- **Conventional Commits**: `feat:`, `fix:`, `chore:`, `refactor:`, `docs:`, `test:`. Optional scope: `feat(worker): stream build logs`.
- Small, working commits. Migrations + generated types in the same commit as the code that needs them.
- Branch per feature; keep `main` runnable.

## 14. Comments

- Comment the *why*, not the *what*. Non-obvious concurrency, backpressure, security, or Docker quirks deserve a line. Obvious code doesn't.
