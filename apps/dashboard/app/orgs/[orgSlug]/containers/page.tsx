'use client';

import Link from 'next/link';
import { use, useCallback, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  api,
  formatAgo,
  formatBytes,
  formatPercent,
  hasRole,
  type ContainerActionResult,
  type ContainerSummary,
} from '@/lib/api';
import { useOrgRole, useSession } from '@/components/session-provider';
import { useRealtime, useTopic } from '@/components/realtime-provider';
import { topics, type WsDataFrame } from '@/lib/realtime';
import { METRICS } from '@/lib/metrics';
import { Button, Empty, ErrorNote, Panel } from '@/components/ui/primitives';
import { StatusBadge } from '@/components/deployment-pipeline';

/**
 * Running containers: the app URL, the limits they run under, and live
 * CPU/memory.
 *
 * Everything here is event-driven since Phase 9. Status changes arrive on the
 * org topic (which carries every transition in the org), and so do the
 * container CPU/memory samples — the worker publishes each one as a `metric`
 * frame on the same channel. The REST poll is kept as a slow fallback for a
 * closed socket, and as the source of the fields that are not sampled at all
 * (the URL, the port mapping, the image tag).
 *
 * The samples ride the *org* channel rather than the global `metrics` topic
 * on purpose: `metrics` is readable by any authenticated member, and a
 * container belongs to one tenant.
 */
export default function ContainersPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);
  const role = useOrgRole(orgSlug);
  const canControl = hasRole(role, 'member');
  const { orgs } = useSession();
  const orgId = orgs.find((o) => o.slug === orgSlug || o.id === orgSlug)?.id ?? null;
  const { status: socketStatus } = useRealtime();
  const queryClient = useQueryClient();

  const containers = useQuery({
    queryKey: ['containers', orgSlug],
    queryFn: () => api.get<ContainerSummary[]>(`/orgs/${orgSlug}/containers`),
    // Only a fallback now that samples arrive as frames: with the socket open
    // the numbers below come from Pub/Sub, and this refresh is what keeps the
    // page correct if it is closed.
    refetchInterval: socketStatus === 'open' ? 15_000 : 3000,
  });

  /**
   * Live sample overlay, keyed by deployment id.
   *
   * Held in state rather than a ref because there are only a handful of
   * containers and each publishes a few frames every few seconds — nothing
   * like the metrics page's firehose, so a render per sample is fine and the
   * code stays a plain `setState`.
   */
  const [live, setLive] = useState<Record<string, LiveSample>>({});
  const seen = useRef(0);

  useTopic(
    socketStatus === 'open' && orgId ? topics.org(orgId) : null,
    useCallback(
      (frame: WsDataFrame) => {
        if (frame.type === 'metric') {
          // `container:<deploymentId>` — the only scope on this channel.
          if (!frame.scope.startsWith('container:')) return;
          const deploymentId = frame.scope.slice('container:'.length);
          seen.current += 1;
          setLive((current) => {
            const previous = current[deploymentId] ?? { at: frame.at };
            const next: LiveSample = { ...previous, at: frame.at };
            if (frame.name === METRICS.containerCpuPercent) next.cpuPercent = frame.value;
            if (frame.name === METRICS.containerMemoryBytes) next.memoryBytes = frame.value;
            if (frame.name === METRICS.containerMemoryPercent) next.memoryPercent = frame.value;
            if (frame.name === METRICS.containerPids) next.pids = frame.value;
            return { ...current, [deploymentId]: next };
          });
          return;
        }
        // A deployment going live or stopping changes *which* containers exist.
        if (frame.type !== 'status') return;
        void queryClient.invalidateQueries({ queryKey: ['containers', orgSlug] });
      },
      [queryClient, orgSlug],
    ),
  );

  const list = containers.data ?? [];
  const running = list.filter((c) => c.status === 'live');

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold tracking-tight">Containers</h1>
        <p className="mt-1 text-sm text-[#8b90a3]">
          Deployments running under Docker. Each one is non-root, capped on memory, CPU and pids,
          with all capabilities dropped and no host network.
        </p>
      </div>
      <ErrorNote error={containers.error} />

      <Panel
        title={`Running (${String(running.length)})`}
        description="Postgres says what should be running; the CPU/memory samples are written to Redis by a worker, because the API is not allowed to talk to Docker."
      >
        {containers.isPending ? (
          <Empty>Loading containers…</Empty>
        ) : list.length === 0 ? (
          <Empty>
            Nothing is running. Deploy a project and its container shows up here once it is live.
          </Empty>
        ) : (
          <ul className="space-y-3">
            {list.map((container) => (
              <ContainerCard
                key={container.deploymentId}
                orgSlug={orgSlug}
                container={container}
                live={live[container.deploymentId]}
                canControl={canControl}
              />
            ))}
          </ul>
        )}
        {!canControl && (
          <p className="mt-4 text-xs text-[#6e7387]">
            Stopping and restarting a container requires the “member” role.
          </p>
        )}
      </Panel>
    </div>
  );
}

/** The fields a `metric` frame can refresh between REST reads. */
type LiveSample = {
  cpuPercent?: number;
  memoryBytes?: number;
  memoryPercent?: number;
  pids?: number;
  at: string;
};

