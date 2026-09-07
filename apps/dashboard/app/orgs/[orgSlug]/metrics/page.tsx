'use client';

import Link from 'next/link';
import { use, useCallback, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRealtime, useTopic } from '@/components/realtime-provider';
import { useSession } from '@/components/session-provider';
import { topics, type WsDataFrame } from '@/lib/realtime';
import {
  api,
  formatAgo,
  formatBytes,
  formatDuration,
  formatUptime,
  STATUS_LABELS,
  type DeploymentStatus,
  type MetricsSnapshot,
  type ProcessMetrics,
} from '@/lib/api';
import {
  MetricSeries,
  METRICS,
  liveScopes,
  processScope,
  seedFromSnapshot,
  type Point,
} from '@/lib/metrics';
import { BarList, DataTable, StatTile, TimeChart, VIZ } from '@/components/ui/charts';
import { Button, Empty, ErrorNote, Panel } from '@/components/ui/primitives';

/**
 * The observability view (ROADMAP Phase 9).
 *
 * Two data paths, deliberately, because the numbers have two different costs:
 *
 *  - the **snapshot** (`GET /orgs/:orgId/metrics`) is one consistent read of
 *    process documents, queue counters and Postgres aggregates. It is polled
 *    slowly — the aggregates are `GROUP BY`s over a window and are not free.
 *  - the **`metrics` topic** carries individual samples several times a
 *    second, and every chart's series is built here in the browser from them.
 *
 * That is why the tiles have values the instant the page opens and the charts
 * fill in from the left: the tiles are the snapshot, the lines are the stream.
 * Storing sample history server-side to pre-fill them would mean writing every
 * reading to Postgres forever to serve a view of the last five minutes.
 *
 * Container CPU/memory arrives on the **org** topic rather than `metrics`:
 * `metrics` is readable by any authenticated member, and a container belongs
 * to one tenant.
 */

/** Presets, shortest first — the range a reader reaches for is a preset. */
const WINDOWS = [
  { minutes: 15, label: '15m' },
  { minutes: 60, label: '1h' },
  { minutes: 360, label: '6h' },
  { minutes: 1440, label: '24h' },
] as const;

/** Paint cadence. Frames arrive faster than this; the DOM does not need to. */
const PAINT_MS = 500;

const formatCount = (value: number): string => Math.round(value).toLocaleString();
const formatMs = (value: number): string =>
  value >= 1000 ? `${(value / 1000).toFixed(1)}s` : `${value.toFixed(value < 10 ? 1 : 0)}ms`;
const formatPct = (value: number): string => `${value.toFixed(value < 10 ? 1 : 0)}%`;

