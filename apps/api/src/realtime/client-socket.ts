import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import type { FastifyBaseLogger } from 'fastify';
import {
  MAX_TOPICS_PER_SOCKET,
  MAX_WS_CLIENT_FRAME_BYTES,
  WS_CLOSE,
  WS_PROTOCOL_VERSION,
  WS_SEND_BUFFER_LIMIT_BYTES,
  deploymentMessageSchema,
  metricMessageSchema,
  parseWsTopic,
  wsClientMessageSchema,
  type WsErrorCode,
  type WsLogFrame,
  type WsMetricFrame,
  type WsServerMessage,
  type WsStatusFrame,
  type WsTopic,
} from '@forge/shared';
import type { Actor } from '../plugins/auth.js';
import { subscribeChannel } from '../lib/pubsub.js';
import { authorizeTopic } from './topic-access.js';
import { loadReplay } from './replay.js';

/**
 * One browser connection.
 *
 * ARCHITECTURE §5 puts the subscription registry here rather than in a library:
 * the socket owns which topics it holds, the Redis subscription refcount that
 * backs each one, the replay cursor per topic, and the bounded-buffer policy
 * when the client reads slower than the worker writes.
 */

type DataFrame = WsStatusFrame | WsLogFrame | WsMetricFrame;

type Subscription = {
  topic: WsTopic;
  /** Drops this socket's listener from the process-wide Redis subscription. */
  release: () => void;
  /**
   * Highest `deployment_events` id already sent on this topic, or null for
   * topics that carry frames from many deployments (`project:`/`org:`), where
   * a single cursor would wrongly filter.
   */
  cursor: number | null;
  /** True between SUBSCRIBE and the end of replay; live frames wait in `pending`. */
  replaying: boolean;
  pending: DataFrame[];
};

/** Safety net on the replay buffer — replay is fast, but never unbounded. */
const MAX_PENDING_FRAMES = 1_000;

/** How long to wait for a slow socket to drain before reporting the drops. */
const DROP_NOTICE_DELAY_MS = 250;

export class ClientSocket {
  readonly id = randomUUID();
  private readonly subs = new Map<string, Subscription>();
  /**
   * Client messages are handled one at a time. Two `subscribe` frames for the
   * same topic arriving back to back would otherwise both pass the "not
   * subscribed yet" check and open two Redis listeners.
   */
  private queue: Promise<void> = Promise.resolve();
  private droppedFrames = 0;
  /** Topic the most recent drop belonged to, reported with the notice. */
  private dropTopic: string | null = null;
  private dropNoticeTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  /** Cleared when we ping, set when the peer answers — a missed round = dead. */
  awaitingPong = false;

  constructor(
    private readonly socket: WebSocket,
    readonly actor: Actor,
    private readonly log: FastifyBaseLogger,
    private readonly instance: string,
  ) {}

  get topicCount(): number {
    return this.subs.size;
  }

  get topics(): string[] {
    return [...this.subs.keys()];
  }

  /** The session token this socket authenticated with, for revocation checks. */
  get sessionToken(): string | null {
    return this.actor.via === 'session' ? this.actor.token : null;
  }

  hello(): void {
    this.send({
      type: 'hello',
      protocol: WS_PROTOCOL_VERSION,
      socketId: this.id,
      instance: this.instance,
      userId: this.actor.user.id,
      at: new Date().toISOString(),
    });
  }

  // --- sending --------------------------------------------------------------

  /** Control frames: small, rare, and never dropped — the protocol needs them. */
  private send(frame: WsServerMessage): void {
    if (this.closed || this.socket.readyState !== this.socket.OPEN) return;
    this.socket.send(JSON.stringify(frame));
  }

  private sendError(code: WsErrorCode, message: string, topic: string | null): void {
    this.send({ type: 'error', code, message, topic });
  }

  /**
   * Data frames are droppable. If the client is reading slower than the worker
   * is producing, the kernel/ws buffer grows without bound — so past the limit
   * we drop and count instead (ARCHITECTURE §5). Silently showing an
   * incomplete log would be worse than saying so, hence the notice below.
   */
  private sendData(frame: DataFrame): void {
    if (this.closed || this.socket.readyState !== this.socket.OPEN) return;
    if (this.socket.bufferedAmount > WS_SEND_BUFFER_LIMIT_BYTES) {
      this.droppedFrames += 1;
      this.dropTopic = frame.topic;
      this.scheduleDropNotice();
      return;
    }
    this.socket.send(JSON.stringify(frame));
  }

