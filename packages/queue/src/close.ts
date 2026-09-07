import { closeContainerActionsQueue } from './container-actions-queue.js';
import { closeDeadLetterQueue } from './dead-letter-queue.js';
import { closeDeploymentsQueue } from './deployments-queue.js';
import { closeBorrowed } from './runtime.js';

/**
 * Releases every handle the package owns.
 *
 * One entry point rather than one per queue, because the callers are graceful
 * shutdown paths (`apps/api/src/server.ts`, `apps/worker/src/main.ts`) and a
 * second queue added later must not need a second line there — a leaked BullMQ
 * connection is exactly the kind of thing that makes a process refuse to exit.
 *
 * `allSettled`: one queue failing to close must not leave the others open.
 */
export async function closeQueue(): Promise<void> {
  await Promise.allSettled([
    closeDeploymentsQueue(),
    closeContainerActionsQueue(),
    closeDeadLetterQueue(),
    closeBorrowed(),
  ]);
}
