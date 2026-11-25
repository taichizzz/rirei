import { z } from 'zod';

export const snapshotIdentitySchema = z.object({
  schemaVersion: z.literal(1),
  algorithm: z.literal('rirei-covered-inputs-v1'),
  id: z.string().regex(/^[a-f0-9]{64}$/),
  workspaceId: z.string().regex(/^[a-f0-9]{64}$/),
  head: z.string().max(128),
  indexDigest: z.string().regex(/^[a-f0-9]{64}$/),
  headTreeDigest: z.string().regex(/^[a-f0-9]{64}$/),
  worktreeDigest: z.string().regex(/^[a-f0-9]{64}$/),
  dependencyDigest: z.string().regex(/^[a-f0-9]{64}$/),
  coverage: z.object({
    status: z.enum(['complete', 'partial', 'unstable', 'unavailable']),
    scope: z.literal('tracked-and-nonignored-untracked'),
    ignoredInputs: z.literal('not-covered'),
    filesConsidered: z.number().int().nonnegative(),
    filesHashed: z.number().int().nonnegative(),
    bytesRead: z.number().int().nonnegative(),
    reasons: z.array(z.string().max(80)).max(24),
  }),
});
export type SnapshotIdentity = z.infer<typeof snapshotIdentitySchema>;
