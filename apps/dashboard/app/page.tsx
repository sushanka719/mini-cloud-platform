'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { useSession } from '@/components/session-provider';
import { HealthPanel } from '@/components/health-panel';
import { Button } from '@/components/ui/primitives';

const PHASES = [
  { id: 0, name: 'Foundations', done: true },
  { id: 1, name: 'Auth, orgs & RBAC', done: true },
  { id: 2, name: 'Projects & env vars', done: true },
  { id: 3, name: 'Storage & streams', done: false },
  { id: 4, name: 'Queue & worker', done: false },
  { id: 5, name: 'Realtime', done: false },
];

export default function HomePage() {
  const { session, orgs, isLoading } = useSession();
  const router = useRouter();

  // A signed-in user always has at least one org (register creates one), so
  // land them straight in it rather than on a marketing page.
  useEffect(() => {
    if (!isLoading && session && orgs.length > 0) {
      router.replace(`/orgs/${orgs[0]!.slug}`);
    }
  }, [isLoading, session, orgs, router]);

  return (
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col items-center justify-center gap-8 p-8">
      <div className="text-center">
        <h1 className="text-3xl font-bold tracking-tight">ForgeCloud</h1>
        <p className="mt-2 text-sm text-[#8b90a3]">
          A miniature, locally-hosted deployment platform.
        </p>
      </div>

      {!isLoading && !session && (
        <div className="flex items-center gap-3">
          <Link href="/login">
            <Button>Sign in</Button>
          </Link>
          <Link href="/register">
            <Button variant="secondary">Create an account</Button>
          </Link>
        </div>
      )}

      <HealthPanel />

      <section className="w-full max-w-xl rounded-xl border border-[#232734] bg-[#11131b] p-6">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-[#8b90a3]">Roadmap</h2>
        <ul className="mt-3 grid gap-2 text-sm">
          {PHASES.map((phase) => (
            <li key={phase.id} className="flex items-center gap-3">
              <span className={phase.done ? 'text-emerald-400' : 'text-[#8b90a3]'}>
                {phase.done ? '●' : '○'}
              </span>
              <span className={phase.done ? '' : 'text-[#8b90a3]'}>
                Phase {phase.id} — {phase.name}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
