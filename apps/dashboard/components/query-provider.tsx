'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { ApiError } from '@/lib/api';
import { SessionProvider } from '@/components/session-provider';
import { RealtimeProvider } from '@/components/realtime-provider';

export function QueryProvider({ children }: { children: React.ReactNode }) {
  // One client per browser session; created lazily so it isn't shared across
  // requests during SSR.
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // Never retry an auth/permission failure — the answer won't change,
            // and retrying just delays the login redirect.
            retry: (count, error) =>
              !(error instanceof ApiError && (error.isUnauthorized || error.isForbidden)) &&
              count < 1,
            staleTime: 2_000,
            refetchOnWindowFocus: false,
          },
        },
      }),
  );

  return (
    <QueryClientProvider client={client}>
      <SessionProvider>
        {/* Inside SessionProvider: the socket handshake is authenticated, so it
            waits until /auth/me has resolved. */}
        <RealtimeProvider>{children}</RealtimeProvider>
      </SessionProvider>
    </QueryClientProvider>
  );
}
