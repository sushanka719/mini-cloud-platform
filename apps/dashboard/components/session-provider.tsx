'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useMemo } from 'react';
import { ApiError, api, type OrgMembership, type SessionResponse } from '@/lib/api';

/**
 * The current session, fetched once from `/auth/me` and shared by every screen.
 *
 * A 401 is a valid answer ("not logged in"), not a failure — so it resolves to
 * null instead of retrying, and only real errors surface.
 */

type SessionContextValue = {
  session: SessionResponse | null;
  orgs: OrgMembership[];
  isLoading: boolean;
  /** Re-reads /auth/me and drops every cached org-scoped query. */
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
};

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['session'],
    queryFn: async () => {
      try {
        return await api.get<SessionResponse>('/auth/me');
      } catch (err) {
        if (err instanceof ApiError && err.isUnauthorized) return null;
        throw err;
      }
    },
    retry: false,
    staleTime: 30_000,
  });

  const refresh = useCallback(async () => {
    await queryClient.invalidateQueries();
  }, [queryClient]);

  const logout = useCallback(async () => {
    await api.post('/auth/logout');
    // Clear rather than invalidate: another user may log in next, and stale
    // org data must not flash on screen before the refetch lands.
    queryClient.clear();
  }, [queryClient]);

  const value = useMemo<SessionContextValue>(
    () => ({
      session: data ?? null,
      orgs: data?.orgs ?? [],
      isLoading,
      refresh,
      logout,
    }),
    [data, isLoading, refresh, logout],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const context = useContext(SessionContext);
  if (!context) throw new Error('useSession must be used inside <SessionProvider>');
  return context;
}

/** The caller's role in a given org, or undefined if they aren't a member. */
export function useOrgRole(orgSlug: string | undefined) {
  const { orgs } = useSession();
  return orgs.find((o) => o.slug === orgSlug || o.id === orgSlug)?.role;
}
