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

const checkpointIdSchema = z
  .string()
  .min(1)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/, 'Invalid Relay checkpoint ID.');

const checkpointSchema = z
  .object({
    id: checkpointIdSchema,
    createdAt: z.string().datetime(),
    path: z.string().min(1),
    label: z.string().min(1).optional(),
  })
  .refine((checkpoint) => checkpoint.path === `checkpoints/${checkpoint.id}`, {
    message: 'Checkpoint paths must match checkpoints/<checkpoint-id>.',
    path: ['path'],
  });

const blockerSchema = z.object({
  description: z.string().min(1),
  createdAt: z.string().datetime(),
});

export const handoffNoteTypeSchema = z.enum([
  'done',
  'next',
  'decision',
  'rejected',
  'blocker',
  'question',
]);
export type HandoffNoteType = z.infer<typeof handoffNoteTypeSchema>;

export const handoffNoteSchema = z
  .object({
    id: z.string().uuid(),
    type: handoffNoteTypeSchema,
    text: z.string().trim().min(1).max(500),
    reason: z.string().trim().min(1).max(500).optional(),
    createdAt: z.string().datetime(),
    resolvedAt: z.string().datetime().optional(),
    provenance: z.object({
      source: z.enum(['user', 'agent']),
      agent: z.string().trim().min(1).max(100).optional(),
      recordedBy: z.literal('relay-cli'),
    }),
    git: z.object({
      commit: z.string().min(1),
      branch: z.string().min(1),
      fingerprint: z.string().length(64),
    }),
  })
  .superRefine((note, context) => {
    if (note.provenance.source === 'agent' && !note.provenance.agent)
      context.addIssue({
        code: 'custom',
        message: 'Agent-reported notes require an agent name.',
        path: ['provenance', 'agent'],
      });
    if (note.provenance.source === 'user' && note.provenance.agent)
      context.addIssue({
        code: 'custom',
        message: 'User-reported notes cannot claim an agent name.',
        path: ['provenance', 'agent'],
      });
  });
export type HandoffNote = z.infer<typeof handoffNoteSchema>;

const operationRecordSchema = z.object({
  opId: z.string().min(1),
  at: z.string().datetime(),
  revision: z.number().int().nonnegative(),
});

export const OPERATION_LEDGER_LIMIT = 50;

export const runLeaseStatusSchema = z.enum([
  'starting',
  'running',
  'waiting',
  'stopping',
  'orphaned',
]);
export type RunLeaseStatus = z.infer<typeof runLeaseStatusSchema>;

/**
 * An explicit claim on a working tree by one provider run. Leases replace the
 * single `currentAgent`/`currentRunId` pair so several agents can run in one
 * repository, as long as their worktrees differ.
 */
const runLeaseSchema = z.object({
  runId: z.string().min(1),
  /** Set by terminal-owning hosts; absent for inherited-stdio CLI runs. */
  terminalId: z.string().min(1).optional(),
  /** Absent means the main working tree rather than a Rirei workspace. */
  workspaceId: z.string().min(1).optional(),
  /** Sanitized projection metadata; paths remain private. */
  branchLabel: z.string().min(1).optional(),
  role: z.enum(['implement', 'review', 'verify', 'investigate']).optional(),
  /** Actual working directory; the resource the one-writer invariant guards. */
  worktreePath: z.string().min(1),
  projectRoot: z.string().min(1),
  agent: z.string().min(1),
  model: z.string().min(1).optional(),
  effort: z.string().min(1).optional(),
  launchMode: z.enum(['new', 'resume', 'fork']),
  providerSessionId: z.string().min(1).optional(),
  /** Who owns the process, e.g. `cli:<pid>`. Recorded for force recovery. */
  controllerId: z.string().min(1),
  startedAt: z.string().datetime(),
  lastSeenAt: z.string().datetime(),
  status: runLeaseStatusSchema,
});
export type RunLease = z.infer<typeof runLeaseSchema>;

const agentRunSchema = z.object({
  id: z.string().min(1).optional(),
  agent: z.string().min(1),
  model: z.string().min(1).optional(),
  effort: z.string().min(1).optional(),
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime().optional(),
  exitCode: z.number().int().nullable().optional(),
  exitReason: z.string().optional(),
  launchMode: z.enum(['new', 'resume', 'fork']).optional(),
  providerSessionId: z.string().min(1).optional(),
  resumeTargetKind: z.enum(['latest', 'picker', 'id']).optional(),
  resumeTargetValue: z.string().min(1).optional(),
  parentRunId: z.string().min(1).optional(),
  terminalId: z.string().min(1).optional(),
  workspaceId: z.string().min(1).optional(),
  branchLabel: z.string().min(1).optional(),
  role: z.enum(['implement', 'review', 'verify', 'investigate']).optional(),
});

export const LATEST_STATE_SCHEMA = 4;

export const relayStateSchema = z.object({
  schemaVersion: z.literal(LATEST_STATE_SCHEMA),
  revision: z.number().int().nonnegative(),
  recentOperations: z.array(operationRecordSchema).max(OPERATION_LEDGER_LIMIT),
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
  /** Authoritative set of active run leases. */
  runs: z.array(runLeaseSchema),
  /**
   * Derived compatibility mirrors of the first active lease, maintained by
   * `src/state/leases.ts`. Existing frontends still read these; new code should
   * read `runs` instead.
   */
  currentAgent: z.string().min(1).optional(),
  currentRunId: z.string().min(1).optional(),
  agentHistory: z.array(agentRunSchema),
  decisions: z.array(decisionSchema),
  completedWork: z.array(workItemSchema),
  remainingWork: z.array(workItemSchema),
  tests: z.array(testResultSchema),
  checkpoints: z.array(checkpointSchema),
  blockers: z.array(blockerSchema),
  notes: z.array(handoffNoteSchema).max(500),
});

export type RelayState = z.infer<typeof relayStateSchema>;
