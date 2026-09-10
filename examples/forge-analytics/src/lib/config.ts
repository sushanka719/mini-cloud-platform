/**
 * Runtime configuration, validated with Zod.
 *
 * Validated rather than read raw because ForgeCloud injects this environment
 * from the project's own env-var panel, so a typo there is a user action — and
 * a container that exits immediately with "PORT must be an integer" is far
 * easier to debug from a deployment log than one that binds to `NaN` and then
 * fails its health check for no stated reason.
 */
import { z } from 'zod';

const schema = z.object({
  /** ForgeCloud sets this to the project's `app_port`. */
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().min(1).default('0.0.0.0'),
  /** Shown in the dashboard header, so a demo can prove env vars arrive. */
  GREETING: z.string().default('ForgeCloud Analytics'),
  /** Fail the boot if the warm-up disagrees with the build. */
  STRICT_CHECKSUM: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  /** Seconds of artificial delay before listening. For demonstrating health checks. */
  STARTUP_DELAY_SECONDS: z.coerce.number().min(0).max(60).default(0),
  FORGE_DEPLOYMENT_ID: z.string().optional(),
  FORGE_PROJECT_ID: z.string().optional(),
  FORGE_ATTEMPT: z.string().optional(),
});

export type AppConfig = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`invalid environment:\n${issues}`);
  }
  return parsed.data;
}
