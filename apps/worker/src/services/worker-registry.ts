import { hostname } from 'node:os';
import { env, type Logger } from '@forge/config';
import { workerRepo } from '@forge/db';
import {
  REDIS_KEYS,
  WORKER_HEARTBEAT_TTL_FACTOR,
  type WorkerHeartbeat,
  type WorkerStatus,
} from '@forge/shared';
import { getRedis } from '../lib/redis.js';

/**
 * Worker identity + liveness.
 *
 * Two records, on purpose:
 *  - a row in `workers` (Postgres) — the durable registry and the history of
 *    which process ran which deployment;
 *  - a Redis key with a TTL — the liveness signal. A worker killed with
 *    SIGKILL never gets to write "offline", so the row would lie forever; an
 *    expiring key can't.
 *
 * Nothing about the fleet lives in process memory, so every API replica sees
 * the same picture (CLAUDE.md §4).
 */
export class WorkerRegistry {
  readonly name: string;
  readonly host = hostname();
  readonly pid = process.pid;
  readonly concurrency = env.WORKER_CONCURRENCY;

  private id: string | null = null;
  private status: WorkerStatus = 'idle';
  private timer: NodeJS.Timeout | null = null;
  private readonly active = new Set<string>();

  constructor(private readonly log: Logger) {
    this.name = env.WORKER_NAME ?? `${this.host}-${this.pid}`;
  }

  get workerId(): string {
    if (!this.id) throw new Error('worker is not registered yet');
    return this.id;
  }

  get activeCount(): number {
    return this.active.size;
  }

  /**
   * Exposed for the metrics document: it is the same status the heartbeat
   * writes, and a metrics card that said `idle` while the heartbeat said
   * `draining` would be two answers to one question.
   */
  get currentStatus(): WorkerStatus {
    return this.status;
  }

  /** Null before `register()`; the metrics document tolerates that. */
  get registeredId(): string | null {
    return this.id;
  }

  /**
   * Whether *this* process is running that deployment right now.
   *
   * Read by the stalled-job takeover (Phase 10). BullMQ can re-deliver a job
   * whose lock lapsed to the same worker that is still running it — a long
   * event-loop block is enough to miss a renewal — and the one thing the
   * takeover must never do is start a second pipeline for a deployment this
   * process has in flight.
   */
  isRunning(deploymentId: string): boolean {
    return this.active.has(deploymentId);
  }

  /** Inserts the registry row and starts the heartbeat loop. */
  async register(): Promise<string> {
    const row = await workerRepo.registerWorker({
      name: this.name,
      host: this.host,
      pid: this.pid,
      concurrency: this.concurrency,
    });
    this.id = row.id;
    await this.beat();

    this.timer = setInterval(() => {
      void this.beat().catch((err: unknown) => {
        // A missed beat is survivable: the TTL is three intervals wide, and the
        // next one repairs it. Losing the process to an unhandled rejection is not.
        this.log.warn({ err }, 'heartbeat failed');
      });
    }, env.WORKER_HEARTBEAT_MS);
    this.timer.unref();

    this.log.info(
      { workerId: row.id, name: this.name, concurrency: this.concurrency },
      'worker registered',
    );
    return row.id;
  }

  /** Called when a job starts/ends so the fleet view shows what's running. */
  jobStarted(deploymentId: string): void {
    this.active.add(deploymentId);
    this.status = 'busy';
    void this.beat().catch(() => undefined);
  }

  jobFinished(deploymentId: string): void {
    this.active.delete(deploymentId);
    if (this.status !== 'draining') this.status = this.active.size > 0 ? 'busy' : 'idle';
    void this.beat().catch(() => undefined);
  }

  /** Stops accepting new work; still heartbeats while in-flight jobs drain. */
  async drain(): Promise<void> {
    this.status = 'draining';
    await this.beat().catch(() => undefined);
  }

  private async beat(): Promise<void> {
    if (!this.id) return;
    const current = [...this.active][0] ?? null;
    const payload: WorkerHeartbeat = {
      workerId: this.id,
      name: this.name,
      status: this.status,
      host: this.host,
      pid: this.pid,
      concurrency: this.concurrency,
      activeJobs: this.active.size,
      at: new Date().toISOString(),
    };
    const ttlSeconds = Math.ceil(
      (env.WORKER_HEARTBEAT_MS * WORKER_HEARTBEAT_TTL_FACTOR) / 1000,
    );
    await getRedis()
      .multi()
      .set(REDIS_KEYS.workerHeartbeat(this.id), JSON.stringify(payload), 'EX', ttlSeconds)
      .sadd(REDIS_KEYS.workersOnline, this.id)
      .exec();
    await workerRepo.heartbeatWorker(this.id, this.status, current);
  }

  /** Best-effort clean exit: mark offline in both stores. */
  async unregister(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (!this.id) return;
    this.status = 'offline';
    await Promise.allSettled([
      getRedis()
        .multi()
        .del(REDIS_KEYS.workerHeartbeat(this.id))
        .srem(REDIS_KEYS.workersOnline, this.id)
        .exec(),
      workerRepo.setWorkerStatus(this.id, 'offline'),
    ]);
    this.log.info({ workerId: this.id }, 'worker unregistered');
  }
}
