import { env } from '@forge/config';
import { LocalObjectStore, configureCompressionPool } from '@forge/storage';

/**
 * The API's single handle on the object store.
 *
 * `@forge/storage` deliberately does not read the environment (ARCHITECTURE §9
 * puts `storage → shared` only), so the root and the pool size are injected
 * here — the one place in the API that knows about config for storage.
 */
export const objectStore = new LocalObjectStore(env.STORAGE_ROOT);

configureCompressionPool({ size: env.COMPRESSION_THREADS });
