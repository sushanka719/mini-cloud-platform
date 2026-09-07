'use client';

import { PIPELINE_STAGES, STATUS_LABELS, type DeploymentStatus } from '@/lib/api';

/**
 * The pipeline animation: nine stages, one per canonical status.
 *
 * Position is derived from the deployment's *current* status, which the server
 * owns — the UI never advances a stage on its own. A `failed` deployment keeps
 * the stages it completed and marks the one it died in.
 *
 * `skipped` exists for rollbacks (Phase 8). A rollback that reused an existing
 * image really does jump from `assigned` to `creating_container`, and rendering
 * clone/install/build as *completed* would be a lie while rendering them as
 * *pending* would look like a pipeline that lost three stages. They get their
 * own dashed, struck-through tone that says "deliberately not run".
 */
export function DeploymentPipeline({
  status,
  failedAfter,
  skipped,
  compact = false,
}: {
  status: DeploymentStatus;
  /** The last stage reached before failing, from the event timeline. */
  failedAfter?: DeploymentStatus | null;
  /** Stages this deployment deliberately did not run (a rollback). */
  skipped?: readonly DeploymentStatus[];
  compact?: boolean;
}) {
  const failed = status === 'failed';
  const marker = failed ? (failedAfter ?? 'queued') : status;
  const currentIndex = PIPELINE_STAGES.indexOf(marker);
  const skippedSet = new Set(skipped ?? []);

  return (
    <ol className={`flex flex-wrap items-center ${compact ? 'gap-1' : 'gap-1.5'}`}>
      {PIPELINE_STAGES.map((stage, index) => {
        const wasSkipped = skippedSet.has(stage);
        const done =
          !wasSkipped && (index < currentIndex || (status === 'live' && stage === 'live'));
        const active = !wasSkipped && index === currentIndex && !failed && status !== 'live';
        const broke = !wasSkipped && failed && index === currentIndex;

        const tone = wasSkipped
          ? 'border-dashed border-[#3a4056] bg-transparent text-[#4a4f61] line-through'
          : broke
            ? 'border-red-500/50 bg-red-500/15 text-red-300'
            : done
              ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
              : active
                ? 'border-sky-500/60 bg-sky-500/15 text-sky-200'
                : 'border-[#2c3142] bg-[#141824] text-[#5f6478]';

        return (
          <li key={stage} className="flex items-center gap-1.5">
            <span
              title={wasSkipped ? `${STATUS_LABELS[stage]} — skipped by this rollback` : STATUS_LABELS[stage]}
              className={`rounded-md border px-2 py-1 text-[11px] font-medium transition-colors ${tone} ${
                active ? 'animate-pulse' : ''
              }`}
            >
              {compact ? SHORT[stage] : STATUS_LABELS[stage]}
            </span>
            {index < PIPELINE_STAGES.length - 1 && (
              <span className={index < currentIndex ? 'text-emerald-500/60' : 'text-[#2c3142]'}>
                ›
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );
}

/** Abbreviations for the inline (per-row) rendering. */
const SHORT: Record<DeploymentStatus, string> = {
  queued: 'Q',
  assigned: 'W',
  cloning: 'CL',
  installing: 'IN',
  building: 'BD',
  creating_container: 'CT',
  starting: 'ST',
  health_check: 'HC',
  live: 'LIVE',
  failed: 'FAIL',
  stopped: 'STOP',
  rolled_back: 'RB',
  canceled: 'CX',
};

const STATUS_TONE: Record<DeploymentStatus, string> = {
  queued: 'border-[#3a4056] bg-[#1a1e2a] text-[#8b90a3]',
  assigned: 'border-sky-500/40 bg-sky-500/10 text-sky-300',
  cloning: 'border-sky-500/40 bg-sky-500/10 text-sky-300',
  installing: 'border-sky-500/40 bg-sky-500/10 text-sky-300',
  building: 'border-sky-500/40 bg-sky-500/10 text-sky-300',
  creating_container: 'border-sky-500/40 bg-sky-500/10 text-sky-300',
  starting: 'border-sky-500/40 bg-sky-500/10 text-sky-300',
  health_check: 'border-amber-500/40 bg-amber-500/10 text-amber-300',
  live: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300',
  failed: 'border-red-500/40 bg-red-500/10 text-red-300',
  stopped: 'border-[#3a4056] bg-[#1a1e2a] text-[#8b90a3]',
  rolled_back: 'border-amber-500/40 bg-amber-500/10 text-amber-300',
  canceled: 'border-[#3a4056] bg-[#1a1e2a] text-[#8b90a3]',
};

export function StatusBadge({ status }: { status: DeploymentStatus }) {
  return (
    <span
      className={`inline-block rounded-full border px-2 py-0.5 text-[11px] font-medium ${STATUS_TONE[status]}`}
    >
      {STATUS_LABELS[status]}
    </span>
  );
}
