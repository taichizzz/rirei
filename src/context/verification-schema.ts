import { z } from 'zod';
import { snapshotIdentitySchema } from './snapshot-schema.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const verificationEnvironmentSchema = z.object({
  schemaVersion: z.literal(1),
  algorithm: z.literal('rirei-host-test-environment-v1'),
  id: hash,
  host: z.object({
    nodeVersion: z.string().max(80),
    platform: z.string().max(40),
    arch: z.string().max(40),
    executablePathDigest: hash,
  }),
  values: z
    .array(
      z.object({
        name: z.enum(['NODE_ENV', 'TZ', 'LANG', 'LC_ALL', 'CI']),
        present: z.boolean(),
        value: z.string().max(160).nullable(),
        withheld: z.boolean(),
      }),
    )
    .max(5),
  dependencyDigest: hash,
  dependencyCoverage: z.literal('manifest-only'),
  coverage: z.literal('partial'),
  unmeasured: z.array(z.string().max(80)).max(12),
});
export const verificationReceiptSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().uuid(),
    taskId: z.string().min(1).max(256),
    source: z.literal('relay-command'),
    status: z.enum(['pending', 'completed', 'interrupted']),
    command: z.object({
      text: z.string().min(1).max(4096),
      digest: hash,
      redacted: z.boolean(),
      truncated: z.boolean(),
    }),
    workingDirectory: z.string().min(1).max(8192),
    scope: z.object({
      kind: z.enum(['configured-tests', 'explicit-command']),
      label: z.string().max(160).nullable(),
    }),
    startedAt: z.iso.datetime(),
    endedAt: z.iso.datetime().optional(),
    exitCode: z.number().int().nullable().optional(),
    durationMs: z.number().finite().nonnegative().optional(),
    startSnapshot: snapshotIdentitySchema,
    endSnapshot: snapshotIdentitySchema.optional(),
    startEnvironment: verificationEnvironmentSchema,
    endEnvironment: verificationEnvironmentSchema.optional(),
    output: z.literal('not-captured'),
    hash,
  })
  .strict();
export type VerificationReceipt = z.infer<typeof verificationReceiptSchema>;
export type VerificationEnvironment = z.infer<
  typeof verificationEnvironmentSchema
>;
export const MAX_VERIFICATION_RECEIPTS = 64;
