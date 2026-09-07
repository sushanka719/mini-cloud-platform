'use client';

import Link from 'next/link';
import { use, useCallback, useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRealtime, useTopic } from '@/components/realtime-provider';
import { useSession } from '@/components/session-provider';
import { topics } from '@/lib/realtime';
import {
  API_URL,
  PROXY_STATUS_PATH,
  api,
  formatAgo,
  formatBytes,
  formatUptime,
  getLastUpstream,
  hasRole,
  onUpstreamChange,
  type ApiReplica,
  type DeadLetterEntry,
  type Deployment,
  type Fleet,
  type ProxyStatus,
  type WorkerView,
} from '@/lib/api';
import { Button, Empty, ErrorNote, Panel } from '@/components/ui/primitives';
import { StatusBadge } from '@/components/deployment-pipeline';

/**
 * The fleet: the proxy, the API replicas, the queue, the workers competing for
 * it, and where a deployment goes when its retries run out.
 *
 * Everything here is read from shared state — BullMQ counters in Redis, the
 * `workers` registry in Postgres, each API replica's own metrics document in
 * Redis — so the page looks identical whichever replica serves it. That is the
 * claim Phase 10 exists to make visible, and it is why this page is the one
 * place that also shows *which* replica served it: the answer changing on every
 * refresh is the evidence.
 *
 * Liveness is never a stored status. A worker killed with SIGKILL can't write
 * "offline" and an API replica can't either; both are judged by whether their
 * Redis key has expired.
 */
