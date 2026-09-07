import { Agent, get as httpGet, type IncomingMessage } from 'node:http';
import { env, type Logger } from '@forge/config';

/**
 * The upstream pool: which API replicas exist, which of them are answering,
 * and whose turn it is.
 *
 * Hand-written rather than pulled from a library for the same reason the
 * WebSocket layer is (CLAUDE.md §4): the interesting parts of a load balancer
 * are exactly the parts a library hides — the selection policy, when an
 * upstream is taken out of rotation, and what happens to a request that was
 * already in flight when it was.
 *
 * **Round-robin, not least-connections.** The replicas are identical processes
 * on one laptop and the point of the demo is that the choice is *arbitrary*:
 * any replica can serve any request because none of them holds session state
 * (sessions are opaque tokens in Redis — no sticky routing, no shared cookie
 * jar). A cleverer policy would obscure that.
 *
 * **Health is passive plus active.** Active: poll `PROXY_HEALTH_PATH` on a
 * timer. Passive: a connection that could not be established marks its
 * upstream, so a replica killed between two probes is dropped on the first
 * request rather than the next tick.
 *
 * The flip is asymmetric on purpose — `PROXY_UNHEALTHY_AFTER` failures to drop
 * an upstream, `PROXY_HEALTHY_AFTER` successes to take it back. Dropping fast
 * costs one round-robin slot; taking a half-started process back early costs
 * real requests.
 */

export type UpstreamState = {
  /** `host:port`, exactly as configured. Also the id in the status document. */
  readonly target: string;
  readonly host: string;
  readonly port: number;
  healthy: boolean;
  /** Consecutive probe results in the current direction. */
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  /** Requests this proxy has *routed* here since it started. */
  requests: number;
  /** Upgrades (WebSockets) routed here. */
  upgrades: number;
  /** Requests that failed to reach it at all. */
  connectErrors: number;
  lastProbeMs: number | null;
  lastError: string | null;
  /** Keep-alive agent, one per upstream so sockets are not re-picked at random. */
  readonly agent: Agent;
};

/** `host:port` → `{host, port}`, defaulting to the API's own host settings. */
function parseTarget(raw: string): { host: string; port: number } | null {
  const [host, port] = raw.includes(':') ? raw.split(':') : [raw, String(env.API_PORT)];
  const parsedPort = Number(port);
  if (!host || !Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) return null;
  return { host, port: parsedPort };
}

/**
 * The configured upstreams.
 *
 * An empty `PROXY_UPSTREAMS` means "the single API this .env describes", so the
 * proxy can be put in front of an unmodified one-process setup and behave
 * identically — which is what makes it safe to make it the dashboard's default
 * target.
 */
export function configuredTargets(): string[] {
  if (env.PROXY_UPSTREAMS.length > 0) return env.PROXY_UPSTREAMS;
  // 127.0.0.1 rather than API_HOST: API_HOST is a *bind* address and is
  // commonly 0.0.0.0, which is not a thing you can connect to.
  return [`127.0.0.1:${String(env.API_PORT)}`];
}