  /**
   * Tells the client what it missed, once the socket has drained enough to
   * accept the message.
   *
   * On a timer rather than piggybacked on the next data frame: a flood that
   * stops leaves no next frame to ride on, and the client would never learn
   * its log has a hole.
   */
  private scheduleDropNotice(): void {
    if (this.dropNoticeTimer !== null) return;
    this.dropNoticeTimer = setTimeout(() => {
      this.dropNoticeTimer = null;
      if (this.closed || this.socket.readyState !== this.socket.OPEN) return;
      if (this.socket.bufferedAmount > WS_SEND_BUFFER_LIMIT_BYTES) {
        // Still behind — check again rather than adding to the backlog.
        this.scheduleDropNotice();
        return;
      }
      const dropped = this.droppedFrames;
      if (dropped === 0) return;
      this.droppedFrames = 0;
      this.log.warn({ socketId: this.id, dropped }, 'ws slow consumer, frames dropped');
      this.sendError(
        'FRAMES_DROPPED',
        `${String(dropped)} frames were dropped because this socket fell behind; re-read the timeline over REST`,
        this.dropTopic,
      );
    }, DROP_NOTICE_DELAY_MS);
    this.dropNoticeTimer.unref();
  }

  // --- receiving -----------------------------------------------------------

  /** Queued so one socket's messages are handled strictly in order. */
  onMessage(raw: Buffer | ArrayBuffer | Buffer[]): void {
    this.queue = this.queue.then(() => this.handleMessage(raw)).catch((err: unknown) => {
      this.log.error({ err, socketId: this.id }, 'ws message handler failed');
    });
  }

  private async handleMessage(raw: Buffer | ArrayBuffer | Buffer[]): Promise<void> {
    if (this.closed) return;
    const text = Array.isArray(raw)
      ? Buffer.concat(raw).toString('utf8')
      : Buffer.from(raw as Buffer).toString('utf8');

    // `maxPayload` already rejects oversized frames at the ws layer; this is
    // the belt to that braces, and keeps the limit visible in one contract.
    if (Buffer.byteLength(text) > MAX_WS_CLIENT_FRAME_BYTES) {
      this.sendError('FRAME_TOO_LARGE', 'Control frames must be small', null);
      return;
    }

    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      this.sendError('BAD_MESSAGE', 'Expected a JSON object', null);
      return;
    }

    const parsed = wsClientMessageSchema.safeParse(json);
    if (!parsed.success) {
      this.sendError('BAD_MESSAGE', 'Unrecognised message; see the WS contract', null);
      return;
    }

