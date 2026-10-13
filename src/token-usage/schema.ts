import { z } from 'zod';

export const AgentIdSchema = z.enum([
  'claude',
  'codex',
  'gemini',
  'antigravity',
  'opencode',
]);
export type AgentId = z.infer<typeof AgentIdSchema>;

export const AgentUsageStatusSchema = z.enum([
  'available',
  'unavailable',
  'unsupported',
  'error',
]);
export type AgentUsageStatus = z.infer<typeof AgentUsageStatusSchema>;

export const ErrorCodeSchema = z.enum([
  'timed_out',
  'binary_unavailable',
  'nonzero_exit',
  'output_too_large',
  'invalid_output',
  'not_opted_in',
]);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const AgentFreshnessSchema = z.enum([
  'fresh',
  'stale',
  'missing',
  'error',
]);
export type AgentFreshness = z.infer<typeof AgentFreshnessSchema>;

export const TokenComponentsSchema = z.object({
  input: z.number().nonnegative().optional(),
  cacheCreation: z.number().nonnegative().optional(),
  cacheRead: z.number().nonnegative().optional(),
  output: z.number().nonnegative().optional(),
  reasoning: z.number().nonnegative().optional(),
});
export type TokenComponents = z.infer<typeof TokenComponentsSchema>;

const DateStringSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const ModelUsageSchema = z.object({
  model: z.string(),
  totalTokens: z.number().nonnegative(),
});
export type ModelUsage = z.infer<typeof ModelUsageSchema>;

export const DailyUsageSchema = z.object({
  date: DateStringSchema,
  totalTokens: z.number().nonnegative(),
  components: TokenComponentsSchema.optional(),
  // Per-model totals for this day, so model shares can follow the selected range.
  models: z.array(ModelUsageSchema).optional(),
});
export type DailyUsage = z.infer<typeof DailyUsageSchema>;

/**
 * Coverage of the selected range, checked at both ends.
 * - `complete`: the agent's logs reach back to the range start (or it has no
 *   activity at all). False means the Partial badge and ranking caveat apply.
 * - `dataThrough`: the local date of the last capture. Days after it were not
 *   collected yet and must not be read as zero usage.
 * - `noActivity`: no logs were found in the collection window.
 */
export const AgentCoverageSchema = z.object({
  complete: z.boolean(),
  earliestDate: z.string().nullable().optional(),
  note: z.string().optional(),
  dataThrough: DateStringSchema.optional(),
  noActivity: z.boolean().optional(),
});
export type AgentCoverage = z.infer<typeof AgentCoverageSchema>;

export const AgentUsageReportSchema = z.object({
  id: AgentIdSchema,
  name: z.string(),
  status: AgentUsageStatusSchema,
  errorCode: ErrorCodeSchema.optional(),
  errorReason: z.string().optional(),
  freshness: AgentFreshnessSchema.optional(),
  capturedAt: z.string().optional(),
  itemized: z.boolean().optional(),
  coverage: AgentCoverageSchema,
  totalTokens: z.number().nonnegative().nullable(),
  components: TokenComponentsSchema.optional(),
  // Part of totalTokens that the components do not account for.
  unitemizedTokens: z.number().nonnegative().optional(),
  daily: z.array(DailyUsageSchema),
  models: z.array(ModelUsageSchema),
  sessions: z.number().nonnegative().nullable(),
  // Sessions the agent logged without timestamps; they cannot be placed in a range.
  sessionsUntimed: z.number().nonnegative().optional(),
  // Tokens in the preceding equal-length window, so a filtered view can compare
  // only the agents it shows. shortHistory: logs don't reach that window's start.
  previous: z
    .object({
      tokens: z.number().nonnegative(),
      shortHistory: z.boolean().optional(),
    })
    .optional(),
});
export type AgentUsageReport = z.infer<typeof AgentUsageReportSchema>;

export const SessionUsageReportSchema = z.object({
  agent: AgentIdSchema,
  projectLabel: z.string(),
  models: z.array(z.string()),
  totalTokens: z.number().nonnegative(),
  // Absent when the agent does not record session times (OpenCode).
  lastActivity: z.string().optional(),
  live: z.boolean().optional(),
});
export type SessionUsageReport = z.infer<typeof SessionUsageReportSchema>;

export const TokenUsageTotalsSchema = z.object({
  totalTokens: z.number().nonnegative().nullable(),
  components: TokenComponentsSchema.optional(),
  unitemizedTokens: z.number().nonnegative().optional(),
});
export type TokenUsageTotals = z.infer<typeof TokenUsageTotalsSchema>;