export default function MetricsPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);
  const { orgs } = useSession();
  const { status: socketStatus, instance: socketInstance } = useRealtime();
  const queryClient = useQueryClient();
  const orgId = orgs.find((o) => o.slug === orgSlug || o.id === orgSlug)?.id ?? null;

  const [windowMinutes, setWindowMinutes] = useState<number>(60);
  const [showTables, setShowTables] = useState(false);

  /**
   * The series buffer.
   *
   * A ref rather than state: frames land several times a second across a dozen
   * series, and one `setState` per frame would re-render the page on every
   * one. The buffer is mutated in place and the page repaints on its own timer
   * below — high-frequency data, low-frequency paint.
   */
  const seriesRef = useRef<MetricSeries>(new MetricSeries());
  const [, repaint] = useState(0);
  const seededRef = useRef<string | null>(null);
  const [activity, setActivity] = useState<ActivityEntry[]>([]);

  const snapshot = useQuery({
    queryKey: ['metrics', orgSlug, windowMinutes],
    queryFn: () =>
      api.get<MetricsSnapshot>(`/orgs/${orgSlug}/metrics?windowMinutes=${String(windowMinutes)}`),
    // The Postgres aggregates in here are the expensive half; 5s is often
    // enough for counts, and the live half comes over the socket.
    refetchInterval: 5000,
  });

  // Seed the charts from the first snapshot so nothing is blank on load, and
  // re-seed when the window changes (a different query, a different response).
  const snapshotData = snapshot.data;
  useEffect(() => {
    if (!snapshotData) return;
    const stamp = `${orgSlug}:${String(windowMinutes)}`;
    if (seededRef.current === stamp) {
      // Drop series whose process/container/queue is gone, so a restarted
      // worker does not leave a flat line pretending to be alive.
      seriesRef.current.retain(liveScopes(snapshotData));
      return;
    }
    seededRef.current = stamp;
    seedFromSnapshot(seriesRef.current, snapshotData);
    repaint((value) => value + 1);
  }, [snapshotData, orgSlug, windowMinutes]);

  // Repaint on a timer, and only when a frame actually arrived.
  useEffect(() => {
    let last = seriesRef.current.version;
    const timer = setInterval(() => {
      const version = seriesRef.current.version;
      if (version === last) return;
      last = version;
      repaint((value) => value + 1);
    }, PAINT_MS);
    return () => {
      clearInterval(timer);
    };
  }, []);

  const onFrame = useCallback((frame: WsDataFrame) => {
    if (frame.type !== 'metric') return;
    seriesRef.current.push(frame.scope, frame.name, frame.value, frame.at);
  }, []);

  // Infrastructure-wide samples: process CPU/memory/event-loop lag, queue depth.
  useTopic(socketStatus === 'open' ? topics.metrics : null, onFrame);

  /**
   * The org topic does double duty: container samples (tenant-scoped, so they
   * cannot ride `metrics`) and the pipeline transitions the activity feed is
   * made of.
   */
  useTopic(
    socketStatus === 'open' && orgId ? topics.org(orgId) : null,
    useCallback(
      (frame: WsDataFrame) => {
        if (frame.type === 'metric') {
          seriesRef.current.push(frame.scope, frame.name, frame.value, frame.at);
          return;
        }
        if (frame.type !== 'status') return;
        setActivity((entries) =>
          [
            {
              id: frame.eventId,
              deploymentId: frame.deploymentId,
              projectId: frame.projectId,
              status: frame.status,
              message: frame.message,
              at: frame.at,
            },
            ...entries,
          ].slice(0, 40),
        );
        // A transition changes the counts the snapshot reports, so pull a fresh
        // one rather than waiting out the poll interval.
        void queryClient.invalidateQueries({ queryKey: ['metrics', orgSlug] });
      },
      [queryClient, orgSlug],
    ),
  );

  const series = seriesRef.current;
  const data = snapshot.data;
  const apiProcesses = (data?.processes ?? []).filter((process) => process.role === 'api');
  const workerProcesses = (data?.processes ?? []).filter((process) => process.role === 'worker');
  const deployments = data?.deployments;
  const queue = data?.queues[0];
  const dlq = data?.queues[1];
  const actions = data?.queues[2];

  const queueScope = queue ? `queue:${queue.name}` : 'queue:deployments';
  /**
   * Series are read fresh on every paint rather than memoised: the buffer is
   * mutated in place, so a `useMemo` keyed on it would never invalidate — and
   * this component only re-renders when a frame actually arrived.
   *
   * Colours are assigned by *what the series is*, not by its position in the
   * list, so a queue with nothing delayed does not repaint the other two.
   */
  const queueSeries = [
    {
      key: 'waiting',
      label: 'Waiting',
      color: VIZ.series[0],
      points: series.get(queueScope, METRICS.queueWaiting),
    },
    {
      key: 'active',
      label: 'Active',
      color: VIZ.series[1],
      points: series.get(queueScope, METRICS.queueActive),
    },
    {
      key: 'delayed',
      label: 'Delayed (backoff)',
      color: VIZ.series[2],
      points: series.get(queueScope, METRICS.queueDelayed),
    },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold tracking-tight">Metrics</h1>
        <p className="mt-1 text-sm text-[#8b90a3]">
          Event-loop lag, CPU and memory per process, queue depth, deployment durations and
          per-container stats. Every process writes its own numbers to Redis under a TTL, so this
          page shows the whole fleet no matter which API replica served it.
        </p>
      </div>

      {/* Filters: one row, above everything they scope. Range first. */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1 rounded-lg border border-[#2c3142] bg-[#0d0f16] p-1">
          {WINDOWS.map((option) => (
            <button
              key={option.minutes}
              type="button"
              onClick={() => setWindowMinutes(option.minutes)}
              className={`rounded px-2.5 py-1 text-xs transition-colors ${
                windowMinutes === option.minutes
                  ? 'bg-[#1a1e2a] text-[#e6e8ef]'
                  : 'text-[#8b90a3] hover:text-[#e6e8ef]'
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>
        <span className="text-xs text-[#6e7387]">
          window for the deployment aggregates; the charts always show the live stream
        </span>
        <div className="ml-auto flex items-center gap-3">
          <DependencyChips snapshot={data} />
          <Button variant="ghost" className="text-xs" onClick={() => setShowTables((on) => !on)}>
            {showTables ? 'Hide numbers' : 'Show numbers'}
          </Button>
        </div>
      </div>

      <ErrorNote error={snapshot.error} />

      {socketStatus !== 'open' && (
        <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
          The WebSocket is {socketStatus}, so the charts are not receiving samples. The tiles below
          still update from the REST snapshot every 5 seconds.
        </p>
      )}

      {/* --- headline counts --- */}
      <Panel
        title="Deployments"
        description={`Created in the last ${String(deployments?.windowMinutes ?? windowMinutes)} minutes. "Succeeded" means the deployment reached "live" at some point — not that it is live now, so a rollback does not count as an outage.`}
      >
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <StatTile label="Total" value={deployments ? formatCount(deployments.total) : '—'} />
          <StatTile
            label="Succeeded"
            value={deployments ? formatCount(deployments.succeeded) : '—'}
            tone="text-emerald-300"
          />
          <StatTile
            label="Failed"
            value={deployments ? formatCount(deployments.failed) : '—'}
            tone={deployments && deployments.failed > 0 ? 'text-red-300' : 'text-[#e6e8ef]'}
          />
          <StatTile
            label="Success rate"
            value={
              deployments?.successRate === null || deployments === undefined
                ? '—'
                : formatPct(deployments.successRate * 100)
            }
            hint={
              deployments?.successRate === null
                ? 'nothing has settled in this window'
                : `${String(deployments?.inFlight ?? 0)} still in flight`
            }
          />
          <StatTile
            label="Retried"
            value={deployments ? formatCount(deployments.retried) : '—'}
            tone={deployments && deployments.retried > 0 ? 'text-amber-300' : 'text-[#e6e8ef]'}
            hint="ran more than once"
          />
          <StatTile
            label="Dead-lettered"
            value={deployments ? formatCount(deployments.deadLettered) : '—'}
            tone={deployments && deployments.deadLettered > 0 ? 'text-red-300' : 'text-[#e6e8ef]'}
            hint="retry budget spent"
          />
        </div>

        <div className="mt-5 grid gap-6 lg:grid-cols-2">
          <div>
            <h3 className="text-xs font-medium text-[#8b90a3]">Duration</h3>
            <p className="mt-1 text-[11px] text-[#6e7387]">
              Wall clock from claim to settle, over {deployments?.duration.count ?? 0} finished
              deployments. Percentiles rather than an average: one cold <code>npm install</code> is
              worth thirty warm ones.
            </p>
            <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <StatTile label="p50" value={formatDuration(deployments?.duration.p50Ms ?? null)} />
              <StatTile label="p95" value={formatDuration(deployments?.duration.p95Ms ?? null)} />
              <StatTile label="Max" value={formatDuration(deployments?.duration.maxMs ?? null)} />
              <StatTile label="Mean" value={formatDuration(deployments?.duration.meanMs ?? null)} />
            </div>
          </div>

          <div>
            <h3 className="text-xs font-medium text-[#8b90a3]">Failures by error code</h3>
            <p className="mt-1 text-[11px] text-[#6e7387]">
              Grouped by the stage error the pipeline recorded — the label a failure is greppable
              by in the logs.
            </p>
            <div className="mt-3">
              <BarList
                data={(deployments?.failuresByCode ?? []).map((bucket) => ({
                  key: bucket.code,
                  label: bucket.code,
                  value: bucket.count,
                  // A status colour, and legitimately so: every bar here *is*
                  // a failure, and the code beside it carries the identity.
                  color: VIZ.status.critical,
                }))}
                empty="No failures in this window."
              />
            </div>
          </div>
        </div>

        {showTables && deployments && (
          <div className="mt-5 border-t border-[#1c202b] pt-4">
            <DataTable
              columns={['Status', 'Count']}
              rows={Object.entries(deployments.byStatus).map(([status, count]) => [
                STATUS_LABELS[status as DeploymentStatus],
                count ?? 0,
              ])}
            />
          </div>
        )}
      </Panel>

      {/* --- queue --- */}
      <Panel
        title="Queue depth"
        description="BullMQ counters, sampled by whichever process wins the publisher election each tick — one publisher, so the chart is the real depth rather than N replicas' worth of it."
      >
        <TimeChart series={queueSeries} height={160} format={formatCount} />
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatTile label="Waiting" value={queue ? formatCount(queue.waiting) : '—'} />
          <StatTile
            label="Active"
            value={queue ? formatCount(queue.active) : '—'}
            tone="text-sky-300"
          />
          <StatTile
            label="Dead-letter queue"
            value={dlq ? formatCount(dlq.waiting) : '—'}
            tone={dlq && dlq.waiting > 0 ? 'text-red-300' : 'text-[#e6e8ef]'}
            hint="parked, nothing consumes it"
          />
          <StatTile
            label="Container actions"
            value={actions ? formatCount(actions.waiting + actions.active) : '—'}
            hint="stop / restart requests"
          />
        </div>
        {queue && !queue.available && (
          <p className="mt-3 text-xs text-red-300">
            Queue counters are unavailable — Redis is not answering. The chart holds its last
            samples rather than dropping to zero, because an unreadable queue is not an empty one.
          </p>
        )}
        {showTables && data && (
          <div className="mt-4 border-t border-[#1c202b] pt-4">
            <DataTable
              columns={['Queue', 'Waiting', 'Active', 'Delayed', 'Completed', 'Failed', 'Readable']}
              rows={data.queues.map((row) => [
                row.name,
                row.waiting,
                row.active,
                row.delayed,
                row.completed,
                row.failed,
                row.available ? 'yes' : 'no',
              ])}
            />
          </div>
        )}
      </Panel>

      {/* --- processes: small multiples, one card each --- */}
      <Panel
        title={`Processes (${String(data?.processes.length ?? 0)})`}
        description="One card per live process rather than one chart with every process on it: past a few series a shared plot becomes a colour-matching puzzle, and these are the same measurements side by side."
      >
        {(data?.processes ?? []).length === 0 ? (
          <Empty>
            No process is reporting. Metrics are disabled when METRICS_INTERVAL_MS=0, and a
            process&apos;s document expires a few seconds after it stops.
          </Empty>
        ) : (
          <div className="grid gap-4 xl:grid-cols-2">
            {[...apiProcesses, ...workerProcesses].map((process) => (
              <ProcessCard
                key={processScope(process)}
                process={process}
                series={series}
                servedBy={data?.servedBy}
                socketInstance={socketInstance}
                showTable={showTables}
              />
            ))}
          </div>
        )}
      </Panel>

      {/* --- containers --- */}
      <Panel
        title={`Containers (${String(data?.containers.length ?? 0)})`}
        description="Sampled from the Docker API by whichever worker holds the sampler lease, published on this organization's own channel — never on the global metrics topic, which any member can read."
      >
        {(data?.containers ?? []).length === 0 ? (
          <Empty>Nothing is running, or no worker has sampled a container yet.</Empty>
        ) : (
          <div className="space-y-4">
            {(data?.containers ?? []).map((container) => {
              const scope = `container:${container.deploymentId}`;
              return (
                <div
                  key={container.deploymentId}
                  className="rounded-lg border border-[#232734] bg-[#0d0f16] p-4"
                >
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <p className="font-mono text-[11px] text-[#8b90a3]">
                      {container.deploymentId.slice(0, 8)} ·{' '}
                      {container.containerId.slice(0, 12)} · docker state &ldquo;
                      {container.state}&rdquo;
                    </p>
                    <p className="text-[11px] text-[#6e7387]">sampled {formatAgo(container.at)}</p>
                  </div>
                  <div className="mt-3 grid gap-4 sm:grid-cols-2">
                    <div>
                      <h4 className="text-[11px] text-[#6e7387]">
                        CPU and memory, percent of the container&apos;s cap
                      </h4>
                      <TimeChart
                        height={110}
                        format={formatPct}
                        series={[
                          {
                            key: `${scope}-cpu`,
                            label: 'CPU',
                            color: VIZ.series[0],
                            points: series.get(scope, METRICS.containerCpuPercent),
                          },
                          {
                            key: `${scope}-mem`,
                            label: 'Memory',
                            color: VIZ.series[1],
                            points: series.get(scope, METRICS.containerMemoryPercent),
                          },
                        ]}
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-3 self-start">
                      <StatTile label="CPU" value={formatPct(container.cpuPercent)} />
                      <StatTile
                        label="Memory"
                        value={formatBytes(container.memoryBytes)}
                        hint={`of ${formatBytes(container.memoryLimitBytes)}`}
                      />
                      <StatTile
                        label="Processes"
                        value={`${String(container.pids)} / ${String(container.pidsLimit)}`}
                      />
                      <StatTile
                        label="Memory used"
                        value={formatPct(container.memoryPercent)}
                        tone={
                          container.memoryPercent > 90
                            ? 'text-red-300'
                            : container.memoryPercent > 70
                              ? 'text-amber-300'
                              : 'text-[#e6e8ef]'
                        }
                      />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Panel>

      {/* --- system activity --- */}
      <Panel
        title="System activity"
        description="Every pipeline transition in this organization, as it is published. Event-driven, not polled — this is the same stream the deployment pages read."
      >
        {activity.length === 0 ? (
          <Empty>
            {socketStatus === 'open'
              ? 'Nothing has happened since this page opened. Deploy something and it shows up here.'
              : 'Waiting for the WebSocket.'}
          </Empty>
        ) : (
          <ul className="divide-y divide-[#1c202b]">
            {activity.map((entry) => (
              <li key={entry.id} className="flex flex-wrap items-baseline gap-3 py-2 text-xs">
                <span className="w-[7.5rem] shrink-0 text-[#e6e8ef]">
                  {STATUS_LABELS[entry.status]}
                </span>
                <Link
                  href={`/orgs/${orgSlug}/projects/${entry.projectId}`}
                  className="font-mono text-[11px] text-[#8b90a3] hover:text-[#e6e8ef]"
                >
                  {entry.deploymentId.slice(0, 8)}
                </Link>
                {entry.message && (
                  <span className="min-w-0 flex-1 truncate text-[11px] text-[#6e7387]">
                    {entry.message}
                  </span>
                )}
                <span className="ml-auto text-[11px] text-[#6e7387]">
                  {new Date(entry.at).toLocaleTimeString()}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <p className="text-[11px] text-[#6e7387]">
        Snapshot served by <code className="font-mono">{data?.servedBy ?? '—'}</code>
        {data && ` · ${formatAgo(data.at)}`} ·{' '}
        <code className="font-mono">GET /metrics</code> exposes the same numbers in Prometheus text
        format.
      </p>
    </div>
  );
}

type ActivityEntry = {
  id: number;
  deploymentId: string;
  projectId: string;
  status: DeploymentStatus;
  message: string | null;
  at: string;
};

/** Postgres/Redis reachability, from the same probes `/health` runs. */
function DependencyChips({ snapshot }: { snapshot: MetricsSnapshot | undefined }) {
  const rows: [string, { ok: boolean; latencyMs: number } | undefined][] = [
    ['Postgres', snapshot?.dependencies.postgres],
    ['Redis', snapshot?.dependencies.redis],
  ];
  return (
    <span className="flex items-center gap-2">
      {rows.map(([label, check]) => (
        <span
          key={label}
          title={check ? `${label}: ${String(check.latencyMs)} ms` : label}
          className={`flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] ${
            !check
              ? 'border-[#3a4056] bg-[#1a1e2a] text-[#8b90a3]'
              : check.ok
                ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
                : 'border-red-500/40 bg-red-500/10 text-red-300'
          }`}
        >
          <span className="h-1.5 w-1.5 rounded-full bg-current" />
          {label}
          {check && <span className="text-[10px] opacity-70">{check.latencyMs}ms</span>}
        </span>
      ))}
    </span>
  );
}

/**
 * One process: its identity, its event loop, its memory, and whichever
 * role-specific counters it has.
 *
 * Event-loop lag is the chart that gets the most room, because it is the one
 * measurement that says something a CPU graph cannot: whether this process is
 * *responsive*. A worker spawning `npm install` and streaming its output is
 * exactly where a blocked loop shows up, and p99 moves for it while the mean
 * barely does.
 */
function ProcessCard({
  process,
  series,
  servedBy,
  socketInstance,
  showTable,
}: {
  process: ProcessMetrics;
  series: MetricSeries;
  servedBy: string | undefined;
  socketInstance: string | null;
  showTable: boolean;
}) {
  const scope = processScope(process);
  const lag = [
    {
      key: `${scope}-p50`,
      label: 'p50',
      color: VIZ.series[0],
      points: series.get(scope, METRICS.eventLoopLagP50),
    },
    {
      key: `${scope}-p99`,
      label: 'p99',
      color: VIZ.series[2],
      points: series.get(scope, METRICS.eventLoopLagP99),
    },
  ];
  const memory = [
    {
      key: `${scope}-rss`,
      label: 'RSS',
      color: VIZ.series[0],
      points: series.get(scope, METRICS.rssBytes),
    },
    {
      key: `${scope}-heap`,
      label: 'Heap used',
      color: VIZ.series[1],
      points: series.get(scope, METRICS.heapUsedBytes),
    },
  ];
  const cpu: Point[] = series.get(scope, METRICS.cpuPercent);

  return (
    <div className="rounded-lg border border-[#232734] bg-[#0d0f16] p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={`rounded-full border px-2 py-0.5 text-[11px] ${
              process.role === 'api'
                ? 'border-sky-500/40 bg-sky-500/10 text-sky-300'
                : 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
            }`}
          >
            {process.role}
          </span>
          <span className="font-mono text-xs text-[#e6e8ef]">{process.instance}</span>
          {servedBy === process.instance && (
            <span className="text-[10px] text-[#6e7387]" title="This process served the snapshot">
              serving this page
            </span>
          )}
          {socketInstance === process.instance && (
            <span className="text-[10px] text-[#6e7387]" title="This process holds your WebSocket">
              holds your socket
            </span>
          )}
        </div>
        <p className="font-mono text-[10px] text-[#6e7387]">
          {/* The default instance id is already "<host>-<pid>", so repeating
              the host here would print the same string twice; it is only
              worth showing when the instance was named explicitly
              (API_INSTANCE_ID / WORKER_NAME) and no longer says where it
              runs. */}
          {process.instance.startsWith(process.host)
            ? `pid ${String(process.pid)}`
            : `${process.host}:${String(process.pid)}`}{' '}
          · {process.nodeVersion} · up {formatUptime(process.uptimeMs)}
        </p>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile
          label="CPU"
          value={formatPct(process.cpuPercent)}
          hint="percent of one core"
          trend={cpu}
          trendFormat={formatPct}
        />
        <StatTile
          label="Loop utilisation"
          value={formatPct(process.eventLoopUtilization * 100)}
          hint="busy, not waiting on IO"
          tone={
            process.eventLoopUtilization > 0.9
              ? 'text-red-300'
              : process.eventLoopUtilization > 0.7
                ? 'text-amber-300'
                : 'text-[#e6e8ef]'
          }
        />
        <StatTile label="RSS" value={formatBytes(process.rssBytes)} hint="resident set size" />
        <StatTile
          label="Handles"
          value={formatCount(process.activeResources)}
          hint="keeping the loop alive"
        />
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <div>
          <h4 className="text-[11px] text-[#6e7387]">
            Event-loop delay (from perf_hooks, reset each tick)
          </h4>
          <TimeChart series={lag} height={110} format={formatMs} />
        </div>
        <div>
          <h4 className="text-[11px] text-[#6e7387]">Memory</h4>
          <TimeChart series={memory} height={110} format={formatBytes} />
        </div>
      </div>

      {process.api && (
        <div className="mt-4 grid grid-cols-2 gap-3 border-t border-[#1c202b] pt-4 sm:grid-cols-4">
          <StatTile
            label="Requests/s"
            value={process.api.requestsPerSecond.toFixed(1)}
            trend={series.get(scope, METRICS.httpRequestsPerSecond)}
          />
          <StatTile
            label="Latency p95"
            value={formatMs(process.api.latencyMs.p95)}
            hint={`p50 ${formatMs(process.api.latencyMs.p50)}`}
            trend={series.get(scope, METRICS.httpLatencyP95)}
            trendFormat={formatMs}
          />
          <StatTile
            label="WebSockets"
            value={formatCount(process.api.sockets)}
            hint={`${String(process.api.topics)} topics · ${String(process.api.pubsubChannels)} channels`}
            trend={series.get(scope, METRICS.wsSockets)}
            trendFormat={formatCount}
          />
          <StatTile
            label="Errors"
            value={`${String(process.api.clientErrors)} / ${String(process.api.serverErrors)}`}
            hint="4xx / 5xx this interval"
            tone={process.api.serverErrors > 0 ? 'text-red-300' : 'text-[#e6e8ef]'}
          />
        </div>
      )}

      {process.worker && (
        <div className="mt-4 grid grid-cols-2 gap-3 border-t border-[#1c202b] pt-4 sm:grid-cols-4">
          <StatTile
            label="Active jobs"
            value={`${String(process.worker.activeJobs)} / ${String(process.worker.concurrency)}`}
            trend={series.get(scope, METRICS.workerActiveJobs)}
            trendFormat={formatCount}
          />
          <StatTile
            label="Builds running"
            value={formatCount(process.worker.activeBuilds)}
            hint="child_process trees"
            trend={series.get(scope, METRICS.workerActiveBuilds)}
            trendFormat={formatCount}
          />
          <StatTile label="Status" value={process.worker.status} />
          <StatTile
            label="Docker"
            value={process.worker.dockerAvailable ? 'reachable' : 'unavailable'}
            tone={process.worker.dockerAvailable ? 'text-emerald-300' : 'text-red-300'}
          />
        </div>
      )}

      {showTable && (
        <div className="mt-4 border-t border-[#1c202b] pt-4">
          <DataTable
            columns={['Measure', 'Value']}
            rows={[
              ['CPU % (user)', process.userCpuPercent],
              ['CPU % (system)', process.systemCpuPercent],
              ['Loop lag mean (ms)', process.eventLoopLag.meanMs],
              ['Loop lag p50 (ms)', process.eventLoopLag.p50Ms],
              ['Loop lag p99 (ms)', process.eventLoopLag.p99Ms],
              ['Loop lag max (ms)', process.eventLoopLag.maxMs],
              ['RSS (bytes)', process.rssBytes],
              ['Heap used (bytes)', process.heapUsedBytes],
              ['Heap total (bytes)', process.heapTotalBytes],
              ['External (bytes)', process.externalBytes],
              ['Sampled over (ms)', process.sampledOverMs],
            ]}
          />
        </div>
      )}
    </div>
  );
}
