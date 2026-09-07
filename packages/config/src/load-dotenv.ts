import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { config as dotenvConfig } from 'dotenv';

/**
 * Apps are started from their own package dir (apps/api, apps/worker...), but the
 * single source of truth for env is the repo-root `.env`. Walk up until we find one.
 */
export function loadDotenv(startDir: string = process.cwd(), maxDepth = 5): string | null {
  let dir = resolve(startDir);
  for (let i = 0; i <= maxDepth; i++) {
    const candidate = resolve(dir, '.env');
    if (existsSync(candidate)) {
      dotenvConfig({ path: candidate, quiet: true });
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}
