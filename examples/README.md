# Example apps

Sample sources for deploying through ForgeCloud. Two of them, for two different
jobs.

| App | Install | Build | Warm-up | Use it to… |
| --- | --- | --- | --- | --- |
| [`hello-forge`](./hello-forge) | instant | ~0.1s | instant | smoke-test the pipeline after a change |
| [`forge-analytics`](./forge-analytics) | ~1s | **~37s** | **~3s** | demo the platform to a room |

## `forge-analytics` — the demo app

A real TypeScript application with a seven-stage build that takes about
**35 seconds** of genuine CPU work, then boots into an analytics dashboard.
Nothing in it sleeps to look busy: if the build takes half a minute it is
because half a minute of analysis happened.

```
preflight → codegen → dataset → typecheck → bundle → assets → manifest
```

* **codegen** writes 96 TypeScript report modules and a registry that imports
  them — the same pattern a GraphQL or SDK generator uses.
* **dataset** synthesizes 3,000,000 deterministic events and analyzes them:
  rolling 7/30/90-day windows, sessionization (an O(n log n) sort by user),
  weekly cohort retention, funnel conversion, a 90-day daily breakdown, an
  hour-of-day profile, per-country and per-route drill-downs, and a
  24×90 country-by-day matrix. Then it regenerates the whole corpus from the
  seed and checks both passes agree, which is what makes the build reproducible.
* **typecheck** runs `tsc --noEmit` over everything, generated code included.
* **bundle** runs esbuild twice — the Node server and the browser client.
* **assets** minifies the stylesheet and takes a sha256 of every file in `dist/`.
* **manifest** stamps `dist/build-info.json` with the timings, the config, the
  digests and the injected `FORGE_*` variables.

Why this makes a good demo:

* **The log actually streams.** ~490 lines with visible progress, plus two real
  advisories on stderr (an unset `NODE_ENV`, and source maps outweighing the
  code they map) — so the dashboard's stream colouring has something genuine to
  colour rather than a warning invented for the demo.
* **The health check is real.** The server does *not* open its socket until it
  has regenerated the corpus (~3s) and verified its numbers against the
  checksum the build recorded. ForgeCloud polls, gets connection-refused, and
  the `health_check` stage shows real elapsed time instead of passing instantly.
  The warm-up narrates itself on stdout, and the worker follows the container
  log into the deployment log — so you watch the app boot in the same stream as
  the build.
* **Injected env vars visibly work.** `GREETING` becomes the dashboard title;
  `ANALYTICS_SCALE` changes how long the build takes. Both are set from the
  project's Environment panel.
* **There is something to look at when it goes live.** A dashboard with KPIs,
  charts, a cohort table, a funnel, a country×day heatmap, a build-provenance
  panel, and a **Live query** tab that filters the resident 3M-event corpus on
  demand — combinations the build never precomputed.

### Tuning how long it takes

Set these in the project's **Environment** panel; they are read by the build.

| Variable | Default | Effect |
| --- | --- | --- |
| `ANALYTICS_SCALE` | `1` | Scales events *and* modules together. The one knob to reach for. `2` ≈ 70s, `0.25` ≈ 9s. |
| `ANALYTICS_EVENTS` | `3000000` | Corpus size. Dominates both build time and container memory. |
| `ANALYTICS_MODULES` | `96` | Generated report modules. |
| `ANALYTICS_MATRIX_COUNTRIES` | `24` | Rows in the country×day matrix; each costs 90 more passes. Biggest single lever on build time. |
| `ANALYTICS_DRILLDOWNS` | `32` | Per-country drill-downs. |
| `ANALYTICS_ROUTE_DRILLDOWNS` | `24` | Per-route drill-downs. |
| `ANALYTICS_VERIFY` | `true` | Set `false` to skip the reproducibility replay (saves ~3s). |
| `ANALYTICS_MINIFY` | `true` | Set `false` for a readable `dist/server.mjs`. |
| `GREETING` | `ForgeCloud Analytics` | Dashboard title. Good for proving env injection. |
| `STARTUP_DELAY_SECONDS` | `0` | Extra delay before listening — stretches `health_check` on purpose. |
| `STRICT_CHECKSUM` | `true` | Fail the boot if the warm-up disagrees with the build. |