    switch (parsed.data.type) {
      case 'ping':
        this.send({ type: 'pong', at: new Date().toISOString() });
        return;
      case 'unsubscribe':
        this.unsubscribe(parsed.data.topic);
        return;
      case 'subscribe':
        await this.subscribe(parsed.data.topic, parsed.data.afterEventId);
        return;
    }
  }

  // --- subscriptions -------------------------------------------------------

  private async subscribe(raw: string, afterEventId?: number): Promise<void> {
    const topic = parseWsTopic(raw);
    if (!topic) {
      this.sendError('UNKNOWN_TOPIC', `"${raw}" is not a valid topic`, raw);
      return;
    }

    const existing = this.subs.get(topic.name);
    if (existing) {
      // Idempotent: re-subscribing is an ack, not a second listener.
      this.send({
        type: 'subscribed',
        topic: topic.name,
        replayedThrough: existing.cursor,
        replayedCount: 0,
      });
      return;
    }

    if (this.subs.size >= MAX_TOPICS_PER_SOCKET) {
      this.sendError(
        'TOO_MANY_TOPICS',
        `A socket may hold at most ${String(MAX_TOPICS_PER_SOCKET)} topics`,
        topic.name,
      );
      return;
    }

    const decision = await authorizeTopic(this.actor, topic);
    if (!decision.ok) {
      this.sendError(decision.code, decision.message, topic.name);
      return;
    }
    if (this.closed) return;

    const deployment = topic.kind === 'deployment' ? decision.deployment : undefined;
    const sub: Subscription = {
      topic,
      release: () => {},
      cursor: deployment ? (afterEventId ?? 0) : null,
      // Only a deployment topic replays, so only it needs the buffering window.
      replaying: deployment !== undefined,
      pending: [],
    };
    this.subs.set(topic.name, sub);

    /**
     * Subscribe to Redis *before* reading the timeline, so nothing published
     * between the read and the subscribe is lost. Frames that arrive during
     * the replay are buffered and then de-duplicated against it by event id —
     * ordering the other way round would leave a gap instead.
     */
    try {
      sub.release = await subscribeChannel(topic.name, (payload) => {
        this.onChannelMessage(sub, payload);
      });
    } catch (err) {
      this.subs.delete(topic.name);
      this.log.warn({ err, topic: topic.name }, 'ws subscribe failed');
      this.sendError(
        'SUBSCRIBE_FAILED',
        'The realtime backend is unavailable; falling back to polling is safe',
        topic.name,
      );
      return;
    }

    if (this.closed) {
      sub.release();
      this.subs.delete(topic.name);
      return;
    }

    let replayedCount = 0;
    if (deployment) {
      try {
        const replay = await loadReplay(deployment, topic.name, sub.cursor ?? 0);
        for (const frame of replay.frames) this.sendData(frame);
        replayedCount = replay.frames.length;
        if (replay.through !== null) sub.cursor = replay.through;
      } catch (err) {
        // Live frames still work, so keep the subscription and say so rather
        // than pretending the client is fully synced.
        this.log.error({ err, topic: topic.name }, 'ws replay failed');
        this.sendError(
          'REPLAY_FAILED',
          'Could not replay the event history; read it over REST',
          topic.name,
        );
      }
    }

    this.send({
      type: 'subscribed',
      topic: topic.name,
      replayedThrough: sub.cursor,
      replayedCount,
    });

    // Flush whatever arrived while we were replaying, minus anything the
    // replay already covered.
    const buffered = sub.pending;
    sub.pending = [];
    sub.replaying = false;
    for (const frame of buffered) this.deliver(sub, frame);
  }

  private unsubscribe(raw: string): void {
    const topic = parseWsTopic(raw);
    const name = topic?.name ?? raw;
    const sub = this.subs.get(name);
    if (sub) {
      sub.release();
      this.subs.delete(name);
    }
    // Acked either way: "you are not subscribed" is the state the client asked for.
    this.send({ type: 'unsubscribed', topic: name });
  }

  /** A raw Redis payload for one of this socket's topics. */
  private onChannelMessage(sub: Subscription, payload: string): void {
    if (this.closed) return;

    let json: unknown;
    try {
      json = JSON.parse(payload);
    } catch {
      this.log.warn({ topic: sub.topic.name }, 'unparseable pubsub payload');
      return;
    }

    // Never forward an unvalidated payload to a client: the frame shape is a
    // published contract, and anything on the channel could have been written
    // by an older process.
    if (sub.topic.kind === 'metrics') {
      const metric = metricMessageSchema.safeParse(json);
      if (!metric.success) return;
      this.deliver(sub, { ...metric.data, topic: sub.topic.name });
      return;
    }

    const message = deploymentMessageSchema.safeParse(json);
    if (!message.success) {
      this.log.warn({ topic: sub.topic.name }, 'pubsub payload failed validation');
      return;
    }
    this.deliver(sub, { ...message.data, topic: sub.topic.name });
  }

  private deliver(sub: Subscription, frame: DataFrame): void {
    if (sub.replaying) {
      if (sub.pending.length >= MAX_PENDING_FRAMES) {
        this.droppedFrames += 1;
        return;
      }
      sub.pending.push(frame);
      return;
    }

    // Deployment topics carry one monotonic event stream, so the cursor both
    // de-duplicates the replay overlap and survives a resubscribe.
    if (sub.cursor !== null && frame.type !== 'metric') {
      if (frame.eventId <= sub.cursor) return;
      sub.cursor = frame.eventId;
    }
    this.sendData(frame);
  }

  /**
   * Re-runs authorization on every held subscription and drops the ones that
   * no longer pass.
   *
   * A socket can stay open for hours, so the membership that authorized a
   * subscription is not necessarily the membership that exists now — being
   * removed from an org has to stop the build logs, not merely block the next
   * subscribe. Run from the gateway's heartbeat tick alongside the session
   * re-validation, so authorization is refreshed on the same cadence.
   */
  async revalidateSubscriptions(): Promise<void> {
    if (this.closed || this.subs.size === 0) return;
    for (const [name, sub] of [...this.subs]) {
      let decision;
      try {
        decision = await authorizeTopic(this.actor, sub.topic);
      } catch (err) {
        // A database blip must not revoke access; /health reports the outage.
        this.log.warn({ err, topic: name }, 'could not revalidate ws topic');
        return;
      }
      if (decision.ok || this.closed) continue;
      this.log.info({ socketId: this.id, topic: name }, 'ws access revoked, dropping topic');
      sub.release();
      this.subs.delete(name);
      this.sendError(decision.code, 'Access to this topic was revoked', name);
      this.send({ type: 'unsubscribed', topic: name });
    }
  }

  // --- lifecycle -----------------------------------------------------------

  ping(): void {
    if (this.closed || this.socket.readyState !== this.socket.OPEN) return;
    this.awaitingPong = true;
    this.socket.ping();
  }

  /** Terminates a socket whose peer stopped answering pings. */
  terminate(): void {
    this.closed = true;
    this.socket.close(WS_CLOSE.heartbeatTimeout, 'heartbeat timeout');
    // close() waits for the peer; a peer that stopped answering pings will not
    // answer this either, so drop the socket outright.
    this.socket.terminate();
    this.releaseAll();
  }

  closeWith(code: number, reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.releaseAll();
    if (this.socket.readyState === this.socket.OPEN) this.socket.close(code, reason);
  }

  /** Called from the socket's own `close` handler. */
  onClosed(): void {
    this.closed = true;
    this.releaseAll();
  }

  private releaseAll(): void {
    if (this.dropNoticeTimer !== null) {
      clearTimeout(this.dropNoticeTimer);
      this.dropNoticeTimer = null;
    }
    for (const sub of this.subs.values()) sub.release();
    this.subs.clear();
  }
}
