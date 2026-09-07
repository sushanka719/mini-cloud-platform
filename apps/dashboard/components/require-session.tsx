'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { useSession } from '@/components/session-provider';

/**
 * Client-side gate. The API is the real authority — every route it serves
 * checks the session itself — this only avoids rendering a screen that would
 * be all 401s.
 */
export function RequireSession({ children }: { children: React.ReactNode }) {
  const { session, isLoading } = useSession();
  const router = useRouter();

  useEffect(() => {
    if (!isLoading && !session) router.replace('/login');
  }, [isLoading, session, router]);

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center text-sm text-[#8b90a3]">
        Loading…
      </div>
    );
  }
  if (!session) return null;
  return <>{children}</>;
}
