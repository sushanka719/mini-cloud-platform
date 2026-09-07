'use client';

import Link from 'next/link';
import { use, useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRealtime, useTopic } from '@/components/realtime-provider';
import { useSession } from '@/components/session-provider';
import { topics } from '@/lib/realtime';
import { api, formatAgo, type Deployment, type Fleet } from '@/lib/api';
import { Empty, ErrorNote, Panel } from '@/components/ui/primitives';
import { StatusBadge } from '@/components/deployment-pipeline';

/**
 * Queue depth + worker fleet.
 *
 * Everything here is read from shared state — BullMQ counters in Redis and the
 * `workers` registry in Postgres — so it looks identical from any API replica.
 * Liveness comes from the worker's Redis heartbeat TTL, not from the row: a
 * SIGKILLed worker can't write "offline", but its key still expires.
 */
export default function FleetPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);
  const queryClient = useQueryClient();
  const { orgs } = useSession();
  const { status: socketStatus } = useRealtime();
  const orgId = orgs.find((o) => o.slug === orgSlug || o.id === orgSlug)?.id ?? null;

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

  useTopic(
    socketStatus === 'open' && orgId ? topics.org(orgId) : null,
    useCallback(() => {
      void queryClient.invalidateQueries({ queryKey: ['org-deployments', orgSlug] });
      void queryClient.invalidateQueries({ queryKey: ['fleet', orgSlug] });
    }, [queryClient, orgSlug]),
  );

  const queue = fleet.data?.queue;
  const workers = fleet.data?.workers ?? [];
  const online = workers.filter((w) => w.online);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold tracking-tight">Fleet</h1>
        <p className="mt-1 text-sm text-[#8b90a3]">
          The <code className="font-mono text-xs">deployments</code> queue and the workers
          competing for it.
        </p>
      </div>
      <ErrorNote error={fleet.error} />

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
      </Panel>

      <Panel
        title="Workers"
        description={`${online.length} online of ${workers.length} registered. Run another with: pnpm --filter @forge/worker dev`}
      >
        {workers.length === 0 ? (
          <Empty>No worker has registered yet.</Empty>
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
                  <th className="pb-2 font-medium">Heartbeat</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#1c202b]">
                {workers.map((worker) => (
                  <tr key={worker.id}>
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
                          className={`h-1.5 w-1.5 rounded-full ${
                            worker.online ? 'bg-current' : 'bg-[#5f6478]'
                          }`}
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
                    <td className="py-2.5 text-xs text-[#6e7387]">
                      {worker.lastHeartbeatAt ? formatAgo(worker.lastHeartbeatAt) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
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
                {deployment.workerId && (
                  <span className="font-mono text-[11px] text-[#6e7387]">
                    worker {deployment.workerId.slice(0, 8)}
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

function Stat({ label, value, tone }: { label: string; value: number | undefined; tone: string }) {
  return (
    <div className="rounded-lg border border-[#232734] bg-[#0d0f16] px-3 py-3">
      <p className="text-xs text-[#6e7387]">{label}</p>
      <p className={`mt-1 text-2xl font-semibold tabular-nums ${tone}`}>{value ?? '—'}</p>
    </div>
  );
}
