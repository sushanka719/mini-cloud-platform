'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useState } from 'react';
import { useSession } from '@/components/session-provider';
import { useRealtime } from '@/components/realtime-provider';
import { api, type OrgMembership } from '@/lib/api';
import { Button, RoleBadge } from '@/components/ui/primitives';

/** Top bar: org switcher, section nav, and the signed-in user. */
export function AppShell({ orgSlug, children }: { orgSlug: string; children: React.ReactNode }) {
  const { session, orgs, logout } = useSession();
  const router = useRouter();
  const pathname = usePathname();

  const current = orgs.find((o) => o.slug === orgSlug);

  const nav = [
    { href: `/orgs/${orgSlug}`, label: 'Projects', exact: true },
    { href: `/orgs/${orgSlug}/containers`, label: 'Containers' },
    { href: `/orgs/${orgSlug}/fleet`, label: 'Fleet' },
    { href: `/orgs/${orgSlug}/metrics`, label: 'Metrics' },
    { href: `/orgs/${orgSlug}/members`, label: 'Members' },
    { href: `/orgs/${orgSlug}/api-keys`, label: 'API keys' },
  ];

  return (
    <div className="min-h-screen">
      <header className="border-b border-[#232734] bg-[#0d0f16]">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-4 px-6 py-3">
          <Link href="/" className="text-sm font-bold tracking-tight">
            ForgeCloud
          </Link>

          <OrgSwitcher orgs={orgs} current={current} />

          <nav className="flex items-center gap-1">
            {nav.map((item) => {
              const active = item.exact ? pathname === item.href : pathname.startsWith(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`rounded-lg px-3 py-1.5 text-sm transition-colors ${
                    active
                      ? 'bg-[#1a1e2a] text-[#e6e8ef]'
                      : 'text-[#8b90a3] hover:text-[#e6e8ef]'
                  }`}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>

          <div className="ml-auto flex items-center gap-3">
            <RealtimeBadge />
            {current && <RoleBadge role={current.role} />}
            <span className="hidden text-xs text-[#8b90a3] sm:inline">{session?.user.email}</span>
            <Button
              variant="ghost"
              onClick={async () => {
                await logout();
                router.push('/login');
              }}
            >
              Sign out
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl p-6">{children}</main>
    </div>
  );
}

/**
 * The socket's state, always on screen.
 *
 * It doubles as the fan-out demo: the instance name comes from the `hello`
 * frame, so two tabs served by two API replicas show two different names while
 * watching the same deployment.
 */
function RealtimeBadge() {
  const { status, instance } = useRealtime();

  const look = {
    open: { dot: 'bg-emerald-400', text: 'text-emerald-300', label: 'Live' },
    connecting: { dot: 'bg-amber-400 animate-pulse', text: 'text-amber-300', label: 'Connecting' },
    reconnecting: {
      dot: 'bg-amber-400 animate-pulse',
      text: 'text-amber-300',
      label: 'Reconnecting',
    },
    closed: { dot: 'bg-[#4a4f61]', text: 'text-[#6e7387]', label: 'Offline' },
  }[status];

  return (
    <span
      data-testid="realtime-status"
      data-status={status}
      title={
        instance
          ? `WebSocket ${status} · served by API instance ${instance}`
          : `WebSocket ${status}`
      }
      className={`flex items-center gap-1.5 text-xs ${look.text}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${look.dot}`} />
      {look.label}
      {status === 'open' && instance && (
        <span className="hidden font-mono text-[10px] text-[#6e7387] lg:inline">{instance}</span>
      )}
    </span>
  );
}

function OrgSwitcher({
  orgs,
  current,
}: {
  orgs: OrgMembership[];
  current: OrgMembership | undefined;
}) {
  const router = useRouter();
  const { refresh } = useSession();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');

  async function createOrg(event: React.FormEvent) {
    event.preventDefault();
    const org = await api.post<OrgMembership>('/orgs', { name });
    setName('');
    setCreating(false);
    await refresh();
    router.push(`/orgs/${org.slug}`);
  }

  if (creating) {
    return (
      <form onSubmit={createOrg} className="flex items-center gap-2">
        <input
          autoFocus
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="New org name"
          className="rounded-lg border border-[#2c3142] bg-[#0d0f16] px-2 py-1.5 text-sm outline-none focus:border-emerald-500/60"
        />
        <Button type="submit" className="px-2 py-1.5 text-xs">
          Create
        </Button>
        <Button
          type="button"
          variant="ghost"
          className="px-2 py-1.5 text-xs"
          onClick={() => setCreating(false)}
        >
          Cancel
        </Button>
      </form>
    );
  }

  return (
    <div className="flex items-center gap-1">
      <select
        value={current?.slug ?? ''}
        onChange={(e) => router.push(`/orgs/${e.target.value}`)}
        className="rounded-lg border border-[#2c3142] bg-[#0d0f16] px-2 py-1.5 text-sm outline-none focus:border-emerald-500/60"
      >
        {orgs.map((org) => (
          <option key={org.id} value={org.slug}>
            {org.name}
          </option>
        ))}
      </select>
      <Button
        variant="ghost"
        className="px-2 py-1.5 text-lg leading-none"
        title="Create organization"
        onClick={() => setCreating(true)}
      >
        +
      </Button>
    </div>
  );
}
