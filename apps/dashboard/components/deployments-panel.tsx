'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  api,
  formatAgo,
  formatDuration,
  isSettled,
  TERMINAL_STATUSES,
  type Deployment,
  type DeploymentEvent,
  type DeploymentStatus,
} from '@/lib/api';
import { frameToEvent, topics, type WsErrorFrame } from '@/lib/realtime';
import { useRealtime, useTopic } from '@/components/realtime-provider';
import { Button, Empty, ErrorNote, Panel } from '@/components/ui/primitives';
import { DeploymentPipeline, StatusBadge } from '@/components/deployment-pipeline';

/**
 * Deploy button, live pipeline, live log timeline and build history.
 *
 * Driven by the WebSocket: the project topic patches the history list as
 * deployments move, and the selected deployment's topic streams its timeline
 * (replayed from `deployment_events` on subscribe, then live).
 *
 * Polling is the **fallback**, not the mechanism — it switches on only while
 * the socket is down, so a realtime outage degrades to Phase 4's behaviour
 * instead of a frozen screen.
 */
export function DeploymentsPanel({
  orgSlug,
  projectId,
  canDeploy,
}: {
  orgSlug: string;
  projectId: string;
  canDeploy: boolean;
}) {
  const queryClient = useQueryClient();
  const { status: socketStatus } = useRealtime();
  const socketLive = socketStatus === 'open';
  const base = `/orgs/${orgSlug}/projects/${projectId}/deployments`;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [failAt, setFailAt] = useState<DeploymentStatus | ''>('');
  const [replayNote, setReplayNote] = useState<string | null>(null);

  const deployments = useQuery({
    queryKey: ['deployments', projectId],
    queryFn: () => api.get<Deployment[]>(`${base}?limit=20`),
    // No polling while the socket is up — status changes arrive as frames.
    refetchInterval: socketLive
      ? false
      : (query) => ((query.state.data ?? []).some((d) => !isSettled(d.status)) ? 1000 : 5000),
  });

  /**
   * Fetches one deployment row and merges it into the cached list.
   *
   * Used instead of invalidating the whole list, because a status frame can
   * arrive several times a second: invalidation would refetch the list on
   * nearly every frame, which is indistinguishable from the polling this phase
   * replaced. In-flight ids are tracked so racing frames collapse to one
   * request.
   */
  const inFlight = useRef(new Set<string>());
  const refreshDeployment = useCallback(
    (deploymentId: string) => {
      if (inFlight.current.has(deploymentId)) return;
      inFlight.current.add(deploymentId);
      void api
        .get<Deployment>(`${base}/${deploymentId}`)
        .then((fresh) => {
          queryClient.setQueryData<Deployment[]>(['deployments', projectId], (prev) => {
            if (!prev) return prev;
            const index = prev.findIndex((d) => d.id === fresh.id);
            if (index === -1) return [fresh, ...prev];
            const next = [...prev];
            next[index] = fresh;
            return next;
          });
        })
        .catch(() => {
          // The list is refetched on the next mount or socket drop; a failed
          // single-row refresh is not worth surfacing.
        })
        .finally(() => inFlight.current.delete(deploymentId));
    },
    [base, projectId, queryClient],
  );

  /**
   * The project topic carries every transition for every deployment in the
   * project, which is exactly what the history list needs.
   *
   * A frame carries only the new status, so the row is patched in place while
   * the deployment is moving, and read back once for the fields the frame
   * doesn't have: `durationMs` and `errorCode` on settle, and the row itself
   * for a deployment this tab has never seen (started elsewhere).
   */
  useTopic(
    socketLive ? topics.project(projectId) : null,
    useCallback(
      (frame) => {
        if (frame.type !== 'status') return;
        const list = queryClient.getQueryData<Deployment[]>(['deployments', projectId]);
        const known = list?.some((d) => d.id === frame.deploymentId) ?? false;

        if (!known || isSettled(frame.status)) {
          refreshDeployment(frame.deploymentId);
        } else {
          queryClient.setQueryData<Deployment[]>(['deployments', projectId], (prev) =>
            prev?.map((d) => (d.id === frame.deploymentId ? { ...d, status: frame.status } : d)),
          );
        }
        if (frame.status === 'live') {
          void queryClient.invalidateQueries({ queryKey: ['project', projectId] });
        }
      },
      [queryClient, projectId, refreshDeployment],
    ),
  );

  const list = deployments.data ?? [];
  const selected = list.find((d) => d.id === selectedId) ?? list[0] ?? null;
  const { events: timeline, notice } = useDeploymentTimeline(orgSlug, projectId, selected);
  // Where a failed deployment stopped — read off the timeline we already have
  // rather than asking the server a second time.
  const failurePoint = lastPipelineStage(timeline);

  const deploy = useMutation({
    mutationFn: async () => {
      // A fresh key per click: two *different* clicks are two deployments, but
      // a retried request (double-submit, network retry) is not.
      const idempotencyKey = `ui-${crypto.randomUUID()}`;
      return api.post<Deployment>(base, {
        idempotencyKey,
        ...(failAt ? { failAt } : {}),
      });
    },
    onSuccess: (created) => {
      setSelectedId(created.id);
      setReplayNote(null);
      void queryClient.invalidateQueries({ queryKey: ['deployments', projectId] });
      void queryClient.invalidateQueries({ queryKey: ['project', projectId] });
    },
  });

  /** Fires the exact same request twice to show idempotency doing its job. */
  const doubleClick = useMutation({
    mutationFn: async () => {
      const idempotencyKey = `dbl-${crypto.randomUUID()}`;
      const body = { idempotencyKey, ...(failAt ? { failAt } : {}) };
      const [a, b] = await Promise.all([
        api.post<Deployment>(base, body),
        api.post<Deployment>(base, body),
      ]);
      return { a, b };
    },
    onSuccess: ({ a, b }) => {
      setSelectedId(a.id);
      setReplayNote(
        a.id === b.id
          ? `Two identical requests → one deployment (${a.id.slice(0, 8)}).`
          : `Unexpected: two deployments were created (${a.id.slice(0, 8)}, ${b.id.slice(0, 8)}).`,
      );
      void queryClient.invalidateQueries({ queryKey: ['deployments', projectId] });
    },
  });

  return (
    <Panel
      title="Deployments"
      description="Deploy enqueues a job; a worker claims it and walks the pipeline. Status and logs stream over the WebSocket."
      actions={
        canDeploy ? (
          <div className="flex items-center gap-2">
            <select
              value={failAt}
              onChange={(e) => setFailAt(e.target.value as DeploymentStatus | '')}
              title="Simulate a failure at this stage"
              className="rounded-lg border border-[#2c3142] bg-[#0d0f16] px-2 py-2 text-xs text-[#e6e8ef] outline-none focus:border-emerald-500/60"
            >
              <option value="">No simulated failure</option>
              <option value="cloning">Fail at cloning</option>
              <option value="installing">Fail at installing</option>
              <option value="building">Fail at building</option>
              <option value="creating_container">Fail at creating container</option>
              <option value="starting">Fail at starting</option>
              <option value="health_check">Fail at health check</option>
            </select>
            <Button
              variant="secondary"
              className="text-xs"
              disabled={doubleClick.isPending}
              title="Sends the same request twice with one idempotency key"
              onClick={() => doubleClick.mutate()}
            >
              Double-click test
            </Button>
            <Button disabled={deploy.isPending} onClick={() => deploy.mutate()}>
              {deploy.isPending ? 'Queueing…' : 'Deploy'}
            </Button>
          </div>
        ) : null
      }
    >
      {!canDeploy && (
        <p className="mb-4 text-xs text-[#6e7387]">
          Deploying runs code and consumes resources, so it requires the “member” role.
        </p>
      )}
      <ErrorNote error={deploy.error ?? doubleClick.error ?? deployments.error} />
      {replayNote && (
        <p className="mb-4 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300">
          {replayNote}
        </p>
      )}
      {!socketLive && (
        <p className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
          Realtime connection {socketStatus} — falling back to polling. Status is still correct,
          just less immediate.
        </p>
      )}

      {selected && (
        <div className="mb-5 rounded-xl border border-[#232734] bg-[#0d0f16] p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <StatusBadge status={selected.status} />
              <span className="font-mono text-xs text-[#6e7387]">{selected.id.slice(0, 8)}</span>
              {selected.attempt > 1 && (
                <span className="text-xs text-amber-300">attempt {selected.attempt}</span>
              )}
            </div>
            <span className="text-xs text-[#6e7387]">
              {formatDuration(selected.durationMs)} · queued {formatAgo(selected.queuedAt)}
            </span>
          </div>
          <DeploymentPipeline status={selected.status} failedAfter={failurePoint} />
          {selected.errorCode && (
            <p className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
              <span className="font-mono uppercase">{selected.errorCode}</span> —{' '}
              {selected.errorMessage}
            </p>
          )}
          {notice && (
            <p className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
              {notice}
            </p>
          )}
          <DeploymentTimeline events={timeline} />
        </div>
      )}

      {deployments.isPending ? (
        <p className="text-sm text-[#8b90a3]">Loading deployments…</p>
      ) : list.length === 0 ? (
        <Empty>No deployments yet. Upload a source archive, then hit Deploy.</Empty>
      ) : (
        <ul className="divide-y divide-[#1c202b]">
          {list.map((deployment) => (
            <li key={deployment.id}>
              <button
                onClick={() => setSelectedId(deployment.id)}
                className={`flex w-full flex-wrap items-center gap-3 px-1 py-2.5 text-left transition-colors hover:bg-[#141824] ${
                  selected?.id === deployment.id ? 'bg-[#141824]' : ''
                }`}
              >
                <StatusBadge status={deployment.status} />
                <span className="font-mono text-xs text-[#6e7387]">
                  {deployment.id.slice(0, 8)}
                </span>
                <span className="text-xs text-[#8b90a3]">
                  {formatDuration(deployment.durationMs)}
                </span>
                {deployment.errorCode && (
                  <span className="font-mono text-[11px] text-red-300">{deployment.errorCode}</span>
                )}
                <span className="ml-auto text-xs text-[#6e7387]">
                  {formatAgo(deployment.queuedAt)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

/** The append-only timeline, auto-scrolled as lines stream in. */
function DeploymentTimeline({ events }: { events: DeploymentEvent[] }) {
  const box = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  // Follow the tail, but stop following once the reader scrolls up to look at
  // something — yanking them back to the bottom on every new line is worse
  // than not auto-scrolling at all.
  useEffect(() => {
    const el = box.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [events]);

  if (events.length === 0) return null;

  return (
    <div
      ref={box}
      onScroll={(e) => {
        const el = e.currentTarget;
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      }}
      className="mt-4 max-h-72 overflow-y-auto rounded-lg border border-[#1c202b] bg-[#08090d] p-3 font-mono text-[11px] leading-relaxed"
    >
      {events.map((event) => (
        <div key={event.id} className="flex gap-3">
          <span className="shrink-0 text-[#4a4f61]">
            {new Date(event.createdAt).toLocaleTimeString()}
          </span>
          <span
            className={`shrink-0 ${
              event.type === 'status'
                ? event.status === 'failed'
                  ? 'text-red-400'
                  : 'text-sky-400'
                : 'text-[#6e7387]'
            }`}
          >
            {event.type === 'status' ? event.status : event.stream}
          </span>
          <span
            className={
              event.type === 'status' && event.status === 'failed'
                ? 'text-red-300'
                : 'text-[#b6bbcc]'
            }
          >
            {event.message}
          </span>
        </div>
      ))}
    </div>
  );
}

/** How long frames are batched before triggering a re-render. */
const FLUSH_MS = 80;

/**
 * The selected deployment's timeline.
 *
 * Over the socket this is one subscription: the server replays the stored
 * `deployment_events` tail, then streams live frames, and the client's cursor
 * makes a reconnect resume rather than restart. While the socket is down it
 * falls back to polling the REST endpoint with the same `afterId` cursor.
 */
function useDeploymentTimeline(
  orgSlug: string,
  projectId: string,
  deployment: Deployment | null,
): { events: DeploymentEvent[]; notice: string | null } {
  const { status: socketStatus } = useRealtime();
  const socketLive = socketStatus === 'open';
  const deploymentId = deployment?.id ?? null;

  const [events, setEvents] = useState<DeploymentEvent[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  // Frames are batched: Phase 6 streams real build output down this same path,
  // and one React render per log line would be the bottleneck.
  const inbox = useRef<DeploymentEvent[]>([]);
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setEvents([]);
    setNotice(null);
    inbox.current = [];
    return () => {
      if (flushTimer.current !== null) clearTimeout(flushTimer.current);
      flushTimer.current = null;
    };
  }, [deploymentId]);

  const push = useCallback((event: DeploymentEvent) => {
    inbox.current.push(event);
    if (flushTimer.current !== null) return;
    flushTimer.current = setTimeout(() => {
      flushTimer.current = null;
      const batch = inbox.current;
      inbox.current = [];
      if (batch.length > 0) setEvents((prev) => mergeEvents(prev, batch));
    }, FLUSH_MS);
  }, []);

  useTopic(
    socketLive && deploymentId ? topics.deployment(deploymentId) : null,
    useCallback(
      (frame) => {
        if (frame.type === 'metric') return;
        push(frameToEvent(frame));
      },
      [push],
    ),
    {
      onError: useCallback((frame: WsErrorFrame) => {
        // Both mean "your view of the timeline may have holes" — say so rather
        // than rendering a silently incomplete log.
        if (frame.code === 'FRAMES_DROPPED' || frame.code === 'REPLAY_FAILED') {
          setNotice(frame.message);
        }
      }, []),
    },
  );

  /**
   * Fallback: poll only while the socket is down. Stops once the timeline
   * shows a terminal status *and* the last batch came back empty — the row
   * flips to `live` a beat before its last events are readable.
   */
  const cursor = events.length > 0 ? (events[events.length - 1]?.id ?? 0) : 0;
  const sawTerminal = events.some(
    (event) => event.type === 'status' && event.status && TERMINAL_STATUSES.includes(event.status),
  );
  const [lastBatchEmpty, setLastBatchEmpty] = useState(false);

  const fallback = useQuery({
    queryKey: ['deployment-events', deploymentId, cursor],
    queryFn: () =>
      api.get<DeploymentEvent[]>(
        `/orgs/${orgSlug}/projects/${projectId}/deployments/${deploymentId ?? ''}/events?afterId=${cursor}&limit=500`,
      ),
    enabled: deploymentId !== null && !socketLive,
    refetchInterval: sawTerminal && lastBatchEmpty ? false : 1000,
  });

  useEffect(() => {
    const fresh = fallback.data;
    if (!fresh) return;
    setLastBatchEmpty(fresh.length === 0);
    if (fresh.length > 0) setEvents((prev) => mergeEvents(prev, fresh));
  }, [fallback.data]);

  return { events, notice };
}

/**
 * Appends a batch, de-duplicating on the monotonic event id and keeping the
 * list ordered. Duplicates are normal: a reconnect's replay overlaps whatever
 * the polling fallback already collected.
 */
function mergeEvents(prev: DeploymentEvent[], batch: DeploymentEvent[]): DeploymentEvent[] {
  const seen = new Set(prev.map((event) => event.id));
  const fresh = batch.filter((event) => {
    if (seen.has(event.id)) return false;
    seen.add(event.id);
    return true;
  });
  if (fresh.length === 0) return prev;

  const merged = [...prev, ...fresh];
  const lastKnown = prev[prev.length - 1];
  // Fast path: everything arrived in order, which is the normal case.
  let ordered = lastKnown === undefined || (fresh[0]?.id ?? 0) > lastKnown.id;
  for (let i = 1; ordered && i < fresh.length; i++) {
    if ((fresh[i]?.id ?? 0) <= (fresh[i - 1]?.id ?? 0)) ordered = false;
  }
  return ordered ? merged : merged.sort((a, b) => a.id - b.id);
}

/** The last happy-path stage present in a timeline — where a failure stopped. */
function lastPipelineStage(events: DeploymentEvent[]): DeploymentStatus | null {
  const stages = events
    .filter((event) => event.type === 'status' && event.status && event.status !== 'failed')
    .map((event) => event.status as DeploymentStatus);
  return stages[stages.length - 1] ?? null;
}
