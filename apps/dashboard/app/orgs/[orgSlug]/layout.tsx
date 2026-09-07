'use client';

import { use } from 'react';
import { AppShell } from '@/components/app-shell';
import { RequireSession } from '@/components/require-session';

export default function OrgLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = use(params);
  return (
    <RequireSession>
      <AppShell orgSlug={orgSlug}>{children}</AppShell>
    </RequireSession>
  );
}
