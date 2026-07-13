import { z } from 'zod';

export const configSchema = z.object({
  schemaVersion: z.literal(1),
  handoff: z.object({
    maxCharacters: z.number().int().positive().default(24_000),
    maxChangedFiles: z.number().int().positive().default(100),
    maxErrorLines: z.number().int().positive().default(200),
    includeFullDiff: z.boolean().default(false),
  }),
  checkpoint: z.object({
    maxPatchBytes: z.number().int().positive().default(1_000_000),
    maxTestOutputBytes: z.number().int().positive().default(200_000),
    maxCount: z.number().int().positive().default(20),
  }),
  tests: z.object({
    command: z.string().min(1).optional(),
    timeoutSeconds: z.number().int().positive().default(600),
    captureOutput: z.boolean().default(true),
    maxStoredOutputBytes: z.number().int().positive().default(200_000),
  }),
});

export type RelayConfig = z.infer<typeof configSchema>;

export const defaultConfig: RelayConfig = configSchema.parse({
  schemaVersion: 1,
  handoff: {
    maxCharacters: 24_000,
    maxChangedFiles: 100,
    maxErrorLines: 200,
    includeFullDiff: false,
  },
  checkpoint: {
    maxPatchBytes: 1_000_000,
    maxTestOutputBytes: 200_000,
    maxCount: 20,
  },
  tests: {
    timeoutSeconds: 600,
    captureOutput: true,
    maxStoredOutputBytes: 200_000,
  },
});
