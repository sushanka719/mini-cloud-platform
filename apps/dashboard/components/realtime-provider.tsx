'use client';

import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useSession } from '@/components/session-provider';
import {
  RealtimeClient,
  type RealtimeStatus,
  type TopicErrorHandler,
  type TopicHandler,
} from '@/lib/realtime';

/**
 * Owns the tab's single WebSocket.
 *
 * It lives above the pages so navigating between projects doesn't tear the
 * socket down and re-authenticate; only the topic subscriptions change.
 */

type RealtimeContextValue = {
  status: RealtimeStatus;
  /** Which API process is serving this socket (from the `hello` frame). */
  instance: string | null;
  subscribe: RealtimeClient['subscribe'];
};

const RealtimeContext = createContext<RealtimeContextValue | null>(null);

export function RealtimeProvider({ children }: { children: React.ReactNode }) {
  const { session, isLoading } = useSession();
  const [client] = useState(() => new RealtimeClient());
  const [status, setStatus] = useState<RealtimeStatus>('closed');
  const [instance, setInstance] = useState<string | null>(null);
  const userId = session?.user.id ?? null;

  useEffect(() => {
    const off = client.onStatus((next) => {
      setStatus(next);
      setInstance(client.instance);
    });
    return off;
  }, [client]);

  /**
   * Connect only once we know who we are: the handshake is authenticated, so
   * opening before `/auth/me` resolves would just be refused with a 401.
   * A different user (log out, log in) gets a fresh socket.
   */
  useEffect(() => {
    if (isLoading || !userId) return;
    client.reset();
    return () => {
      client.close();
    };
  }, [client, isLoading, userId]);

  const value = useMemo<RealtimeContextValue>(
    () => ({ status, instance, subscribe: client.subscribe.bind(client) }),
    [status, instance, client],
  );

  return <RealtimeContext.Provider value={value}>{children}</RealtimeContext.Provider>;
}

export function useRealtime(): RealtimeContextValue {
  const context = useContext(RealtimeContext);
  if (!context) throw new Error('useRealtime must be used inside <RealtimeProvider>');
  return context;
}

/**
 * Subscribes to one topic for the lifetime of the component.
 *
 * The handler is held in a ref so a re-render with a new closure doesn't
 * resubscribe (which would replay the whole history again); pass `null` as the
 * topic to subscribe to nothing.
 */
export function useTopic(
  topic: string | null,
  handler: TopicHandler,
  options: { onError?: TopicErrorHandler } = {},
): void {
  const { subscribe, status } = useRealtime();
  // Held in refs so a re-render with new closures doesn't resubscribe — which
  // would replay the whole event history again.
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  const errorRef = useRef(options.onError);
  errorRef.current = options.onError;

  useEffect(() => {
    if (topic === null || status !== 'open') return;
    return subscribe(topic, (frame) => handlerRef.current(frame), {
      onError: (frame) => errorRef.current?.(frame),
    });
    // `status` is a dependency so a subscription made while the socket was
    // down is re-established once it comes back.
  }, [subscribe, topic, status]);
}
