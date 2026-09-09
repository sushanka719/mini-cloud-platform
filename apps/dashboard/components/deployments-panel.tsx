'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  api,
  downloadUrl,
  formatAgo,
  formatBytes,
  formatDuration,
  isSettled,
  ROLLBACK_SKIPPED_STAGES,
  TERMINAL_STATUSES,
  type ContainerActionResult,
  type Deployment,
  type DeploymentEvent,
  type DeploymentStatus,
  type RetryResult,
  type RollbackTarget,
  type StoredFile,
} from '@/lib/api';
import { binarySearch, findAtOrBefore } from '@forge/shared/binary-search';
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
  healthPath,
}: {
  orgSlug: string;
  projectId: string;
  canDeploy: boolean;
  /** So the "open the app" link lands on the path the health check proved. */
  healthPath: string;
}) {
  const liveHealthPath = healthPath;
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
        // A deployment leaving service is what *creates* a rollback target, so
        // the list is re-read on exactly those transitions rather than polled.
        if (frame.status === 'stopped' || frame.status === 'rolled_back') {
          void queryClient.invalidateQueries({ queryKey: ['rollback-targets', projectId] });
        }
      },
      [queryClient, projectId, refreshDeployment],
    ),
  );

  const list = deployments.data ?? [];

  /**
   * "Which deployment was current at 14:32?" — answered locally, by binary
   * search over the history already on screen.
   *
   * `list` arrives sorted `created_at DESC` and stays that way (the WebSocket
   * patches rows in place and prepends new ones), so it is a sorted array and
   * the question is a predecessor search: the *first* row at or before the
   * target, because the timestamp asked about is never a timestamp a
   * deployment actually has. Asking the API instead would be a round trip per
   * keystroke to answer something the page already knows.
   *
   * `probes` is collected so the list can show the search working — the point
   * of writing this by hand is lost if the O(log n) is invisible.
   */
  const [seekInput, setSeekInput] = useState('');
  const seek = useMemo(() => {
    if (seekInput === '') return null;
    const target = Date.parse(seekInput);
    if (Number.isNaN(target)) return null;
    const probes: number[] = [];
    const hit = findAtOrBefore(list, target, deploymentTime, {
      order: 'desc',
      onProbe: (index) => probes.push(index),
    });
    return { target, hit: hit ?? null, probes };
  }, [seekInput, list]);
  const selected = list.find((d) => d.id === selectedId) ?? list[0] ?? null;
  const { events: timeline, notice } = useDeploymentTimeline(orgSlug, projectId, selected);
  const files = useDeploymentFiles(orgSlug, projectId, selected);
  // Where a failed deployment stopped — read off the timeline we already have
  // rather than asking the server a second time.
  const failurePoint = lastPipelineStage(timeline);

  /**
   * Which stages this deployment skipped, if it is a rollback.
   *
   * Read off the timeline rather than sent by the server: a `cloning` event
   * means the image had been pruned and the artifact was extracted, so only
   * install and build were skipped. No `cloning` event means the image was
   * reused and clone/install/build were all skipped. The timeline is already
   * loaded, and it is the authoritative record of what actually ran.
   */
  const isRollback = selected !== null && selected.parentDeploymentId !== null;
  const rollbackSkipped = !isRollback
    ? undefined
    : timeline.some((event) => event.type === 'status' && event.status === 'cloning')
      ? ROLLBACK_SKIPPED_STAGES.artifact
      : ROLLBACK_SKIPPED_STAGES.image;

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

  /**
   * Stop / restart the selected deployment's container.
   *
   * The API only enqueues (it may not call Docker), so nothing is optimistic
   * here: the row changes when a worker has actually done it, and the project
   * topic above is what tells this component.
   */
  const containerAction = useMutation({
    mutationFn: (action: 'stop' | 'restart') =>
      api.post<ContainerActionResult>(`${base}/${selected?.id ?? ''}/${action}`, {}),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['containers', orgSlug] });
    },
  });

  /**
   * Re-run a failed deployment on the same row.
   *
   * Nothing optimistic: the API re-queues the row and a worker picks it up, so
   * the status the user is waiting for arrives on the project topic like every
   * other transition. `enqueued: false` comes back as a message, not an error —
   * "already in flight" is a satisfied request, not a failed one.
   */
  const retry = useMutation({
    mutationFn: () => api.post<RetryResult>(`${base}/${selected?.id ?? ''}/retry`, {}),
    onSuccess: (result) => {
      setReplayNote(null);
      refreshDeployment(result.deploymentId);
    },
  });

  /** Deployments this project can be returned to — served once, not now. */
  const rollbackTargets = useQuery({
    queryKey: ['rollback-targets', projectId],
    queryFn: () =>
      api.get<RollbackTarget[]>(
        `/orgs/${orgSlug}/projects/${projectId}/rollback-targets?limit=10`,
      ),
  });

  const rollback = useMutation({
    mutationFn: (targetId: string) =>
      api.post<Deployment>(`${base}/${targetId}/rollback`, {
        // A fresh key per click, exactly like Deploy: two clicks are two
        // rollbacks, a browser-retried request is one.
        idempotencyKey: `rb-${crypto.randomUUID()}`,
      }),
    onSuccess: (created) => {
      setSelectedId(created.id);
      setReplayNote(
        `Rolling back to ${created.parentDeploymentId?.slice(0, 8) ?? '?'} as deployment ${created.id.slice(0, 8)}.`,
      );
      void queryClient.invalidateQueries({ queryKey: ['deployments', projectId] });
    },
  });

  return (
    <Panel
      title="Deployments"
      description="Deploy enqueues a job; a worker unpacks the source, runs install and build, builds a Docker image, starts a container with resource limits and health-checks it. Every line of output streams here over the WebSocket."
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
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge status={selected.status} />
              <span className="font-mono text-xs text-[#6e7387]">{selected.id.slice(0, 8)}</span>
              {selected.attempt > 1 && (
                <span
                  className="text-xs text-amber-300"
                  title="Each attempt is a full run of this deployment — automatic retries and clicked ones both count"
                >
                  attempt {selected.attempt} of {selected.maxAttempts}
                </span>
              )}
              {isRollback && selected.parentDeploymentId && (
                <span
                  className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 font-mono text-[11px] text-amber-300"
                  title="This deployment was created by rolling back"
                >
                  ↩ {selected.parentDeploymentId.slice(0, 8)}
                </span>
              )}
              {selected.deadLetteredAt && (
                <span
                  className="rounded-full border border-red-500/40 bg-red-500/10 px-2 py-0.5 text-[11px] text-red-300"
                  title={`Parked in the dead-letter queue at ${new Date(selected.deadLetteredAt).toLocaleString()}`}
                >
                  dead-lettered
                </span>
              )}
            </div>
            <span className="text-xs text-[#6e7387]">
              {formatDuration(selected.durationMs)} · queued {formatAgo(selected.queuedAt)}
            </span>
          </div>
          <DeploymentPipeline
            status={selected.status}
            failedAfter={failurePoint}
            skipped={rollbackSkipped}
          />

          {selected.status === 'live' && selected.url && (
            <div className="mt-3 flex flex-wrap items-center gap-3 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2.5">
              <a
                href={`${selected.url}${liveHealthPath}`}
                target="_blank"
                rel="noreferrer"
                className="text-sm font-medium text-emerald-300 underline decoration-dotted hover:text-emerald-200"
              >
                {selected.url} ↗
              </a>
              <span className="font-mono text-[11px] text-emerald-400/70">
                {selected.containerId?.slice(0, 12)}
                {selected.hostPort !== null && ` · host port ${String(selected.hostPort)}`}
              </span>
              {canDeploy && (
                <span className="ml-auto flex items-center gap-2">
                  <Button
                    variant="secondary"
                    className="text-xs"
                    disabled={containerAction.isPending}
                    title="Bounce the container and re-run the health check"
                    onClick={() => containerAction.mutate('restart')}
                  >
                    Restart
                  </Button>
                  <Button
                    variant="danger"
                    className="text-xs"
                    disabled={containerAction.isPending}
                    title="Remove the container; the image is kept"
                    onClick={() => containerAction.mutate('stop')}
                  >
                    Stop
                  </Button>
                </span>
              )}
            </div>
          )}
          <ErrorNote error={containerAction.error} />
          {containerAction.data && (
            <p className="mt-2 text-xs text-[#8b90a3]">{containerAction.data.message}</p>
          )}

          {selected.imageTag && selected.status !== 'live' && (
            <p className="mt-3 font-mono text-[11px] text-[#6e7387]">
              image {selected.imageTag}
              {selected.containerId && ` · container ${selected.containerId.slice(0, 12)}`}
            </p>
          )}

          {selected.errorCode && (
            <div className="mt-3 flex flex-wrap items-center gap-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2.5">
              <p className="text-xs text-red-300">
                <span className="font-mono uppercase">{selected.errorCode}</span> —{' '}
                {selected.errorMessage}
              </p>
              {canDeploy && selected.status === 'failed' && (
                <Button
                  variant="secondary"
                  className="ml-auto text-xs"
                  disabled={retry.isPending}
                  title="Run this deployment again on the same row; the attempt counter goes up"
                  onClick={() => retry.mutate()}
                >
                  {retry.isPending ? 'Queueing…' : 'Retry'}
                </Button>
              )}
            </div>
          )}
          <ErrorNote error={retry.error} />
          {retry.data && !retry.data.enqueued && (
            <p className="mt-2 text-xs text-amber-300">{retry.data.message}</p>
          )}
          {notice && (
            <p className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
              {notice}
            </p>
          )}
          <DeploymentTimeline
            events={timeline}
            logFile={files.log}
            artifact={files.artifact}
            orgSlug={orgSlug}
            projectId={projectId}
          />
        </div>
      )}

      {canDeploy && (rollbackTargets.data ?? []).length > 0 && (
        <RollbackPanel
          targets={rollbackTargets.data ?? []}
          pending={rollback.isPending}
          error={rollback.error}
          onRollback={(targetId) => rollback.mutate(targetId)}
        />
      )}

      {list.length > 0 && (
        <HistorySeek
          value={seekInput}
          onChange={setSeekInput}
          total={list.length}
          result={seek}
          onSelect={setSelectedId}
        />
      )}

      {deployments.isPending ? (
        <p className="text-sm text-[#8b90a3]">Loading deployments…</p>
      ) : list.length === 0 ? (
        <Empty>No deployments yet. Upload a source archive, then hit Deploy.</Empty>
      ) : (
        <ul className="divide-y divide-[#1c202b]">
          {list.map((deployment, index) => (
            <li key={deployment.id}>
              <button
                onClick={() => setSelectedId(deployment.id)}
                className={`flex w-full flex-wrap items-center gap-3 px-1 py-2.5 text-left transition-colors hover:bg-[#141824] ${
                  selected?.id === deployment.id ? 'bg-[#141824]' : ''
                } ${seek?.hit?.item.id === deployment.id ? 'ring-1 ring-inset ring-sky-400/60' : ''}`}
              >
                <ProbeMark order={seek ? seek.probes.indexOf(index) : -1} />
                <StatusBadge status={deployment.status} />
                <span className="font-mono text-xs text-[#6e7387]">
                  {deployment.id.slice(0, 8)}
                </span>
                <span className="text-xs text-[#8b90a3]">
                  {formatDuration(deployment.durationMs)}
                </span>
                {deployment.attempt > 1 && (
                  <span className="text-[11px] text-amber-300">×{deployment.attempt}</span>
                )}
                {deployment.parentDeploymentId && (
                  <span
                    className="font-mono text-[11px] text-amber-300/80"
                    title={`Rolled back to ${deployment.parentDeploymentId.slice(0, 8)}`}
                  >
                    ↩ {deployment.parentDeploymentId.slice(0, 8)}
                  </span>
                )}
                {deployment.errorCode && (
                  <span className="font-mono text-[11px] text-red-300">{deployment.errorCode}</span>
                )}
                {deployment.deadLetteredAt && (
                  <span className="text-[11px] text-red-400/80" title="In the dead-letter queue">
                    DLQ
                  </span>
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

/** The sort key of the history list: what the binary search compares on. */
const deploymentTime = (deployment: Deployment) => Date.parse(deployment.createdAt);

type SeekResult = {
  target: number;
  hit: { index: number; item: Deployment } | null;
  probes: number[];
};

/**
 * The time machine over the deployment history.
 *
 * A `datetime-local` input rather than a free-text one so the value parses the
 * same way in every browser, and local time because the timestamps beside it
 * are rendered local too — asking someone to convert to UTC to use their own
 * deployment history would be a strange thing to do.
 */
function HistorySeek({
  value,
  onChange,
  total,
  result,
  onSelect,
}: {
  value: string;
  onChange: (next: string) => void;
  total: number;
  result: SeekResult | null;
  onSelect: (id: string) => void;
}) {
  // Worst case for a linear scan is the whole list; for this search it is the
  // number of times `total` halves. Shown side by side because that gap is the
  // entire justification for the algorithm.
  const worstCaseProbes = Math.ceil(Math.log2(total + 1));

  return (
    <div className="mb-3 rounded-lg border border-[#1c202b] bg-[#0f1219] px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor="history-seek" className="text-xs font-medium text-[#8b90a3]">
          What was live at
        </label>
        <input
          id="history-seek"
          type="datetime-local"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="rounded-md border border-[#2c3142] bg-[#171a24] px-2 py-1 text-xs text-[#e6e8ef] outline-none focus:border-sky-400/60"
        />
        {value !== '' && (
          <Button variant="ghost" className="px-2 py-1 text-xs" onClick={() => onChange('')}>
            clear
          </Button>
        )}
        <span className="ml-auto font-mono text-[11px] text-[#4f5468]">
          binary search · {total} row{total === 1 ? '' : 's'} · ≤{worstCaseProbes} probe
          {worstCaseProbes === 1 ? '' : 's'}
        </span>
      </div>

      {result && (
        <p className="mt-2 text-xs">
          {result.hit ? (
            <>
              <button
                onClick={() => onSelect(result.hit?.item.id ?? '')}
                className="font-mono text-sky-300 underline-offset-2 hover:underline"
              >
                {result.hit.item.id.slice(0, 8)}
              </button>
              <span className="text-[#8b90a3]">
                {' '}
                was the newest deployment at {new Date(result.target).toLocaleString()} — row{' '}
                {result.hit.index + 1} of {total}, found in {result.probes.length} probe
                {result.probes.length === 1 ? '' : 's'} ({result.probes.join(' → ')}) instead of a{' '}
                {result.hit.index + 1}-row scan.
              </span>
            </>
          ) : (
            <span className="text-[#8b90a3]">
              Nothing had been deployed yet at {new Date(result.target).toLocaleString()}. Checked{' '}
              {result.probes.length} row{result.probes.length === 1 ? '' : 's'} to rule out all{' '}
              {total}.
            </span>
          )}
        </p>
      )}
    </div>
  );
}

/**
 * The order in which the search looked at this row, or nothing.
 *
 * A fixed-width slot even when empty, so the rows do not shift horizontally
 * the moment a search starts.
 */
function ProbeMark({ order }: { order: number }) {
  if (order < 0) return <span className="w-4" aria-hidden />;
  return (
    <span
      className="w-4 text-center font-mono text-[10px] text-sky-400/80"
      title={`Probe ${order + 1}`}
    >
      {order + 1}
    </span>
  );
}

/**
 * "Roll back to" — the project's previous deployments, newest first.
 *
 * Every row is a deployment that went live and has since been replaced. Rolling
 * back to one creates a *new* deployment from its image (or, if that image has
 * been pruned, from its stored artifact), health-checks it, and swaps it in —
 * so the thing being rolled back to is never mutated and the deployment being
 * replaced is recorded as `rolled_back` rather than merely stopped.
 *
 * `hasImage` is what the server *recorded*, not what Docker still holds: the
 * API cannot ask the Docker host, so a row can say "image" and the worker can
 * still find it pruned and fall back to the artifact. Showing both is the
 * honest version, and it explains why one rollback takes two seconds and
 * another rebuilds.
 */
function RollbackPanel({
  targets,
  pending,
  error,
  onRollback,
}: {
  targets: RollbackTarget[];
  pending: boolean;
  error: unknown;
  onRollback: (targetId: string) => void;
}) {
  return (
    <div className="mb-5 rounded-xl border border-amber-500/25 bg-amber-500/[0.04] p-4">
      <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold text-amber-200">Roll back</h3>
        <p className="text-[11px] text-[#8b90a3]">
          Creates a new deployment from a previous one’s image — no clone, no install, no build.
        </p>
      </div>
      <ErrorNote error={error} />
      <ul className="divide-y divide-[#1c202b]">
        {targets.map((target) => {
          const usable = target.hasImage || target.hasArtifact;
          return (
            <li
              key={target.deploymentId}
              className="flex flex-wrap items-center gap-3 py-2.5 text-xs"
            >
              <StatusBadge status={target.status} />
              <span className="font-mono text-[#8b90a3]">
                {target.deploymentId.slice(0, 8)}
              </span>
              {target.attempt > 1 && (
                <span className="text-[11px] text-[#6e7387]">attempt {target.attempt}</span>
              )}
              <span className="flex items-center gap-1.5 text-[11px]">
                {target.hasImage ? (
                  <span
                    className="rounded border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 text-emerald-300"
                    title={target.imageTag ?? undefined}
                  >
                    image
                  </span>
                ) : null}
                {target.hasArtifact ? (
                  <span
                    className="rounded border border-sky-500/30 bg-sky-500/10 px-1.5 py-0.5 text-sky-300"
                    title="The gzipped tree that was built into the image; the rollback rebuilds from it if the image is gone"
                  >
                    artifact {target.artifactBytes === null ? '' : formatBytes(target.artifactBytes)}
                  </span>
                ) : null}
                {!usable && (
                  <span className="text-[#6e7387]">neither an image nor an artifact remains</span>
                )}
              </span>
              <span className="ml-auto flex items-center gap-3">
                {target.liveAt && (
                  <span className="text-[11px] text-[#6e7387]">
                    was live {formatAgo(target.liveAt)}
                  </span>
                )}
                <Button
                  variant="secondary"
                  className="text-xs"
                  disabled={pending || !usable}
                  title={
                    usable
                      ? 'Deploy this version again and swap it in'
                      : 'Nothing left to roll back to: the image was pruned and no artifact was kept'
                  }
                  onClick={() => onRollback(target.deploymentId)}
                >
                  Roll back
                </Button>
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * How many rows the log box keeps in the DOM.
 *
 * A real build can stream thousands of lines, and every one of them is a node
 * the browser has to lay out — past a few thousand, scrolling the box costs
 * more than producing the lines did. The tail is what anyone is reading; the
 * whole thing is one click away as the stored log object.
 */
const MAX_RENDERED_LINES = 2_000;

/** Per-stream colours: stderr has to be findable without reading every line. */
const STREAM_STYLE: Record<string, { label: string; tag: string; text: string }> = {
  stdout: { label: 'out', tag: 'text-[#4a4f61]', text: 'text-[#b6bbcc]' },
  stderr: { label: 'err', tag: 'text-amber-400/80', text: 'text-amber-200/90' },
  system: { label: '···', tag: 'text-sky-400/70', text: 'text-sky-200/80' },
};

/**
 * Log timestamps are 24-hour and built once: `toLocaleTimeString()` defaults to
 * a 12-hour clock in most locales, and the trailing " AM" wraps the timestamp
 * column onto a second line, which knocks every row out of alignment.
 */
const CLOCK = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

/**
 * The append-only timeline: pipeline transitions and real build output in one
 * scrolling view, auto-followed as lines stream in.
 */
function DeploymentTimeline({
  events,
  logFile,
  artifact,
  orgSlug,
  projectId,
}: {
  events: DeploymentEvent[];
  logFile: StoredFile | null;
  artifact: StoredFile | null;
  orgSlug: string;
  projectId: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const [follow, setFollow] = useState(true);

  // Follow the tail, but stop following once the reader scrolls up to look at
  // something — yanking them back to the bottom on every new line is worse
  // than not auto-scrolling at all.
  useEffect(() => {
    const el = box.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [events]);

  if (events.length === 0) return null;

  const hidden = Math.max(0, events.length - MAX_RENDERED_LINES);
  const rendered = hidden > 0 ? events.slice(hidden) : events;

  return (
    <div className="mt-4">
      <div className="mb-1.5 flex flex-wrap items-center gap-3 text-[11px] text-[#6e7387]">
        <span className="font-mono">
          {events.length.toLocaleString()} lines
          {hidden > 0 && ` · showing the last ${MAX_RENDERED_LINES.toLocaleString()}`}
        </span>
        <label className="flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={follow}
            onChange={(e) => {
              setFollow(e.target.checked);
              pinned.current = e.target.checked;
              if (e.target.checked && box.current) {
                box.current.scrollTop = box.current.scrollHeight;
              }
            }}
            className="accent-emerald-500"
          />
          Follow
        </label>
        <span className="ml-auto flex items-center gap-3">
          {artifact && (
            <a
              href={downloadUrl(orgSlug, projectId, artifact.id)}
              className="text-sky-400 underline decoration-dotted hover:text-sky-300"
              title="The gzipped tree that was built into the image"
            >
              Artifact ({formatBytes(artifact.sizeBytes)})
            </a>
          )}
          {logFile && (
            <a
              href={downloadUrl(orgSlug, projectId, logFile.id)}
              className="text-emerald-400 underline decoration-dotted hover:text-emerald-300"
            >
              Download the full log ({formatBytes(logFile.sizeBytes)})
            </a>
          )}
        </span>
      </div>
      <div
        ref={box}
        onScroll={(e) => {
          const el = e.currentTarget;
          const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
          pinned.current = atBottom && follow;
          // Scrolling up is the reader taking over; say so in the checkbox
          // rather than silently stopping.
          if (!atBottom && follow) setFollow(false);
        }}
        className="max-h-96 overflow-y-auto rounded-lg border border-[#1c202b] bg-[#08090d] p-3 font-mono text-[11px] leading-relaxed"
      >
        {rendered.map((event) =>
          event.type === 'status' ? (
            <div key={event.id} className="flex gap-3 py-0.5">
              <span className="w-[54px] shrink-0 whitespace-nowrap text-[#4a4f61]">
                {CLOCK.format(new Date(event.createdAt))}
              </span>
              <span
                className={`shrink-0 font-semibold ${
                  event.status === 'failed' ? 'text-red-400' : 'text-emerald-400'
                }`}
              >
                {event.status}
              </span>
              <span className={event.status === 'failed' ? 'text-red-300' : 'text-[#8b90a3]'}>
                {event.message}
              </span>
            </div>
          ) : (
            <div key={event.id} className="flex gap-3">
              <span className="w-[54px] shrink-0 whitespace-nowrap text-[#33374a]">
                {CLOCK.format(new Date(event.createdAt))}
              </span>
              <span className={`w-7 shrink-0 ${STREAM_STYLE[event.stream ?? 'stdout']?.tag}`}>
                {STREAM_STYLE[event.stream ?? 'stdout']?.label}
              </span>
              <span
                className={`whitespace-pre-wrap break-all ${STREAM_STYLE[event.stream ?? 'stdout']?.text}`}
              >
                {event.message}
              </span>
            </div>
          ),
        )}
      </div>
    </div>
  );
}

/**
 * Objects the selected deployment produced: its build log, and from Phase 7 the
 * gzipped build context that became the image.
 *
 * Read once the deployment settles: the log object is committed at the end of
 * the pipeline, so asking earlier would always miss.
 */
function useDeploymentFiles(
  orgSlug: string,
  projectId: string,
  deployment: Deployment | null,
): { log: StoredFile | null; artifact: StoredFile | null } {
  const settled = deployment !== null && isSettled(deployment.status);
  const files = useQuery({
    queryKey: ['deployment-files', deployment?.id],
    queryFn: () =>
      api.get<StoredFile[]>(
        `/orgs/${orgSlug}/projects/${projectId}/deployments/${deployment?.id ?? ''}/files`,
      ),
    enabled: settled,
  });
  return {
    log: files.data?.find((file) => file.kind === 'log') ?? null,
    artifact: files.data?.find((file) => file.kind === 'artifact') ?? null,
  };
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
const eventIdOf = (event: DeploymentEvent) => event.id;

function mergeEvents(prev: DeploymentEvent[], batch: DeploymentEvent[]): DeploymentEvent[] {
  // `prev` is sorted ascending on the monotonic event id, so "have I already
  // got this one?" is a binary search rather than a Set rebuilt from the whole
  // timeline. That matters on the hot path: during a noisy build this runs
  // every FLUSH_MS against a list that is thousands of lines long, and the Set
  // cost an O(prev) rebuild and allocation to answer O(batch) questions.
  // Within-batch duplicates still need a set, but it only ever holds the batch.
  const accepted = new Set<number>();
  const fresh = batch.filter((event) => {
    if (accepted.has(event.id)) return false;
    if (binarySearch(prev, event.id, eventIdOf) !== -1) return false;
    accepted.add(event.id);
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