function ContainerCard({
  orgSlug,
  container,
  live,
  canControl,
}: {
  orgSlug: string;
  container: ContainerSummary;
  live: LiveSample | undefined;
  canControl: boolean;
}) {
  const queryClient = useQueryClient();
  const base = `/orgs/${orgSlug}/projects/${container.projectId}/deployments/${container.deploymentId}`;

  const act = useMutation({
    mutationFn: (action: 'stop' | 'restart') =>
      api.post<ContainerActionResult>(`${base}/${action}`, {}),
    onSuccess: () => {
      // The worker does the work; the row changes when it is done, and the org
      // topic tells us. This only makes the button feel responsive.
      void queryClient.invalidateQueries({ queryKey: ['containers', orgSlug] });
    },
  });

  /**
   * The published sample wins over the polled one.
   *
   * Both come from the same worker writing the same reading — one to a Redis
   * key the API reads, one to a channel this page is subscribed to — so
   * preferring the frame is just preferring the fresher copy of one fact, not
   * mixing two sources. Everything the frames do not carry (the memory cap,
   * the pids limit, the Docker state) still comes from the REST row.
   */
  const polled = container.stats;
  const stats =
    polled === null
      ? null
      : {
          ...polled,
          cpuPercent: live?.cpuPercent ?? polled.cpuPercent,
          memoryBytes: live?.memoryBytes ?? polled.memoryBytes,
          memoryPercent: live?.memoryPercent ?? polled.memoryPercent,
          pids: live?.pids ?? polled.pids,
          at: live?.at ?? polled.at,
        };

  return (
    <li className="rounded-xl border border-[#232734] bg-[#0d0f16] p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={container.status} />
            <Link
              href={`/orgs/${orgSlug}/projects/${container.projectId}`}
              className="text-sm font-medium hover:text-emerald-300"
            >
              {container.projectName}
            </Link>
            {container.isActive && (
              <span className="rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[11px] text-emerald-300">
                active
              </span>
            )}
            {container.attempt > 1 && (
              <span className="text-[11px] text-amber-300">attempt {container.attempt}</span>
            )}
          </div>
          <p className="mt-1 font-mono text-[11px] text-[#6e7387]">
            {container.deploymentId.slice(0, 8)}
            {container.containerId && ` · ${container.containerId.slice(0, 12)}`}
            {container.imageTag && ` · ${container.imageTag}`}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {container.url && (
            <a
              href={`${container.url}${container.healthPath}`}
              target="_blank"
              rel="noreferrer"
              className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm font-medium text-emerald-300 hover:bg-emerald-500/20"
            >
              Open {container.url.replace('http://', '')} ↗
            </a>
          )}
          {canControl && container.status === 'live' && (
            <>
              <Button
                variant="secondary"
                className="text-xs"
                disabled={act.isPending}
                onClick={() => act.mutate('restart')}
              >
                Restart
              </Button>
              <Button
                variant="danger"
                className="text-xs"
                disabled={act.isPending}
                onClick={() => act.mutate('stop')}
              >
                Stop
              </Button>
            </>
          )}
        </div>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Meter
          label="CPU"
          value={stats ? formatPercent(stats.cpuPercent) : '—'}
          percent={stats?.cpuPercent ?? null}
        />
        <Meter
          label="Memory"
          value={
            stats
              ? `${formatBytes(stats.memoryBytes)} / ${formatBytes(stats.memoryLimitBytes)}`
              : '—'
          }
          percent={stats?.memoryPercent ?? null}
        />
        <Meter
          label="Processes"
          value={stats ? `${String(stats.pids)} / ${String(stats.pidsLimit)}` : '—'}
          percent={stats ? (stats.pids / Math.max(1, stats.pidsLimit)) * 100 : null}
        />
        <div>
          <p className="text-[11px] text-[#6e7387]">Port</p>
          <p className="mt-1 font-mono text-sm text-[#e6e8ef]">
            {container.hostPort === null
              ? '—'
              : `${String(container.hostPort)} → ${String(container.appPort)}`}
          </p>
        </div>
      </div>

      <p className="mt-3 text-[11px] text-[#6e7387]">
        {container.liveSince ? `Live since ${formatAgo(container.liveSince)}` : 'Starting up'}
        {stats
          ? ` · docker state "${stats.state}" · sampled ${formatAgo(stats.at)}`
          : ' · no stats sample yet (the worker samples every few seconds)'}
      </p>
      <ErrorNote error={act.error} />
      {act.data && !act.data.enqueued && (
        <p className="mt-2 text-xs text-[#8b90a3]">{act.data.message}</p>
      )}
    </li>
  );
}

/** A labelled value with a bar, so a limit being approached is visible. */
function Meter({
  label,
  value,
  percent,
}: {
  label: string;
  value: string;
  percent: number | null;
}) {
  const clamped = percent === null ? null : Math.max(0, Math.min(100, percent));
  const tone =
    clamped === null
      ? 'bg-[#2c3142]'
      : clamped > 90
        ? 'bg-red-400'
        : clamped > 70
          ? 'bg-amber-400'
          : 'bg-emerald-400';

  return (
    <div>
      <p className="text-[11px] text-[#6e7387]">{label}</p>
      <p className="mt-1 font-mono text-sm text-[#e6e8ef]">{value}</p>
      <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-[#1c202b]">
        <div
          className={`h-full rounded-full transition-[width] duration-500 ${tone}`}
          style={{ width: `${String(clamped ?? 0)}%` }}
        />
      </div>
    </div>
  );
}