export default function FleetPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);
  const queryClient = useQueryClient();
  const { orgs } = useSession();
  const { status: socketStatus, instance: socketInstance } = useRealtime();
  const org = orgs.find((o) => o.slug === orgSlug || o.id === orgSlug);
  const orgId = org?.id ?? null;
  // Discarding the record of a failure is an admin act; reading it is not.
  const canDiscard = hasRole(org?.role, 'admin');

  /**
   * The replica serving this tab's HTTP requests, from the proxy's
   * `x-forge-upstream` header.
   *
   * Subscribed to rather than read once: with a round-robin proxy the answer
   * genuinely changes between requests, and that churn *is* the demo. Null when
   * the dashboard is talking straight to a replica.
   */
  const [httpUpstream, setHttpUpstream] = useState<string | null>(null);
  useEffect(() => {
    setHttpUpstream(getLastUpstream());
    return onUpstreamChange(setHttpUpstream);
  }, []);

  /**
   * The proxy's own status. Not an API route — it is served by the proxy
   * process, which is the only one that knows how it is spreading load.
   *
   * `retry: false` and a swallowed error: a dashboard pointed straight at one
   * API replica gets a 404 here, and that is a valid setup, not a fault. The
   * panel renders an explanation instead of an error.
   */
  const proxy = useQuery({
    queryKey: ['proxy-status', API_URL],
    queryFn: () => api.get<ProxyStatus>(PROXY_STATUS_PATH),
    refetchInterval: 2000,
    retry: false,
  });

  // Queue counters and worker heartbeats have no publisher yet (Phase 9 adds
  // the `metrics` topic), so these still poll.
  const fleet = useQuery({
    queryKey: ['fleet', orgSlug],
    queryFn: () => api.get<Fleet>(`/orgs/${orgSlug}/fleet`),
    refetchInterval: 2000,
  });

  const activity = useQuery({
    queryKey: ['org-deployments', orgSlug],
    queryFn: () => api.get<Deployment[]>(`/orgs/${orgSlug}/deployments?limit=15`),
    // The org topic carries every deployment transition in the org, so the
    // activity feed is event-driven; polling is the fallback.
    refetchInterval: socketStatus === 'open' ? false : 2000,
  });

  /**
   * Deployments whose retry budget ran out.
   *
   * Polled rather than event-driven: nothing publishes a frame when a job is
   * parked (the dead-letter hop is a queue write, not a state transition), and
   * the org topic below invalidates it on every transition anyway — a
   * deployment that reaches the DLQ has just been recorded as `failed`, which
   * *is* a frame.
   */
  const deadLetters = useQuery({
    queryKey: ['dead-letters', orgSlug],
    queryFn: () => api.get<DeadLetterEntry[]>(`/orgs/${orgSlug}/dead-letters?limit=25`),
    refetchInterval: socketStatus === 'open' ? false : 5000,
  });

  const discard = useMutation({
    mutationFn: (jobId: string) => api.del<void>(`/orgs/${orgSlug}/dead-letters/${jobId}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['dead-letters', orgSlug] });
      void queryClient.invalidateQueries({ queryKey: ['fleet', orgSlug] });
    },
  });

  useTopic(
    socketStatus === 'open' && orgId ? topics.org(orgId) : null,
    useCallback(() => {
      void queryClient.invalidateQueries({ queryKey: ['org-deployments', orgSlug] });
      void queryClient.invalidateQueries({ queryKey: ['fleet', orgSlug] });
      void queryClient.invalidateQueries({ queryKey: ['dead-letters', orgSlug] });
    }, [queryClient, orgSlug]),
  );

  const queue = fleet.data?.queue;
  const dlq = fleet.data?.deadLetter;
  const actions = fleet.data?.containerActions;
  const workers = fleet.data?.workers ?? [];
  const online = workers.filter((w) => w.online);
  const replicas = fleet.data?.api ?? [];
  const parked = deadLetters.data ?? [];
  const behindProxy = proxy.isSuccess && proxy.data.ok;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold tracking-tight">Fleet</h1>
        <p className="mt-1 text-sm text-[#8b90a3]">
          Every process behind this dashboard: the proxy, the API replicas, the{' '}
          <code className="font-mono text-xs">deployments</code> queue, the workers competing for
          it, and where a deployment goes when its retries run out.
        </p>
      </div>
      <ErrorNote error={fleet.error} />

      <Panel
        title="Reverse proxy"
        description={`One address in front of every API replica. Round-robin, no sticky sessions — a session is an opaque token in Redis, so any replica can serve any request.`}
      >
        {!behindProxy ? (
          <Empty>
            This dashboard talks straight to <code className="font-mono text-xs">{API_URL}</code>,
            with no proxy in front of it. Start the fleet with{' '}
            <code className="font-mono text-xs">pnpm cluster</code> to put one there.
          </Empty>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat
                label="Replicas in rotation"
                value={proxy.data.healthy}
                tone={
                  proxy.data.healthy === proxy.data.total ? 'text-emerald-300' : 'text-amber-300'
                }
                hint={`of ${String(proxy.data.total)}`}
              />
              <Stat label="Requests routed" value={proxy.data.requests} tone="text-[#e6e8ef]" />
              <Stat label="WebSockets routed" value={proxy.data.upgrades} tone="text-sky-300" />
              <Stat
                label="Proxy uptime"
                text={formatUptime(proxy.data.uptimeMs)}
                tone="text-[#8b90a3]"
              />
            </div>
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="text-xs uppercase tracking-wide text-[#6e7387]">
                  <tr>
                    <th className="pb-2 pr-4 font-medium">Upstream</th>
                    <th className="pb-2 pr-4 font-medium">In rotation</th>
                    <th className="pb-2 pr-4 font-medium">Requests</th>
                    <th className="pb-2 pr-4 font-medium">WebSockets</th>
                    <th className="pb-2 pr-4 font-medium">Probe</th>
                    <th className="pb-2 font-medium">Last error</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#1c202b]">
                  {proxy.data.upstreams.map((upstream) => (
                    <tr key={upstream.target}>
                      <td className="py-2.5 pr-4 font-mono text-xs">
                        {upstream.target}
                        {/* The replica this tab's requests are landing on right
                            now. With round-robin it moves every refresh, which
                            is the point. */}
                        {httpUpstream === upstream.target && (
                          <span className="ml-2 rounded-full border border-sky-500/40 bg-sky-500/10 px-1.5 py-0.5 text-[10px] text-sky-300">
                            served your last request
                          </span>
                        )}
                      </td>
                      <td className="py-2.5 pr-4">
                        <Dot
                          on={upstream.healthy}
                          label={upstream.healthy ? 'yes' : 'taken out'}
                        />
                      </td>
                      <td className="py-2.5 pr-4 text-xs tabular-nums text-[#8b90a3]">
                        {upstream.requests}
                      </td>
                      <td className="py-2.5 pr-4 text-xs tabular-nums text-[#8b90a3]">
                        {upstream.upgrades}
                      </td>
                      <td className="py-2.5 pr-4 text-xs text-[#6e7387]">
                        {upstream.lastProbeMs === null ? '—' : `${String(upstream.lastProbeMs)} ms`}
                      </td>
                      <td className="py-2.5 text-xs text-[#6e7387]">
                        {upstream.connectErrors > 0 && (
                          <span className="mr-2 text-red-300">
                            {upstream.connectErrors} connect error
                            {upstream.connectErrors === 1 ? '' : 's'}
                          </span>
                        )}
                        {upstream.lastError ?? '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-3 border-t border-[#1c202b] pt-3 text-xs text-[#6e7387]">
              Health is polled on{' '}
              <code className="font-mono text-[11px]">{proxy.data.healthPath}</code> — liveness
              only, so a replica whose database is down stays in rotation and answers a truthful
              503 rather than being routed around silently. A replica that cannot be reached at all
              is dropped on the failed request itself and that request is retried elsewhere, so
              killing one costs no visible error.
            </p>
          </>
        )}
      </Panel>

      <Panel
        title="API replicas"
        description="Each replica writes its own metrics document to Redis under a TTL. Nothing reaps them: a replica that is SIGKILLed leaves this list when its key expires."
      >
        {replicas.length === 0 ? (
          <Empty>
            No API replica is reporting. Process metrics are what identifies one, so this is also
            what you see with <code className="font-mono text-xs">METRICS_INTERVAL_MS=0</code>.
          </Empty>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {replicas.map((replica) => (
              <ReplicaCard
                key={replica.instance}
                replica={replica}
                holdsSocket={replica.instance === socketInstance}
              />
            ))}
          </div>
        )}
      </Panel>

      <Panel title="Queue" description="BullMQ counters, read straight from Redis.">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          <Stat label="Waiting" value={queue?.waiting} tone="text-[#e6e8ef]" />
          <Stat label="Active" value={queue?.active} tone="text-sky-300" />
          <Stat label="Delayed" value={queue?.delayed} tone="text-amber-300" />
          <Stat label="Completed" value={queue?.completed} tone="text-emerald-300" />
          <Stat label="Failed" value={queue?.failed} tone="text-red-300" />
        </div>
        {queue && !queue.available && (
          <p className="mt-3 text-xs text-red-300">
            Queue counters are unavailable — Redis is not answering. Worker rows below are read
            from Postgres and show their last known state.
          </p>
        )}
        {queue?.paused && (
          <p className="mt-3 text-xs text-amber-300">The queue is paused; jobs are not consumed.</p>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-1 border-t border-[#1c202b] pt-3 text-xs text-[#8b90a3]">
          <span>
            <code className="font-mono text-[11px] text-[#6e7387]">deployments-dlq</code>{' '}
            <span className={dlq && dlq.waiting > 0 ? 'text-red-300' : ''}>
              {dlq?.waiting ?? '—'} parked
            </span>
          </span>
          <span>
            <code className="font-mono text-[11px] text-[#6e7387]">container-actions</code>{' '}
            {actions?.waiting ?? '—'} waiting · {actions?.active ?? '—'} active ·{' '}
            {actions?.failed ?? '—'} failed
          </span>
        </div>
      </Panel>

      <Panel
        title="Dead letters"
        description="Deployments whose retry budget ran out, or whose failure no retry could fix. Nothing consumes this queue — an entry stays until someone deals with it."
      >
        <ErrorNote error={deadLetters.error ?? discard.error} />
        {parked.length === 0 ? (
          <Empty>Nothing has been dead-lettered.</Empty>
        ) : (
          <ul className="divide-y divide-[#1c202b]">
            {parked.map((entry) => (
              <li key={entry.jobId} className="flex flex-wrap items-center gap-3 py-2.5 text-xs">
                <Link
                  href={`/orgs/${orgSlug}/projects/${entry.projectId}`}
                  className="font-mono text-[#8b90a3] hover:text-[#e6e8ef]"
                >
                  {entry.deploymentId.slice(0, 8)}
                </Link>
                {entry.projectName && <span className="text-[#8b90a3]">{entry.projectName}</span>}
                <span className="font-mono text-[11px] uppercase text-red-300">
                  {entry.errorCode}
                </span>
                <span
                  className="text-[11px] text-[#6e7387]"
                  title={
                    entry.retryable
                      ? 'The failure was retryable; every attempt was spent'
                      : 'The failure would fail again, so the remaining attempts were not spent'
                  }
                >
                  {entry.retryable
                    ? `${entry.attempt} of ${entry.maxAttempts} attempts spent`
                    : 'not retryable'}
                </span>
                {/* The status *now*. A dead-lettered deployment that was later
                    retried successfully says `live`, and that is how someone
                    knows the entry is stale and safe to discard. */}
                {entry.currentStatus && entry.currentStatus !== 'failed' && (
                  <span className="flex items-center gap-1.5">
                    <span className="text-[11px] text-[#6e7387]">now</span>
                    <StatusBadge status={entry.currentStatus} />
                  </span>
                )}
                <span className="ml-auto flex items-center gap-3">
                  {entry.workerName && (
                    <span className="font-mono text-[11px] text-[#6e7387]">
                      {entry.workerName}
                    </span>
                  )}
                  <span className="text-[11px] text-[#6e7387]">{formatAgo(entry.failedAt)}</span>
                  {canDiscard && (
                    <Button
                      variant="secondary"
                      className="text-xs"
                      disabled={discard.isPending}
                      title="Remove this entry. The deployment row and its timeline are untouched."
                      onClick={() => discard.mutate(entry.jobId)}
                    >
                      Discard
                    </Button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel
        title="Workers"
        description={`${String(online.length)} online of ${String(workers.length)} seen recently. Every worker consumes the same queue, so BullMQ hands each job to exactly one of them. Add another with: pnpm cluster --workers 3`}
      >
        {workers.length === 0 ? (
          <Empty>No worker has heartbeated recently.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs uppercase tracking-wide text-[#6e7387]">
                <tr>
                  <th className="pb-2 pr-4 font-medium">Worker</th>
                  <th className="pb-2 pr-4 font-medium">Status</th>
                  <th className="pb-2 pr-4 font-medium">Host / pid</th>
                  <th className="pb-2 pr-4 font-medium">Concurrency</th>
                  <th className="pb-2 pr-4 font-medium">Running</th>
                  <th className="pb-2 pr-4 font-medium">Heartbeat</th>
                  <th className="pb-2 font-medium">Ran</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#1c202b]">
                {workers.map((worker) => (
                  <WorkerRow key={worker.id} worker={worker} orgSlug={orgSlug} />
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-3 border-t border-[#1c202b] pt-3 text-xs text-[#6e7387]">
          Kill a worker mid-build (<code className="font-mono text-[11px]">kill worker-2</code> in{' '}
          <code className="font-mono text-[11px]">pnpm cluster</code>) and its heartbeat key simply
          expires — it never gets to write &ldquo;offline&rdquo;. The job&rsquo;s lock stops being
          renewed, BullMQ returns it to the queue, and whichever worker picks it up next hands the
          deployment to itself and starts over. Watch the timeline for the line that says so.
        </p>
      </Panel>

      <Panel title="Recent deployments" description="Across every project in this organization.">
        {(activity.data ?? []).length === 0 ? (
          <Empty>Nothing has been deployed yet.</Empty>
        ) : (
          <ul className="divide-y divide-[#1c202b]">
            {(activity.data ?? []).map((deployment) => (
              <li key={deployment.id} className="flex flex-wrap items-center gap-3 py-2.5">
                <StatusBadge status={deployment.status} />
                <Link
                  href={`/orgs/${orgSlug}/projects/${deployment.projectId}`}
                  className="font-mono text-xs text-[#8b90a3] hover:text-[#e6e8ef]"
                >
                  {deployment.id.slice(0, 8)}
                </Link>
                {deployment.attempt > 1 && (
                  <span className="text-[11px] text-amber-300">
                    attempt {deployment.attempt} of {deployment.maxAttempts}
                  </span>
                )}
                {deployment.parentDeploymentId && (
                  <span
                    className="font-mono text-[11px] text-amber-300/80"
                    title={`Rolled back to ${deployment.parentDeploymentId.slice(0, 8)}`}
                  >
                    ↩ {deployment.parentDeploymentId.slice(0, 8)}
                  </span>
                )}
                {deployment.deadLetteredAt && (
                  <span className="text-[11px] text-red-400/80" title="In the dead-letter queue">
                    DLQ
                  </span>
                )}
                {deployment.workerId && (
                  <span
                    className="font-mono text-[11px] text-[#6e7387]"
                    title={`worker id ${deployment.workerId}`}
                  >
                    {/* The name, not the uuid: "which worker ran which
                        deployment" is only a useful answer if it names the
                        process you can go and kill. */}
                    {deployment.workerName ?? `worker ${deployment.workerId.slice(0, 8)}`}
                  </span>
                )}
                <span className="ml-auto text-xs text-[#6e7387]">
                  {formatAgo(deployment.queuedAt)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}

function Stat({
  label,
  value,
  text,
  tone,
  hint,
}: {
  label: string;
  value?: number | undefined;
  /** For a pre-formatted value (a duration), where `value` would be wrong. */
  text?: string;
  tone: string;
  hint?: string;
}) {
  return (
    <div className="rounded-lg border border-[#232734] bg-[#0d0f16] px-3 py-3">
      <p className="text-xs text-[#6e7387]">{label}</p>
      <p className={`mt-1 text-2xl font-semibold tabular-nums ${tone}`}>
        {text ?? value ?? '—'}
        {hint && <span className="ml-1.5 text-xs font-normal text-[#6e7387]">{hint}</span>}
      </p>
    </div>
  );
}

/** A dot + word, for the two-state facts that are not deployment statuses. */
function Dot({ on, label }: { on: boolean; label: string }) {
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs ${on ? 'text-emerald-300' : 'text-red-300'}`}>
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {label}
    </span>
  );
}

