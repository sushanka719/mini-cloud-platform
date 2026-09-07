import { z } from 'zod';
import { fileCompressionSchema, fileKindSchema } from './enums.js';
import { nameSchema, slugSchema } from './auth.js';
import { isRunnableCommand } from './commands.js';

/** Where a project's source comes from. Git intake lands after Phase 2. */
export const SOURCE_TYPES = ['upload', 'git'] as const;
export const sourceTypeSchema = z.enum(SOURCE_TYPES);
export type SourceType = z.infer<typeof sourceTypeSchema>;

/**
 * Build/start commands are executed with `spawn(cmd, args, { shell: false })`,
 * so shell metacharacters can never reach a shell. We still reject them here:
 * a command containing them is almost certainly a mistake or an attack, and
 * failing at write time is far clearer than failing mid-build (CLAUDE.md §8).
 */
const SHELL_METACHARACTERS = /[;&|`$><\n\r\\]/;

export const commandSchema = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .refine((v) => !SHELL_METACHARACTERS.test(v), {
    message: 'Commands run without a shell; ; & | ` $ > < and backslashes are not allowed',
  })
  // The worker tokenises this into `spawn(file, args)`. Checking here that it
  // *can* be tokenised means an unbalanced quote is a 400 on the settings form
  // rather than a failed deployment ten minutes later.
  .refine(isRunnableCommand, {
    message: 'Could not be parsed into a program and arguments (check the quoting)',
  });

/**
 * Relative directory inside the uploaded source. Absolute paths and `..`
 * segments are rejected here as well as at use time (defence in depth).
 */
export const relativeDirSchema = z
  .string()
  .trim()
  .max(200)
  .default('.')
  .refine((v) => v === '.' || !/^([/\\]|[a-zA-Z]:)/.test(v), {
    message: 'Must be a relative path inside the project',
  })
  .refine((v) => !v.split(/[/\\]/).includes('..'), {
    message: 'Path traversal is not allowed',
  });

export const healthPathSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .startsWith('/', 'Health path must start with /');

export const projectSchema = z.object({
  id: z.string().uuid(),
  orgId: z.string().uuid(),
  name: z.string(),
  slug: z.string(),
  sourceType: sourceTypeSchema,
  repoUrl: z.string().nullable(),
  rootDir: z.string(),
  installCommand: z.string(),
  buildCommand: z.string(),
  startCommand: z.string(),
  appPort: z.number().int(),
  healthPath: z.string(),
  healthTimeoutMs: z.number().int(),
  activeDeploymentId: z.string().uuid().nullable(),
  createdBy: z.string().uuid(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Project = z.infer<typeof projectSchema>;

export const createProjectSchema = z.object({
  name: nameSchema,
  slug: slugSchema.optional(),
  sourceType: sourceTypeSchema.default('upload'),
  repoUrl: z.string().url().max(500).nullish(),
  rootDir: relativeDirSchema.optional(),
  installCommand: commandSchema.default('npm install'),
  buildCommand: commandSchema.default('npm run build'),
  startCommand: commandSchema.default('npm start'),
  appPort: z.coerce.number().int().min(1).max(65535).default(3000),
  healthPath: healthPathSchema.default('/'),
  healthTimeoutMs: z.coerce.number().int().min(1_000).max(300_000).default(30_000),
});
export type CreateProjectInput = z.infer<typeof createProjectSchema>;

export const updateProjectSchema = createProjectSchema
  .partial()
  // Slug and source type are identity-ish; changing them mid-flight would
  // orphan stored source under the old path, so they are create-only.
  .omit({ slug: true, sourceType: true })
  .refine((v) => Object.keys(v).length > 0, { message: 'Provide at least one field to update' });
export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;

// --- Env vars ---------------------------------------------------------------

/** POSIX-ish env var name. Rejects anything that couldn't be exported safely. */
export const envVarKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'Use letters, digits and underscores; cannot start with a digit');

export const envVarValueSchema = z.string().max(32_768);

/**
 * What the API returns for an env var. `value` is present only when
 * `isSecret` is false — a secret's plaintext never leaves the database
 * except into a build container (CLAUDE.md §8).
 */
export const envVarSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  key: z.string(),
  isSecret: z.boolean(),
  value: z.string().nullable(),
  /** Always safe to show: length of the plaintext, never the plaintext itself. */
  valueLength: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type EnvVar = z.infer<typeof envVarSchema>;

export const upsertEnvVarSchema = z.object({
  key: envVarKeySchema,
  value: envVarValueSchema,
  isSecret: z.boolean().default(true),
});
export type UpsertEnvVarInput = z.infer<typeof upsertEnvVarSchema>;

/** Bulk paste of a `.env` block, so the dashboard can accept one textarea. */
export const bulkEnvVarsSchema = z.object({
  vars: z.array(upsertEnvVarSchema).min(1).max(200),
});
export type BulkEnvVarsInput = z.infer<typeof bulkEnvVarsSchema>;

// --- Files (local object store index) ---------------------------------------

export const storedFileSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid().nullable(),
  deploymentId: z.string().uuid().nullable(),
  kind: fileKindSchema,
  /** Object key inside the store — `<orgId>/<projectId>/sources/<uuid>.zip`. */
  storagePath: z.string(),
  /** Size of the bytes as stored (compressed, when `compression` is set). */
  sizeBytes: z.number().int().nonnegative(),
  /** sha256 of the bytes as stored. */
  checksum: z.string().nullable(),
  contentType: z.string().nullable(),
  originalName: z.string().nullable(),
  /** The source object an artifact was produced from. */
  parentFileId: z.string().uuid().nullable(),
  compression: fileCompressionSchema.nullable(),
  /** Set only for a compressed object: what it weighs / hashes to unpacked. */
  uncompressedBytes: z.number().int().nonnegative().nullable(),
  uncompressedChecksum: z.string().nullable(),
  createdAt: z.string(),
});
export type StoredFile = z.infer<typeof storedFileSchema>;

/** Result of compressing a stored object on a worker thread. */
export const artifactResultSchema = z.object({
  file: storedFileSchema,
  /** storedBytes / originalBytes — 0.24 means "24% of the original". */
  ratio: z.number(),
  /** Wall-clock time spent inside the worker thread. */
  durationMs: z.number().int().nonnegative(),
  /** Which `worker_threads` thread did the gzip. */
  threadId: z.number().int(),
});
export type ArtifactResult = z.infer<typeof artifactResultSchema>;

/**
 * What the object store actually holds for a project, walked from disk rather
 * than summed from the DB — so objects on disk with no `files` row (orphans
 * from a crash) are visible instead of invisible.
 */
export const storageUsageSchema = z.object({
  objectCount: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
  byKind: z.record(z.string(), z.object({
    objectCount: z.number().int().nonnegative(),
    totalBytes: z.number().int().nonnegative(),
  })),
  /** Objects on disk with no `files` row. */
  orphanCount: z.number().int().nonnegative(),
  orphanBytes: z.number().int().nonnegative(),
  /** `files` rows whose object is gone from disk. */
  missingCount: z.number().int().nonnegative(),
  compression: z.object({
    threads: z.number().int().nonnegative(),
    busy: z.number().int().nonnegative(),
    queued: z.number().int().nonnegative(),
    poolSize: z.number().int().nonnegative(),
  }),
});
export type StorageUsage = z.infer<typeof storageUsageSchema>;

export const fileListQuerySchema = z.object({
  kind: fileKindSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type FileListQuery = z.infer<typeof fileListQuerySchema>;
