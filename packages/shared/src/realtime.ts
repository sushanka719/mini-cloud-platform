import { z } from 'zod';
import { REDIS_CHANNELS } from './constants.js';
import {
  deploymentLogMessageSchema,
  deploymentStatusMessageSchema,
} from './deployments.js';

/**
 * The WebSocket wire contract, shared by the API gateway (server) and the
 * dashboard (client) so neither side can drift.
 *
 * ARCHITECTURE §5: the browser opens **one** socket and then subscribes to
 * topics on it. A topic name is deliberately identical to the Redis Pub/Sub
 * channel it is fed by (`REDIS_CHANNELS`), so the gateway's job is a plain
 * refcounted `SUBSCRIBE`/`UNSUBSCRIBE` per topic rather than a translation
 * table.
 */

/** Bumped when a frame shape changes incompatibly; sent in `hello`. */
export const WS_PROTOCOL_VERSION = 1;

/** The gateway's path on the API. */
export const WS_PATH = '/ws';

// --- topics -----------------------------------------------------------------

export const WS_TOPIC_KINDS = ['deployment', 'project', 'org', 'metrics'] as const;
export type WsTopicKind = (typeof WS_TOPIC_KINDS)[number];

/** A parsed topic. `metrics` is global, the rest are scoped to one entity. */
export type WsTopic =
  | { kind: 'deployment'; id: string; name: string }
  | { kind: 'project'; id: string; name: string }
  | { kind: 'org'; id: string; name: string }
  | { kind: 'metrics'; name: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Parses a client-supplied topic string, or returns null.
 *
 * Strict on purpose: the topic becomes a Redis channel name, so anything but
 * `<kind>:<uuid>` (or the bare `metrics`) is rejected rather than normalised.
 */
export function parseWsTopic(raw: string): WsTopic | null {
  if (raw === REDIS_CHANNELS.metrics) return { kind: 'metrics', name: raw };

  const separator = raw.indexOf(':');
  if (separator <= 0) return null;
  const kind = raw.slice(0, separator);
  const id = raw.slice(separator + 1);
  if (!UUID_RE.test(id)) return null;

  switch (kind) {
    case 'deployment':
      return { kind: 'deployment', id, name: REDIS_CHANNELS.deployment(id) };
    case 'project':
      return { kind: 'project', id, name: REDIS_CHANNELS.project(id) };
    case 'org':
      return { kind: 'org', id, name: REDIS_CHANNELS.org(id) };
    default:
      return null;
  }
}

/** Topic-name builders, so the dashboard never hand-concatenates one. */
export const WS_TOPICS = {
  deployment: REDIS_CHANNELS.deployment,
  project: REDIS_CHANNELS.project,
  org: REDIS_CHANNELS.org,
  metrics: REDIS_CHANNELS.metrics,
} as const;

// --- limits -----------------------------------------------------------------

/** Cap on a single client→server frame. Control messages are tiny. */
export const MAX_WS_CLIENT_FRAME_BYTES = 4_096;

/** Topics one socket may hold at once, so a client can't fan itself out forever. */
export const MAX_TOPICS_PER_SOCKET = 32;

/**
 * How many bytes may sit unflushed in a socket's kernel/ws buffer before we
 * treat the client as a slow consumer and start dropping (ARCHITECTURE §5:
 * "buffer to a bounded queue and drop/coalesce rather than growing memory
 * unbounded"). The client is told, and re-syncs over REST.
 */
export const WS_SEND_BUFFER_LIMIT_BYTES = 1_048_576; // 1 MiB

/** Events replayed on subscribe, newest-tail-first. */
export const WS_REPLAY_LIMIT = 500;

/** Server ping interval; a socket that misses two is reaped. */
export const WS_HEARTBEAT_MS = 30_000;

// --- client → server --------------------------------------------------------

export const wsSubscribeSchema = z.object({
  type: z.literal('subscribe'),
  topic: z.string().min(1).max(200),
  /**
   * Reconnect cursor. Only meaningful for `deployment:<id>`: the gateway
   * replays `deployment_events` with `id > afterEventId` before the first live
   * frame, so a dropped connection loses nothing.
   */
  afterEventId: z.number().int().nonnegative().optional(),
});

export const wsUnsubscribeSchema = z.object({
  type: z.literal('unsubscribe'),
  topic: z.string().min(1).max(200),
});

export const wsPingSchema = z.object({ type: z.literal('ping') });

export const wsClientMessageSchema = z.discriminatedUnion('type', [
  wsSubscribeSchema,
  wsUnsubscribeSchema,
  wsPingSchema,
]);
export type WsClientMessage = z.infer<typeof wsClientMessageSchema>;

// --- server → client --------------------------------------------------------

/** Sent once on connect: proves the socket is authenticated and which API served it. */
export const wsHelloSchema = z.object({
  type: z.literal('hello'),
  protocol: z.number().int(),
  socketId: z.string(),
  /** Which API process answered — the visible half of the fan-out demo. */
  instance: z.string(),
  userId: z.string().uuid(),
  at: z.string(),
});

export const wsSubscribedSchema = z.object({
  type: z.literal('subscribed'),
  topic: z.string(),
  /** Highest replayed event id, so the client can resume from it. null = nothing replayed. */
  replayedThrough: z.number().int().nullable(),
  replayedCount: z.number().int().nonnegative(),
});

export const wsUnsubscribedSchema = z.object({
  type: z.literal('unsubscribed'),
  topic: z.string(),
});

export const wsPongSchema = z.object({ type: z.literal('pong'), at: z.string() });

/** A pipeline transition, as published by the worker plus the topic it came in on. */
export const wsStatusFrameSchema = deploymentStatusMessageSchema.extend({
  topic: z.string(),
});
export type WsStatusFrame = z.infer<typeof wsStatusFrameSchema>;

/** A build log line. */
export const wsLogFrameSchema = deploymentLogMessageSchema.extend({
  topic: z.string(),
});
export type WsLogFrame = z.infer<typeof wsLogFrameSchema>;

/**
 * A sampled metric. Defined here because the roadmap's Phase 5 contract is
 * `log | status | metric | error`; the `metrics` topic is served by the same
 * gateway and Phase 9 supplies the publisher.
 */
export const metricMessageSchema = z.object({
  type: z.literal('metric'),
  /** What was measured: `api:<instance>`, `worker:<name>`, `container:<id>`, `queue`. */
  scope: z.string(),
  name: z.string(),
  value: z.number(),
  unit: z.string().nullable(),
  at: z.string(),
});
export type MetricMessage = z.infer<typeof metricMessageSchema>;

export const wsMetricFrameSchema = metricMessageSchema.extend({ topic: z.string() });
export type WsMetricFrame = z.infer<typeof wsMetricFrameSchema>;

/** Error codes the gateway can send on a frame rather than closing the socket. */
export const WS_ERROR_CODES = [
  'BAD_MESSAGE',
  'UNKNOWN_TOPIC',
  'TOPIC_FORBIDDEN',
  'TOO_MANY_TOPICS',
  'FRAME_TOO_LARGE',
  'REPLAY_FAILED',
  'SUBSCRIBE_FAILED',
  /** The client fell behind and frames were dropped; re-sync over REST. */
  'FRAMES_DROPPED',
] as const;
export const wsErrorCodeSchema = z.enum(WS_ERROR_CODES);
export type WsErrorCode = z.infer<typeof wsErrorCodeSchema>;

export const wsErrorSchema = z.object({
  type: z.literal('error'),
  code: wsErrorCodeSchema,
  message: z.string(),
  topic: z.string().nullable(),
});

export const wsServerMessageSchema = z.discriminatedUnion('type', [
  wsHelloSchema,
  wsSubscribedSchema,
  wsUnsubscribedSchema,
  wsPongSchema,
  wsStatusFrameSchema,
  wsLogFrameSchema,
  wsMetricFrameSchema,
  wsErrorSchema,
]);
export type WsServerMessage = z.infer<typeof wsServerMessageSchema>;

/**
 * WebSocket close codes we originate. 4000+ is the application-private range,
 * so a client can tell "you were logged out" from "the server went away".
 */
export const WS_CLOSE = {
  /** Normal shutdown of the API process. */
  goingAway: 1001,
  /** No/invalid credential on the handshake. */
  unauthorized: 4401,
  /** Origin not in the allowlist (cross-site socket hijacking attempt). */
  forbiddenOrigin: 4403,
  /** Client sent frames faster than it read, or too much garbage. */
  policyViolation: 4400,
  /** Heartbeat missed — the peer is gone. */
  heartbeatTimeout: 4408,
} as const;