/**
 * One API replica.
 *
 * A card per replica rather than one table, for the same reason the metrics
 * page uses small multiples: three numbers per process read better side by
 * side than stacked in columns, and the count is small by construction (these
 * are processes on one laptop).
 */
function ReplicaCard({ replica, holdsSocket }: { replica: ApiReplica; holdsSocket: boolean }) {
  return (
    <div className="rounded-lg border border-[#232734] bg-[#0d0f16] p-3">
      <div className="flex items-baseline justify-between gap-2">
        <p className="truncate font-mono text-sm text-[#e6e8ef]" title={replica.instance}>
          {replica.instance}
        </p>
        {/* A WebSocket is pinned to whichever replica answered its upgrade —
            there is no fan-out *to* a socket except through Redis Pub/Sub, so
            saying which replica holds yours is a real fact about this tab. */}
        {holdsSocket && (
          <span className="shrink-0 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] text-emerald-300">
            holds your socket
          </span>
        )}
      </div>
      <p className="mt-0.5 font-mono text-[11px] text-[#6e7387]">
        {replica.host}:{replica.pid} · up {formatUptime(replica.uptimeMs)}
      </p>
      <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
        <Cell label="Sockets" value={String(replica.sockets)} />
        <Cell label="Req/s" value={replica.requestsPerSecond.toFixed(2)} />
        <Cell label="In flight" value={String(replica.inflight)} />
        <Cell label="CPU" value={`${replica.cpuPercent.toFixed(1)}%`} />
        <Cell label="RSS" value={formatBytes(replica.rssBytes)} />
        <Cell label="Sampled" value={formatAgo(replica.at)} />
      </dl>
    </div>
  );
}