**Memory matters.** Deployment containers get 512MB. At the default 3M events
the process settles around 216MB RSS. `ANALYTICS_SCALE=2` roughly doubles the
corpus — raise `DOCKER_MEMORY_MB` before trying it, or the container will be
OOM-killed during warm-up.

### Project settings

Defaults are correct for this app; `health_path` is the one worth changing.

| Setting | Value |
| --- | --- |
| Root dir | `.` |
| Install | `npm install` |
| Build | `npm run build` |
| Start | `npm start` |
| Port | `3000` |
| Health path | `/health` (rather than `/`, so it reports checksum state) |
| Health timeout | `30000` — the default; warm-up needs ~3s of it |

### Measured end-to-end

A real deployment of this app through ForgeCloud, at the defaults:

| Stage | Time |
| --- | --- |
| `installing` | 0.6s |
| `building` | 37.5s |
| `creating_container` | 6.5s |
| `starting` | 0.1s |
| `health_check` | 4.1s |
| **total** | **48.9s** |

490 log events streamed to the dashboard; container settled at 217MB RSS.

### Packing it

```bash
./examples/pack.sh                 # both apps → /tmp/forge-analytics.tgz, /tmp/hello-forge.tgz
./examples/pack.sh --zip           # zip instead of tar.gz
```

Or by hand — note the exclusions, which keep the upload under the 50MB cap and
force the pipeline to do the install and codegen itself:

```bash
tar -czf /tmp/forge-analytics.tgz -C examples \
  --exclude=node_modules --exclude=dist --exclude=src/generated \
  forge-analytics
```

Upload through the project's **Source** panel, then hit **Deploy**. The archive
has a single top-level directory, so the pipeline descends into it and says so
in the build log; leave `rootDir` at `.`.

### Working on it locally

```bash
cd examples/forge-analytics
npm install
npm run build          # ~35s
npm start              # http://localhost:3000
ANALYTICS_SCALE=0.2 npm run build   # ~8s, for iterating
```

### Demo-day checklist

Two things will stop a deployment dead, and neither is obvious from the error
until you have seen it once.

1. **The base image must already be on the Docker host.**
   `DOCKER_PULL_BASE_IMAGE` defaults to `false` — deliberately, so a demo
   without a network fails with a clear message instead of hanging on a
   registry. Check it before you present:

   ```bash
   docker image ls node:22-alpine    # must print a row
   docker pull node:22-alpine        # if it does not
   ```

2. **Warm the worker's npm cache if the venue has no usable network.**
   The pipeline shares one cache across builds at `builds/.npm-cache`, and this
   app's `.npmrc` sets `prefer-offline=true`, so a warm cache makes `npm install`
   work with the network unplugged:

   ```bash
   cd examples/forge-analytics
   npm_config_cache="$PWD/../../builds/.npm-cache" npm install
   ```

   Verify with `npm install --offline` against that cache — it should succeed.

Also worth knowing: the first deployment of a project pays for the Docker layer
cache; later ones reuse it. And a **rollback takes ~6s against ~48s for a full
deploy**, because it adopts the image the target deployment already proved —
which is a good thing to show back to back.

## `hello-forge`

A zero-dependency Node app. `npm install` needs no network and finishes
instantly, and `npm run build` prints ~50 lines (plus one on stderr). Keep it
for smoke-testing the pipeline: when a deployment fails you want to know
whether it is the platform or the payload, and this answers that in seconds.

It stamps the `FORGE_*` variables the worker injects into `dist/build-info.json`.
