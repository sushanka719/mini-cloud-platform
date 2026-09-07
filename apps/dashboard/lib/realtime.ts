import { API_URL, type DeploymentEvent, type DeploymentStatus } from '@/lib/api';

/**
 * The browser half of the realtime layer: **one** WebSocket for the whole tab,
 * multiplexed over topics, with reconnect and per-topic replay cursors.
 *
 * Types mirror `@forge/shared`'s WS contract as plain structural types, the
 * same convention `lib/api.ts` follows — the dashboard is bundled by Next
 * rather than compiled against the workspace's tsc project references.
 */

export const WS_URL = `${API_URL.replace(/^http/, 'ws')}/ws`;

// --- frames -----------------------------------------------------------------

export type WsStatusFrame = {
  type: 'status';
  topic: string;
  deploymentId: string;
  projectId: string;
  orgId: string;
  status: DeploymentStatus;
  eventId: number;
  message: string | null;
  at: string;
};

export type WsLogFrame = {
  type: 'log';
  topic: string;
  deploymentId: string;
  projectId: string;
  orgId: string;
  status: DeploymentStatus;
  stream: 'stdout' | 'stderr' | 'system';
  eventId: number;
  message: string;
  at: string;
};

export type WsMetricFrame = {
  type: 'metric';
  topic: string;
  scope: string;
  name: string;
  value: number;
  unit: string | null;
  at: string;
};

export type WsErrorFrame = {
  type: 'error';
  code:
    | 'BAD_MESSAGE'
    | 'UNKNOWN_TOPIC'
    | 'TOPIC_FORBIDDEN'
    | 'TOO_MANY_TOPICS'
    | 'FRAME_TOO_LARGE'
    | 'REPLAY_FAILED'
    | 'SUBSCRIBE_FAILED'
    | 'FRAMES_DROPPED';
  message: string;
  topic: string | null;
};

type WsControlFrame =
  | { type: 'hello'; protocol: number; socketId: string; instance: string; userId: string; at: string }
  | { type: 'subscribed'; topic: string; replayedThrough: number | null; replayedCount: number }
  | { type: 'unsubscribed'; topic: string }
  | { type: 'pong'; at: string };

export type WsDataFrame = WsStatusFrame | WsLogFrame | WsMetricFrame;
export type WsFrame = WsDataFrame | WsErrorFrame | WsControlFrame;

/** Topic-name builders — never hand-concatenate one. */
export const topics = {
  deployment: (id: string) => `deployment:${id}`,
  project: (id: string) => `project:${id}`,
  org: (id: string) => `org:${id}`,
  metrics: 'metrics',
};

/** Turns a live frame into the same shape the REST timeline returns. */
export function frameToEvent(frame: WsStatusFrame | WsLogFrame): DeploymentEvent {
  return {
    id: frame.eventId,
    deploymentId: frame.deploymentId,
    type: frame.type,
    status: frame.type === 'status' ? frame.status : null,
    stream: frame.type === 'log' ? frame.stream : null,
    message: frame.message,
    createdAt: frame.at,
  };
}

// --- client -----------------------------------------------------------------

export type RealtimeStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';

export type TopicHandler = (frame: WsDataFrame) => void;
export type TopicErrorHandler = (frame: WsErrorFrame) => void;

type TopicState = {
  handlers: Set<TopicHandler>;
  errorHandlers: Set<TopicErrorHandler>;
  /**
   * Highest event id seen on this topic, resent as `afterEventId` when the
   * socket comes back — which is what makes a reconnect lossless instead of
   * merely reconnected.
   */
  cursor: number | null;
};

/** Close codes the server originates; 4401 means "don't bother retrying". */
const CLOSE_SESSION_ENDED = 4401;
const CLOSE_ORIGIN_REJECTED = 4403;

export class RealtimeClient {
  private socket: WebSocket | null = null;
  private readonly topicStates = new Map<string, TopicState>();
  private readonly statusListeners = new Set<(status: RealtimeStatus) => void>();
  private status: RealtimeStatus = 'closed';
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  /** Which API process served this socket — shown in the UI as proof of fan-out. */
  instance: string | null = null;

  getStatus(): RealtimeStatus {
    return this.status;
  }

