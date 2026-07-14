import { z } from 'zod';

const workItemSchema = z.object({
  description: z.string().min(1),
  updatedAt: z.string().datetime(),
});

const decisionSchema = z.object({
  summary: z.string().min(1),
  rationale: z.string().optional(),
  createdAt: z.string().datetime(),
});

const testResultSchema = z.object({
  command: z.string().min(1),
  status: z.enum(['passed', 'failed', 'skipped']),
  exitCode: z.number().int().nullable(),
  durationMs: z.number().nonnegative(),
  summary: z.string().optional(),
  createdAt: z.string().datetime(),
});

const checkpointSchema = z.object({
  id: z.string().min(1),
  createdAt: z.string().datetime(),
  path: z.string().min(1),
});

const blockerSchema = z.object({
  description: z.string().min(1),
  createdAt: z.string().datetime(),
});

const agentRunSchema = z.object({
  id: z.string().min(1).optional(),
  agent: z.string().min(1),
  model: z.string().min(1).optional(),
  effort: z.string().min(1).optional(),
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime().optional(),
  exitCode: z.number().int().nullable().optional(),
  exitReason: z.string().optional(),
});

export const relayStateSchema = z.object({
  schemaVersion: z.literal(1),
  sessionId: z.string().min(1),
  projectRoot: z.string().min(1),
  task: z.object({
    title: z.string().min(1),
    originalRequest: z.string().min(1),
    requirements: z.array(z.string()),
    constraints: z.array(z.string()),
    status: z.enum(['active', 'blocked', 'completed', 'cancelled']),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  }),
  git: z.object({
    startingCommit: z.string().min(1),
    currentCommit: z.string().min(1).optional(),
    startingBranch: z.string().min(1),
    currentBranch: z.string().min(1).optional(),
    dirtyAtStart: z.boolean(),
  }),
  currentAgent: z.string().min(1).optional(),
  agentHistory: z.array(agentRunSchema),
  decisions: z.array(decisionSchema),
  completedWork: z.array(workItemSchema),
  remainingWork: z.array(workItemSchema),
  tests: z.array(testResultSchema),
  checkpoints: z.array(checkpointSchema),
  blockers: z.array(blockerSchema),
});

export type RelayState = z.infer<typeof relayStateSchema>;
