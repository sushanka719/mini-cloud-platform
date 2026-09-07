import { z } from 'zod';

export const dependencyHealthSchema = z.object({
  ok: z.boolean(),
  latencyMs: z.number().int().nonnegative(),
  error: z.string().optional(),
});
export type DependencyHealth = z.infer<typeof dependencyHealthSchema>;

export const healthResponseSchema = z.object({
  ok: z.boolean(),
  service: z.string(),
  version: z.string(),
  uptimeMs: z.number().int().nonnegative(),
  checks: z.object({
    postgres: dependencyHealthSchema,
    redis: dependencyHealthSchema,
  }),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;

export const errorResponseSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
  requestId: z.string().optional(),
});
export type ErrorResponse = z.infer<typeof errorResponseSchema>;