  onStatus(listener: (status: RealtimeStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  private setStatus(status: RealtimeStatus): void {
    if (this.status === status) return;
    this.status = status;
    for (const listener of this.statusListeners) listener(status);
  }

  connect(): void {
    if (this.stopped) return;
    if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) {
      return;
    }
    this.setStatus(this.attempt === 0 ? 'connecting' : 'reconnecting');

    // No token in the URL: query strings end up in access logs, and the
    // session cookie is sent on the handshake anyway (same-site: the dashboard
    // and the API differ only by port).
    const socket = new WebSocket(WS_URL);
    this.socket = socket;

    socket.onopen = () => {
      this.attempt = 0;
      this.setStatus('open');
      // Re-declare every topic, each from where it left off.
      for (const [topic, state] of this.topicStates) this.sendSubscribe(topic, state);
    };

    socket.onmessage = (event: MessageEvent<string>) => {
      let frame: WsFrame;
      try {
        frame = JSON.parse(event.data) as WsFrame;
      } catch {
        return;
      }
      this.dispatch(frame);
    };

    socket.onclose = (event: CloseEvent) => {
      this.socket = null;
      if (this.stopped) return this.setStatus('closed');
      if (event.code === CLOSE_SESSION_ENDED || event.code === CLOSE_ORIGIN_REJECTED) {
        // Retrying can't help: the credential or the origin is the problem.
        this.setStatus('closed');
        return;
      }
      this.scheduleReconnect();
    };

    // `onerror` is always followed by `onclose`, which owns the retry.
    socket.onerror = () => {};
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) return;
    this.attempt += 1;
    // Capped exponential backoff with jitter, so N tabs reconnecting after an
    // API restart don't arrive in lockstep.
    const base = Math.min(500 * 2 ** (this.attempt - 1), 10_000);
    const delay = base / 2 + Math.random() * (base / 2);
    this.setStatus('reconnecting');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private dispatch(frame: WsFrame): void {
    if (frame.type === 'hello') {
      this.instance = frame.instance;
      // Re-notify: the badge shows the instance alongside the status.
      for (const listener of this.statusListeners) listener(this.status);
      return;
    }
    if (frame.type === 'subscribed') {
      const state = this.topicStates.get(frame.topic);
      if (state && frame.replayedThrough !== null) state.cursor = frame.replayedThrough;
      return;
    }
    if (frame.type === 'unsubscribed' || frame.type === 'pong') return;

    if (frame.type === 'error') {
      const state = frame.topic === null ? null : this.topicStates.get(frame.topic);
      if (state) for (const handler of state.errorHandlers) handler(frame);
      else console.warn('[realtime]', frame.code, frame.message);
      return;
    }

    const state = this.topicStates.get(frame.topic);
    if (!state) return;
    if (frame.type !== 'metric') {
      // Drop anything the cursor already covers — the replay/live overlap.
      if (state.cursor !== null && frame.eventId <= state.cursor) return;
      state.cursor = frame.eventId;
    }
    for (const handler of state.handlers) handler(frame);
  }

  private sendSubscribe(topic: string, state: TopicState): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(
      JSON.stringify({
        type: 'subscribe',
        topic,
        ...(state.cursor !== null ? { afterEventId: state.cursor } : {}),
      }),
    );
  }

  /**
   * Adds a listener for a topic. Several components may watch the same topic;
   * only the first triggers a `subscribe` and only the last an `unsubscribe`,
   * mirroring the refcount the server keeps against Redis.
   */
  subscribe(
    topic: string,
    handler: TopicHandler,
    options: { onError?: TopicErrorHandler } = {},
  ): () => void {
    let state = this.topicStates.get(topic);
    const fresh = state === undefined;
    if (!state) {
      // cursor null = "replay everything you have"; from then on the client
      // owns the cursor, which is what makes a reconnect lossless.
      state = { handlers: new Set(), errorHandlers: new Set(), cursor: null };
      this.topicStates.set(topic, state);
    }
    state.handlers.add(handler);
    if (options.onError) state.errorHandlers.add(options.onError);
    if (fresh) this.sendSubscribe(topic, state);

    const current = state;
    return () => {
      current.handlers.delete(handler);
      if (options.onError) current.errorHandlers.delete(options.onError);
      if (current.handlers.size > 0) return;
      this.topicStates.delete(topic);
      if (this.socket?.readyState === WebSocket.OPEN) {
        this.socket.send(JSON.stringify({ type: 'unsubscribe', topic }));
      }
    };
  }

  /** Reconnect now — used after a login, when a socket was refused earlier. */
  reset(): void {
    this.stopped = false;
    this.attempt = 0;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.socket?.close();
    this.socket = null;
    this.connect();
  }

  close(): void {
    this.stopped = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.topicStates.clear();
    this.socket?.close(1000, 'client navigating away');
    this.socket = null;
    this.setStatus('closed');
  }
}