function Cell({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="text-[#6e7387]">{label}</dt>
      <dd className="font-mono tabular-nums text-[#8b90a3]">{value}</dd>
    </div>
  );
}

/**
 * One worker, with its build history one click away.
 *
 * The drill-down is fetched only while it is open, and it is the direct answer
 * to Phase 10's "which worker ran which deployment": the org feed shows it from
 * the deployment's side, this shows it from the process's.
 */
function WorkerRow({ worker, orgSlug }: { worker: WorkerView; orgSlug: string }) {
  const [open, setOpen] = useState(false);

  const ran = useQuery({
    queryKey: ['worker-deployments', orgSlug, worker.id],
    queryFn: () =>
      api.get<Deployment[]>(`/orgs/${orgSlug}/workers/${worker.id}/deployments?limit=8`),
    enabled: open,
    // No polling: a worker's *history* only grows when a deployment finishes,
    // and the org topic already invalidates the page then.
    refetchInterval: false,
  });

  return (
    <>
      <tr>
        <td className="py-2.5 pr-4 font-mono text-xs">{worker.name}</td>
        <td className="py-2.5 pr-4">
          <span
            className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] ${
              !worker.online
                ? 'border-[#3a4056] bg-[#1a1e2a] text-[#8b90a3]'
                : worker.status === 'busy'
                  ? 'border-sky-500/40 bg-sky-500/10 text-sky-300'
                  : worker.status === 'draining'
                    ? 'border-amber-500/40 bg-amber-500/10 text-amber-300'
                    : 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
            }`}
          >
            <span
              className={`h-1.5 w-1.5 rounded-full ${worker.online ? 'bg-current' : 'bg-[#5f6478]'}`}
            />
            {worker.status}
          </span>
        </td>
        <td className="py-2.5 pr-4 font-mono text-xs text-[#8b90a3]">
          {worker.host}:{worker.pid}
        </td>
        <td className="py-2.5 pr-4 text-xs text-[#8b90a3]">{worker.concurrency}</td>
        <td className="py-2.5 pr-4 font-mono text-xs text-[#8b90a3]">
          {worker.currentDeploymentId ? worker.currentDeploymentId.slice(0, 8) : '—'}
        </td>
        <td className="py-2.5 pr-4 text-xs text-[#6e7387]">
          {worker.lastHeartbeatAt ? formatAgo(worker.lastHeartbeatAt) : '—'}
        </td>
        <td className="py-2.5">
          <Button
            variant="secondary"
            className="text-xs"
            onClick={() => setOpen((current) => !current)}
            title="This org's deployments that ran on this worker"
          >
            {open ? 'Hide' : 'Show'}
          </Button>
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={7} className="pb-3">
            <div className="rounded-lg border border-[#232734] bg-[#0d0f16] px-3 py-2">
              <ErrorNote error={ran.error} />
              {ran.isPending ? (
                <p className="py-1 text-xs text-[#6e7387]">Loading…</p>
              ) : (ran.data ?? []).length === 0 ? (
                <p className="py-1 text-xs text-[#6e7387]">
                  This worker has not run anything for this organization.
                </p>
              ) : (
                <ul className="divide-y divide-[#1c202b]">
                  {(ran.data ?? []).map((deployment) => (
                    <li
                      key={deployment.id}
                      className="flex flex-wrap items-center gap-3 py-1.5 text-xs"
                    >
                      <StatusBadge status={deployment.status} />
                      <Link
                        href={`/orgs/${orgSlug}/projects/${deployment.projectId}`}
                        className="font-mono text-[#8b90a3] hover:text-[#e6e8ef]"
                      >
                        {deployment.id.slice(0, 8)}
                      </Link>
                      {deployment.attempt > 1 && (
                        <span className="text-[11px] text-amber-300">
                          attempt {deployment.attempt}
                        </span>
                      )}
                      {deployment.errorCode && (
                        <span className="font-mono text-[11px] uppercase text-red-300">
                          {deployment.errorCode}
                        </span>
                      )}
                      <span className="ml-auto text-[11px] text-[#6e7387]">
                        {formatAgo(deployment.queuedAt)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