export const TokenUsageComparisonSchema = z.object({
  currentTokens: z.number().nonnegative(),
  previousTokens: z.number().nonnegative(),
  percentage: z.number().nullable(),
  supported: z.boolean(),
  reason: z.string().optional(),
  previousSince: DateStringSchema.optional(),
  previousUntil: DateStringSchema.optional(),
});
export type TokenUsageComparison = z.infer<typeof TokenUsageComparisonSchema>;

export const TokenUsageReportSchema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: z.string(),
  timezone: z.string(),
  range: z.object({
    since: DateStringSchema,
    until: DateStringSchema,
    days: z.number().int().positive(),
  }),
  // Oldest capture date across available agents; days after it are not collected.
  dataThrough: DateStringSchema.optional(),
  // Fixed 13-week Monday-aligned window for the activity heatmap, independent of range.
  calendar: z
    .object({
      since: DateStringSchema,
      until: DateStringSchema,
      agents: z.array(
        z.object({
          id: AgentIdSchema,
          daily: z.array(
            z.object({
              date: DateStringSchema,
              totalTokens: z.number().nonnegative(),
            }),
          ),
        }),
      ),
    })
    .optional(),
  source: z.object({
    kind: z.literal('ccusage'),
    version: z.string(),
  }),
  agents: z.array(AgentUsageReportSchema),
  sessions: z.array(SessionUsageReportSchema),
  totals: TokenUsageTotalsSchema.nullable(),
  comparison: TokenUsageComparisonSchema.optional(),
  isPartial: z.boolean().optional(),
  missingAgents: z.array(AgentIdSchema).optional(),
});
export type TokenUsageReport = z.infer<typeof TokenUsageReportSchema>;

export interface AgentDisplayMeta {
  id: AgentId;
  name: string;
  color: string;
}

export const AGENT_REGISTRY: readonly AgentDisplayMeta[] = [
  { id: 'claude', name: 'Claude', color: '#3987e5' },
  { id: 'codex', name: 'Codex', color: '#d95926' },
  { id: 'gemini', name: 'Gemini', color: '#199e70' },
  { id: 'antigravity', name: 'Antigravity', color: '#c98500' },
  { id: 'opencode', name: 'OpenCode', color: '#d55181' },
] as const;

export const AGENT_BY_ID = Object.fromEntries(
  AGENT_REGISTRY.map((agent) => [agent.id, agent]),
) as Record<AgentId, AgentDisplayMeta>;

// ============================================================================
// Raw ccusage Output Zod Schemas (Section 2.1)
// ============================================================================

// Canonical totals are required in every reviewed ccusage shape: a missing
// total is invalid output, never zero. Components are optional and stay
// unknown when absent; the gap then shows up as a Not broken down remainder.
const TokenCount = z.number().nonnegative();

// --- Codex Shapes ---
export const RawCodexModelDailySchema = z.object({
  inputTokens: TokenCount.optional(),
  cacheCreationTokens: TokenCount.optional(),
  cacheReadTokens: TokenCount.optional(),
  outputTokens: TokenCount.optional(),
  reasoningOutputTokens: TokenCount.optional(),
  totalTokens: TokenCount,
  isFallback: z.boolean().optional(),
});
export type RawCodexModelDaily = z.infer<typeof RawCodexModelDailySchema>;

export const RawCodexDaySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  inputTokens: TokenCount.optional(),
  cacheCreationTokens: TokenCount.optional(),
  cacheReadTokens: TokenCount.optional(),
  outputTokens: TokenCount.optional(),
  reasoningOutputTokens: TokenCount.optional(),
  totalTokens: TokenCount,
  models: z.record(z.string(), RawCodexModelDailySchema).optional(),
});
export type RawCodexDay = z.infer<typeof RawCodexDaySchema>;

export const RawCodexTotalsSchema = z.object({
  inputTokens: TokenCount.optional(),
  cacheCreationTokens: TokenCount.optional(),
  cacheReadTokens: TokenCount.optional(),
  outputTokens: TokenCount.optional(),
  reasoningOutputTokens: TokenCount.optional(),
  totalTokens: TokenCount,
});

export const RawCodexDailyOutputSchema = z.object({
  daily: z.array(RawCodexDaySchema),
  totals: RawCodexTotalsSchema.optional(),
});
export type RawCodexDailyOutput = z.infer<typeof RawCodexDailyOutputSchema>;

