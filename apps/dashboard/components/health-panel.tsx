'use client';

import { useQuery } from '@tanstack/react-query';
import { API_URL, fetchHealth, type DependencyHealth } from '@/lib/api';

function Dot({ state }: { state: 'ok' | 'bad' | 'unknown' }) {
  const color =
    state === 'ok' ? 'bg-emerald-400' : state === 'bad' ? 'bg-red-400' : 'bg-neutral-500';
  return <span className={`inline-block h-2.5 w-2.5 rounded-full ${color}`} />;
}

function DependencyRow({ name, health }: { name: string; health: DependencyHealth | undefined }) {
  return (
    <div className="flex items-center justify-between border-t border-[#232734] py-3 text-sm">
      <div className="flex items-center gap-3">
        <Dot state={health ? (health.ok ? 'ok' : 'bad') : 'unknown'} />
        <span className="font-medium">{name}</span>
      </div>
      <div className="text-right text-xs text-[#8b90a3]">
        {health ? (
          health.ok ? (
            <span>{health.latencyMs} ms</span>
          ) : (
            <span className="text-red-400">{health.error ?? 'unavailable'}</span>
          )
        ) : (
          <span>—</span>
        )}
      </div>
    </div>
  );
}

export function HealthPanel() {
  const { data, error, isPending, isFetching, dataUpdatedAt } = useQuery({
    queryKey: ['health'],
    queryFn: fetchHealth,
    refetchInterval: 5_000,
  });

  const overall = error ? 'bad' : isPending ? 'unknown' : data?.ok ? 'ok' : 'bad';

  return (
    <section className="w-full max-w-xl rounded-xl border border-[#232734] bg-[#11131b] p-6 shadow-lg">
      <header className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Dot state={overall} />
          <h2 className="text-lg font-semibold">API health</h2>
        </div>
        <span className="text-xs text-[#8b90a3]">{isFetching ? 'checking…' : 'live · 5s'}</span>
      </header>

      <p className="mt-1 text-xs text-[#8b90a3]">{API_URL}</p>

      {error ? (
        <p className="mt-4 rounded-lg bg-red-500/10 p-3 text-sm text-red-300">
          Cannot reach the API. Is it running? <code>pnpm --filter @forge/api dev</code>
        </p>
      ) : (
        <div className="mt-4">
          <DependencyRow name="Postgres" health={data?.checks.postgres} />
          <DependencyRow name="Redis" health={data?.checks.redis} />
          <div className="flex items-center justify-between border-t border-[#232734] pt-3 text-xs text-[#8b90a3]">
            <span>
              api v{data?.version ?? '—'} · up {data ? Math.round(data.uptimeMs / 1000) : 0}s
            </span>
            <span>
              {dataUpdatedAt ? new Date(dataUpdatedAt).toLocaleTimeString() : 'never'}
            </span>
          </div>
        </div>
      )}
    </section>
  );
}
