import { env } from '@forge/config';
import { LocalObjectStore, configureCompressionPool } from '@forge/storage';

/**
 * The worker's handle on the object store — the same root the API writes
 * uploads to, so a build reads exactly the bytes that were uploaded.
 *
 * `@forge/storage` deliberately does not read the environment (ARCHITECTURE §9
 * puts `storage → shared` only), so the root and the pool size are injected
 * here, mirroring `apps/api/src/lib/object-store.ts`.
 */
export const objectStore = new LocalObjectStore(env.STORAGE_ROOT);

configureCompressionPool({ size: env.COMPRESSION_THREADS });