export const RawCodexSessionItemSchema = z.object({
  sessionId: z.string(),
  sessionFile: z.string().optional(),
  directory: z.string().optional(),
  lastActivity: z.string().optional(),
  inputTokens: TokenCount.optional(),
  cacheCreationTokens: TokenCount.optional(),
  cacheReadTokens: TokenCount.optional(),
  outputTokens: TokenCount.optional(),
  reasoningOutputTokens: TokenCount.optional(),
  totalTokens: TokenCount,
  models: z.record(z.string(), RawCodexModelDailySchema).optional(),
});
export type RawCodexSessionItem = z.infer<typeof RawCodexSessionItemSchema>;

export const RawCodexSessionOutputSchema = z.object({
  sessions: z.array(RawCodexSessionItemSchema),
  totals: RawCodexTotalsSchema.optional(),
});
export type RawCodexSessionOutput = z.infer<typeof RawCodexSessionOutputSchema>;

// --- Standard Shapes (Claude, Antigravity, Gemini, OpenCode) ---
export const RawStandardModelBreakdownSchema = z.object({
  modelName: z.string(),
  inputTokens: TokenCount.optional(),
  cacheCreationTokens: TokenCount.optional(),
  cacheReadTokens: TokenCount.optional(),
  outputTokens: TokenCount.optional(),
  missingPricing: z.boolean().optional(),
});
export type RawStandardModelBreakdown = z.infer<
  typeof RawStandardModelBreakdownSchema
>;

export const RawStandardDaySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  inputTokens: TokenCount.optional(),
  cacheCreationTokens: TokenCount.optional(),
  cacheReadTokens: TokenCount.optional(),
  outputTokens: TokenCount.optional(),
  totalTokens: TokenCount,
  modelsUsed: z.array(z.string()).optional(),
  modelBreakdowns: z.array(RawStandardModelBreakdownSchema).optional(),
});
export type RawStandardDay = z.infer<typeof RawStandardDaySchema>;

export const RawStandardTotalsSchema = z.object({
  inputTokens: TokenCount.optional(),
  cacheCreationTokens: TokenCount.optional(),
  cacheReadTokens: TokenCount.optional(),
  outputTokens: TokenCount.optional(),
  totalTokens: TokenCount,
  unpricedModels: z.array(z.string()).optional(),
});

export const RawStandardDailyOutputSchema = z.object({
  daily: z.array(RawStandardDaySchema),
  totals: RawStandardTotalsSchema.optional(),
});
export type RawStandardDailyOutput = z.infer<
  typeof RawStandardDailyOutputSchema
>;

export const RawStandardSessionItemSchema = z.object({
  sessionId: z.string(),
  projectPath: z.string().optional(),
  firstActivity: z.string().optional(),
  lastActivity: z.string().optional(),
  inputTokens: TokenCount.optional(),
  cacheCreationTokens: TokenCount.optional(),
  cacheReadTokens: TokenCount.optional(),
  outputTokens: TokenCount.optional(),
  totalTokens: TokenCount,
  modelsUsed: z.array(z.string()).optional(),
  modelBreakdowns: z.array(RawStandardModelBreakdownSchema).optional(),
});
export type RawStandardSessionItem = z.infer<
  typeof RawStandardSessionItemSchema
>;

export const RawStandardSessionOutputSchema = z.object({
  sessions: z.array(RawStandardSessionItemSchema),
  totals: RawStandardTotalsSchema.optional(),
});
export type RawStandardSessionOutput = z.infer<
  typeof RawStandardSessionOutputSchema
>;

// ============================================================================
// Cache Snapshot Schemas (Section 3.7)
// ============================================================================

export const AgentCacheSnapshotSchema = z.object({
  agentId: AgentIdSchema,
  capturedAt: z.string(),
  status: AgentUsageStatusSchema,
  errorCode: ErrorCodeSchema.optional(),
  errorReason: z.string().optional(),
  coverage: AgentCoverageSchema,
  totalTokens: z.number().nonnegative().nullable(),
  components: TokenComponentsSchema.optional(),
  itemized: z.boolean().default(false),
  daily: z.array(DailyUsageSchema),
  models: z.array(ModelUsageSchema),
  sessions: z.array(SessionUsageReportSchema),
  sessionCount: z.number().nonnegative().nullable(),
});
export type AgentCacheSnapshot = z.infer<typeof AgentCacheSnapshotSchema>;

export const TokenUsageCacheSchema = z.object({
  schemaVersion: z.literal(1),
  timezone: z.string(),
  updatedAt: z.string(),
  agents: z.record(AgentIdSchema, AgentCacheSnapshotSchema.optional()),
});
export type TokenUsageCache = z.infer<typeof TokenUsageCacheSchema>;
