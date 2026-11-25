import { z } from 'zod';

export const CONTEXT_INPUT_LIMIT = 256 * 1024;
export const CONTEXT_TEXT_LIMIT = 16_000;
export const CONTEXT_JOURNAL_LIMIT = 4 * 1024 * 1024;
export const CONTEXT_EVENT_LIMIT = 2_000;
export const CONTEXT_PROMPT_LIMIT = 6_000;

export const contextObservationSchema = z.object({
  kind: z.enum([
    'session_start',
    'prompt_submission',
    'launch_prompt',
    'tool_start',
    'tool_result',
    'assistant_claim',
    'turn_end',
    'session_end',
    'coverage_gap',
  ]),
  provider: z.enum(['claude', 'codex']),
  providerSessionId: z.string().min(1).max(256),
  hook: z.string().min(1).max(100),
  sourceId: z.string().max(256).optional(),
  toolId: z.string().max(256).optional(),
  toolName: z.string().max(200).optional(),
  command: z.string().max(CONTEXT_TEXT_LIMIT).optional(),
  filePath: z.string().max(CONTEXT_TEXT_LIMIT).optional(),
  text: z.string().max(CONTEXT_TEXT_LIMIT),
  outcome: z
    .enum(['reported_success', 'reported_failure', 'unknown'])
    .optional(),
  exitCode: z.number().int().nullable().optional(),
  redacted: z.boolean(),
  truncated: z.boolean(),
});

export const contextEventSchema = contextObservationSchema
  .extend({
    schemaVersion: z.literal(1),
    id: z.string().regex(/^e-[a-f0-9]{32}$/),
    sequence: z.number().int().positive(),
    receivedAt: z.iso.datetime(),
    taskId: z.string().min(1).max(256),
    runId: z.string().min(1).max(256),
    workspace: z.string().regex(/^[a-f0-9]{64}$/),
    launchGitFingerprint: z.string(),
    previousHash: z.string().regex(/^[a-f0-9]{64}$/),
    hash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export type ContextObservation = z.infer<typeof contextObservationSchema>;
export type ContextEvent = z.infer<typeof contextEventSchema>;
export interface ContextJournal {
  events: ContextEvent[];
  incompleteTail: boolean;
  digest: string;
}
/** Presentation of already-selected evidence; never changes selection or source ranges. */
export interface EvidencePresentation {
  preamble: string[];
  workspace?: string;
  submissions: string[];
  evidence: string[];
  runtime: string[];
}
export interface ContinuityContext {
  digest: string;
  eventCount: number;
  useful: boolean;
  omittedEvents: number;
  omittedStateItems?: number;
  presentation?: EvidencePresentation;
  warnings: string[];
  text: string;
  selectedEvidence?: Array<{
    eventId: string;
    start: number;
    end: number;
    text: string;
  }>;
  partialEvents?: string[];
  submissionCoverage?: {
    retained: number;
    fullyInlined: number;
    requiredSourceIds: string[];
    truncatedSourceIds: string[];
    redactedSourceIds: string[];
  };
}