export class UpstreamPool {
  private readonly upstreams: UpstreamState[] = [];
  private cursor = 0;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    targets: readonly string[],
    private readonly log: Logger,
  ) {
    for (const raw of targets) {
      const parsed = parseTarget(raw);
      if (!parsed) {
        this.log.error({ target: raw }, 'ignoring an unparseable PROXY_UPSTREAMS entry');
        continue;
      }
      this.upstreams.push({
        target: raw,
        host: parsed.host,
        port: parsed.port,
        // Optimistic: the first probe lands within PROXY_HEALTH_INTERVAL_MS,
        // and refusing every request until then would make the proxy's own
        // startup a visible outage.
        healthy: true,
        consecutiveFailures: 0,
        consecutiveSuccesses: 0,
        requests: 0,
        upgrades: 0,
        connectErrors: 0,
        lastProbeMs: null,
        lastError: null,
        agent: new Agent({
          keepAlive: true,
          // One socket per in-flight request plus a small idle pool. Keep-alive
          // matters here: without it every proxied request pays a fresh TCP
          // handshake, which on a localhost demo is most of its latency.
          maxSockets: 64,
          keepAliveMsecs: 15_000,
        }),
      });
    }
    if (this.upstreams.length === 0) {
      throw new Error('no usable upstreams — check PROXY_UPSTREAMS');
    }
  }

  get size(): number {
    return this.upstreams.length;
  }

  get all(): readonly UpstreamState[] {
    return this.upstreams;
  }

  get healthy(): UpstreamState[] {
    return this.upstreams.filter((u) => u.healthy);
  }

  /**
   * The next upstream in rotation, skipping `exclude` (the ones a retry has
   * already tried) and preferring healthy ones.
   *
   * The fallback matters: if *every* upstream is marked unhealthy we still pick
   * one rather than answering 502 ourselves. A proxy that refuses to forward is
   * indistinguishable, from the browser, from an API that is down — and the API
   * can give a truthful answer about *why* it is unwell, which the proxy
   * cannot. This is the same reason the health probe uses `/health/live`
   * instead of `/health`.
   */
  next(exclude: ReadonlySet<string> = new Set()): UpstreamState | null {
    const eligible = (pool: UpstreamState[]) => pool.filter((u) => !exclude.has(u.target));
    const preferred = eligible(this.healthy);
    const pool = preferred.length > 0 ? preferred : eligible(this.upstreams);
    if (pool.length === 0) return null;
    // The cursor advances over the *whole* list, not over the filtered pool, so
    // rotation stays stable as upstreams come and go.
    const chosen = pool[this.cursor % pool.length];
    this.cursor = (this.cursor + 1) % Number.MAX_SAFE_INTEGER;
    return chosen ?? null;
  }

  /** A request could not reach this upstream: count it and re-probe now. */
  markConnectError(upstream: UpstreamState, err: unknown): void {
    upstream.connectErrors += 1;
    upstream.lastError = err instanceof Error ? err.message : String(err);
    this.recordFailure(upstream);
  }

  // --- health probing -------------------------------------------------------

  start(): void {
    void this.probeAll();
    this.timer = setInterval(() => {
      void this.probeAll();
    }, env.PROXY_HEALTH_INTERVAL_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const upstream of this.upstreams) upstream.agent.destroy();
  }

  private async probeAll(): Promise<void> {
    await Promise.all(this.upstreams.map((upstream) => this.probe(upstream)));
  }

  private async probe(upstream: UpstreamState): Promise<void> {
    const started = Date.now();
    try {
      const status = await this.requestHealth(upstream);
      upstream.lastProbeMs = Date.now() - started;
      // Any answer at all counts, including a 503: `/health/live` touches no
      // dependency, so a non-2xx from it means the process is answering with
      // something we did not expect — still a live process, and routing around
      // it would hide the problem rather than fix it. Only "no answer" is a
      // failure. (2xx is what the route actually returns; the range is here so
      // a future 204 does not read as an outage.)
      if (status >= 200 && status < 500) {
        upstream.lastError = null;
        this.recordSuccess(upstream);
      } else {
        upstream.lastError = `health probe returned ${String(status)}`;
        this.recordFailure(upstream);
      }
    } catch (err) {
      upstream.lastProbeMs = Date.now() - started;
      upstream.lastError = err instanceof Error ? err.message : String(err);
      this.recordFailure(upstream);
    }
  }

  private requestHealth(upstream: UpstreamState): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      const request = httpGet(
        {
          host: upstream.host,
          port: upstream.port,
          path: env.PROXY_HEALTH_PATH,
          // A fresh socket per probe: borrowing from the request agent would
          // let a probe succeed on a pooled socket that the next real request
          // then finds closed.
          agent: false,
          headers: { 'user-agent': 'forge-proxy/health' },
        },
        (res: IncomingMessage) => {
          // The body is irrelevant but must be drained, or the socket is never
          // released and the process leaks one handle per probe.
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      request.setTimeout(env.PROXY_HEALTH_TIMEOUT_MS, () => {
        request.destroy(new Error(`health probe timed out after ${String(env.PROXY_HEALTH_TIMEOUT_MS)}ms`));
      });
      request.on('error', reject);
    });
  }

  private recordSuccess(upstream: UpstreamState): void {
    upstream.consecutiveFailures = 0;
    upstream.consecutiveSuccesses += 1;
    if (!upstream.healthy && upstream.consecutiveSuccesses >= env.PROXY_HEALTHY_AFTER) {
      upstream.healthy = true;
      this.log.info({ upstream: upstream.target }, 'upstream is back in rotation');
    }
  }

  private recordFailure(upstream: UpstreamState): void {
    upstream.consecutiveSuccesses = 0;
    upstream.consecutiveFailures += 1;
    if (upstream.healthy && upstream.consecutiveFailures >= env.PROXY_UNHEALTHY_AFTER) {
      upstream.healthy = false;
      this.log.warn(
        { upstream: upstream.target, error: upstream.lastError },
        'upstream taken out of rotation',
      );
    }
  }
}
