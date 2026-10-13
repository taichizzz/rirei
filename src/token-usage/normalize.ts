import { sanitizeProjectLabel } from './privacy.js';
import {
  AGENT_REGISTRY,
  RawCodexDailyOutputSchema,
  RawCodexSessionOutputSchema,
  RawStandardDailyOutputSchema,
  RawStandardSessionOutputSchema,
  type AgentCacheSnapshot,
  type AgentCoverage,
  type AgentId,
  type AgentUsageReport,
  type DailyUsage,
  type ModelUsage,
  type SessionUsageReport,
  type TokenComponents,
  type TokenUsageCache,
  type TokenUsageReport,
  type TokenUsageTotals,
} from './schema.js';
import {
  calculateRangeWindow,
  generateDateSequence,
  getLocalToday,
  shiftDateString,
} from './timezone.js';

export { sanitizeProjectLabel };

export function compactTokens(n: number | null | undefined): string {
  if (n == null || isNaN(n)) return '—';
  if (n >= 1e9) return `${(n / 1e9).toFixed(1).replace(/\.0$/, '')}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1).replace(/\.0$/, '')}K`;
  return String(Math.round(n));
}

export function fullTokens(n: number | null | undefined): string {
  if (n == null || isNaN(n)) return '—';
  return Math.round(n).toLocaleString('en-US');
}

/**
 * Largest share of a total that may be missing from its parts while the parts
 * are still shown as a breakdown. The gap is then reported as a remainder.
 */
export const ITEMIZATION_TOLERANCE = 0.01;

/**
 * Reconciles token components against their canonical total.
 * - Parts equal the total: itemized, no remainder.
 * - Parts fall short by at most ITEMIZATION_TOLERANCE: itemized, and the gap is
 *   reported as `unitemizedTokens` (shown as "Not broken down").
 * - Parts exceed the total or fall short by more: not itemized, and the whole
 *   total is unitemized.
 */
export function reconcileComponents(
  partsSum: number,
  total: number,
): { itemized: boolean; unitemizedTokens: number } {
  if (partsSum === total) return { itemized: true, unitemizedTokens: 0 };
  if (partsSum < total && total - partsSum <= total * ITEMIZATION_TOLERANCE) {
    return { itemized: true, unitemizedTokens: total - partsSum };
  }
  return { itemized: false, unitemizedTokens: total };
}

interface RawComponentFields {
  inputTokens?: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
  outputTokens?: number;
}

/** Components ccusage reported; an absent field stays unknown, never zero. */
function componentsOf(raw: RawComponentFields): TokenComponents {
  return {
    ...(raw.inputTokens != null ? { input: raw.inputTokens } : {}),
    ...(raw.cacheCreationTokens != null
      ? { cacheCreation: raw.cacheCreationTokens }
      : {}),
    ...(raw.cacheReadTokens != null ? { cacheRead: raw.cacheReadTokens } : {}),
    ...(raw.outputTokens != null ? { output: raw.outputTokens } : {}),
  };
}

function knownSum(raw: RawComponentFields): number {
  return (
    (raw.inputTokens ?? 0) +
    (raw.cacheCreationTokens ?? 0) +
    (raw.cacheReadTokens ?? 0) +
    (raw.outputTokens ?? 0)
  );
}

function sumModelUsage(
  into: Map<string, number>,
  models: readonly ModelUsage[] | undefined,
): void {
  for (const m of models ?? []) {
    into.set(m.model, (into.get(m.model) ?? 0) + m.totalTokens);
  }
}

function modelMapToList(map: Map<string, number>): ModelUsage[] {
  return Array.from(map.entries()).map(([model, totalTokens]) => ({
    model,
    totalTokens,
  }));
}

function formatShortDate(dateStr: string): string {
  return new Date(`${dateStr}T00:00:00Z`).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * Normalizes raw ccusage daily output for a single agent.
 * Validates strictly using Zod and performs runtime arithmetic reconciliation.
 */
export function normalizeAgentDailyOutput(
  agentId: AgentId,
  raw: unknown,
): {
  daily: DailyUsage[];
  models: ModelUsage[];
  totals: {
    totalTokens: number;
    components?: TokenComponents;
    itemized: boolean;
  };
  earliestDate: string | null;
} {
  if (agentId === 'codex') {
    const parseRes = RawCodexDailyOutputSchema.safeParse(raw);
    if (!parseRes.success) {
      throw new Error('INVALID_OUTPUT');
    }
    const data = parseRes.data;
    const daily: DailyUsage[] = [];
    const modelTotals = new Map<string, number>();

    let grandInput = 0;
    let grandCacheCreation = 0;
    let grandCacheRead = 0;
    let grandOutput = 0;
    let grandReasoning: number | undefined;
    let grandTotal = 0;

    for (const day of data.daily) {
      const components = componentsOf(day);
      if (day.reasoningOutputTokens != null) {
        components.reasoning = day.reasoningOutputTokens;
        grandReasoning = (grandReasoning ?? 0) + day.reasoningOutputTokens;
      }

      const dayModels: ModelUsage[] | undefined = day.models
        ? Object.entries(day.models).map(([model, m]) => ({
            model,
            totalTokens: m.totalTokens,
          }))
        : undefined;

      daily.push({
        date: day.date,
        totalTokens: day.totalTokens,
        components,
        ...(dayModels ? { models: dayModels } : {}),
      });

      grandInput += day.inputTokens ?? 0;
      grandCacheCreation += day.cacheCreationTokens ?? 0;
      grandCacheRead += day.cacheReadTokens ?? 0;
      grandOutput += day.outputTokens ?? 0;
      grandTotal += day.totalTokens;

      sumModelUsage(modelTotals, dayModels);
    }

    // Codex canonical total from totals or daily sum
    const canonicalTotal = data.totals?.totalTokens ?? grandTotal;
    const componentsSum =
      grandInput + grandCacheCreation + grandCacheRead + grandOutput;
    const { itemized } = reconcileComponents(componentsSum, canonicalTotal);

    const models = modelMapToList(modelTotals);

    const sortedDates = daily.map((d) => d.date).sort();
    const earliestDate = sortedDates[0] ?? null;

    return {
      daily,
      models,
      totals: {
        totalTokens: canonicalTotal,
        components: {
          input: grandInput,
          cacheCreation: grandCacheCreation,
          cacheRead: grandCacheRead,
          output: grandOutput,
          ...(grandReasoning != null ? { reasoning: grandReasoning } : {}),
        },
        itemized,
      },
      earliestDate,
    };
  }

  // Standard output (Claude, Gemini, Antigravity, OpenCode)
  const parseRes = RawStandardDailyOutputSchema.safeParse(raw);
  if (!parseRes.success) {
    throw new Error('INVALID_OUTPUT');
  }

  const data = parseRes.data;
  const daily: DailyUsage[] = [];
  const modelTotals = new Map<string, number>();

  let grandInput = 0;
  let grandCacheCreation = 0;
  let grandCacheRead = 0;
  let grandOutput = 0;
  let grandTotal = 0;

  for (const day of data.daily) {
    const components = componentsOf(day);

    // Standard breakdowns carry components but no per-model total. Model totals
    // are kept only when the breakdowns reconcile with the day's total under the
    // same rule as the components; any small gap stays unattributed.
    let dayModels: ModelUsage[] | undefined;
    if (day.modelBreakdowns) {
      const perModel = day.modelBreakdowns.map((mb) => ({
        model: mb.modelName,
        totalTokens: knownSum(mb),
      }));
      const dayModelSum = perModel.reduce((acc, m) => acc + m.totalTokens, 0);
      if (reconcileComponents(dayModelSum, day.totalTokens).itemized) {
        const merged = new Map<string, number>();
        sumModelUsage(merged, perModel);
        dayModels = modelMapToList(merged);
      }
    }

    daily.push({
      date: day.date,
      totalTokens: day.totalTokens,
      components,
      ...(dayModels ? { models: dayModels } : {}),
    });

    grandInput += day.inputTokens ?? 0;
    grandCacheCreation += day.cacheCreationTokens ?? 0;
    grandCacheRead += day.cacheReadTokens ?? 0;
    grandOutput += day.outputTokens ?? 0;
    grandTotal += day.totalTokens;

    sumModelUsage(modelTotals, dayModels);
  }

  const canonicalTotal = data.totals?.totalTokens ?? grandTotal;
  const componentsSum =
    grandInput + grandCacheCreation + grandCacheRead + grandOutput;
  const { itemized } = reconcileComponents(componentsSum, canonicalTotal);

  const models = modelMapToList(modelTotals);

  const sortedDates = daily.map((d) => d.date).sort();
  const earliestDate = sortedDates[0] ?? null;

  return {
    daily,
    models,
    totals: {
      totalTokens: canonicalTotal,
      components: {
        input: grandInput,
        cacheCreation: grandCacheCreation,
        cacheRead: grandCacheRead,
        output: grandOutput,
      },
      itemized,
    },
    earliestDate,
  };
}

/**
 * Normalizes raw ccusage session output for a single agent.
 */
export function normalizeAgentSessionOutput(
  agentId: AgentId,
  raw: unknown,
): SessionUsageReport[] {
  if (agentId === 'codex') {
    const parseRes = RawCodexSessionOutputSchema.safeParse(raw);
    if (!parseRes.success) {
      throw new Error('INVALID_OUTPUT');
    }
    return parseRes.data.sessions.map((s) => {
      const models = s.models ? Object.keys(s.models) : [];
      const label = sanitizeProjectLabel(s.directory || s.sessionFile);
      return {
        agent: 'codex',
        projectLabel: label,
        models,
        totalTokens: s.totalTokens,
        ...(s.lastActivity ? { lastActivity: s.lastActivity } : {}),
      };
    });
  }

  const parseRes = RawStandardSessionOutputSchema.safeParse(raw);
  if (!parseRes.success) {
    throw new Error('INVALID_OUTPUT');
  }

  return parseRes.data.sessions.map((s) => {
    const models = s.modelsUsed || [];
    // OpenCode has no project path -> sanitized to "—"
    const label = sanitizeProjectLabel(s.projectPath);
    // OpenCode records no session times either; never invent one.
    const lastActivity = s.lastActivity || s.firstActivity;
    return {
      agent: agentId,
      projectLabel: label,
      models,
      totalTokens: s.totalTokens,
      ...(lastActivity ? { lastActivity } : {}),
    };
  });
}

/**
 * Creates an empty/error snapshot for an agent.
 */
export function createErrorSnapshot(
  agentId: AgentId,
  errorCode:
    | 'timed_out'
    | 'binary_unavailable'
    | 'nonzero_exit'
    | 'output_too_large'
    | 'invalid_output'
    | 'not_opted_in',
  errorMessage: string,
  now: Date = new Date(),
): AgentCacheSnapshot {
  return {
    agentId,
    capturedAt: now.toISOString(),
    status: 'error',
    errorCode,
    errorReason: errorMessage,
    coverage: { complete: false, earliestDate: null },
    totalTokens: null,
    itemized: false,
    daily: [],
    models: [],
    sessions: [],
    sessionCount: null,
  };
}

/**
 * Derives a full TokenUsageReport from a TokenUsageCache for a requested day range (7, 30, 90).
 * Does zero process spawning or disk scans. Coverage, models, sessions, and the
 * comparison are measured against the selected range, not the 180-day
 * collection window the cache holds.
 */
export function deriveReportFromCache(
  cache: TokenUsageCache,
  options: {
    days: number;
    timezone?: string;
    now?: Date;
    sourceVersion?: string;
  },
): TokenUsageReport {
  const now = options.now ?? new Date();
  const timezone = options.timezone || cache.timezone || 'UTC';
  const range = calculateRangeWindow(options.days, timezone, now);
  const fullDateSeq = generateDateSequence(range.since, range.until);
  const fullDateSet = new Set(fullDateSeq);
  const localDateOf = (iso: string): string | null => {
    const ms = Date.parse(iso);
    return Number.isNaN(ms) ? null : getLocalToday(timezone, new Date(ms));
  };

  // The activity heatmap always shows 13 Monday-aligned weeks ending today.
  const untilDow = new Date(`${range.until}T00:00:00Z`).getUTCDay();
  const calendarSince = shiftDateString(
    range.until,
    -(((untilDow + 6) % 7) + 7 * 12),
  );
  const calendarAgents: NonNullable<TokenUsageReport['calendar']>['agents'] =
    [];

  // Section 4.1: the preceding equal-length window, compared from cached history
  const previousUntil = shiftDateString(range.since, -1);
  const previousSince = shiftDateString(previousUntil, -(options.days - 1));
  const prevDateSet = new Set(
    generateDateSequence(previousSince, previousUntil),
  );

  const agents: AgentUsageReport[] = [];
  const allSessions: SessionUsageReport[] = [];

  let grandTotalTokens = 0;
  let hasSuccessfulAgent = false;
  let anyPartial = false;
  let dataThrough: string | undefined;
  const missingAgents: AgentId[] = [];

  let totalInput = 0;
  let totalCacheCreation = 0;
  let totalCacheRead = 0;
  let totalOutput = 0;
  let totalReasoning: number | undefined;
  let totalUnitemized = 0;

  for (const meta of AGENT_REGISTRY) {
    const snap = cache.agents[meta.id];

    if (!snap || snap.status === 'error') {
      missingAgents.push(meta.id);
      agents.push({
        id: meta.id,
        name: meta.name,
        status: snap?.status ?? 'unavailable',
        errorCode: snap?.errorCode,
        errorReason: snap?.errorReason,
        freshness: snap ? 'error' : 'missing',
        capturedAt: snap?.capturedAt,
        itemized: false,
        coverage: snap?.coverage ?? { complete: false, earliestDate: null },
        totalTokens: null,
        daily: [],
        models: [],
        sessions: null,
      });
      continue;
    }

    if (snap.status === 'available') {
      hasSuccessfulAgent = true;

      // Filter 180-day daily records to the requested range [since, until]
      const dailyInRange = snap.daily.filter((d) => fullDateSet.has(d.date));

      // Compute agent total tokens for the requested window
      const agentWindowTotal = dailyInRange.reduce(
        (sum, d) => sum + d.totalTokens,
        0,
      );
      grandTotalTokens += agentWindowTotal;

      // Sum components and model totals for the requested window
      let agentInput = 0;
      let agentCacheCreation = 0;
      let agentCacheRead = 0;
      let agentOutput = 0;
      let agentReasoning: number | undefined;
      const windowModels = new Map<string, number>();

      for (const d of dailyInRange) {
        if (d.components) {
          agentInput += d.components.input ?? 0;
          agentCacheCreation += d.components.cacheCreation ?? 0;
          agentCacheRead += d.components.cacheRead ?? 0;
          agentOutput += d.components.output ?? 0;
          if (d.components.reasoning != null) {
            agentReasoning = (agentReasoning ?? 0) + d.components.reasoning;
          }
        }
        sumModelUsage(windowModels, d.models);
      }

      // Check runtime reconciliation for this window
      const { itemized, unitemizedTokens } = reconcileComponents(
        agentInput + agentCacheCreation + agentCacheRead + agentOutput,
        agentWindowTotal,
      );
      totalUnitemized += unitemizedTokens;
      if (itemized) {
        totalInput += agentInput;
        totalCacheCreation += agentCacheCreation;
        totalCacheRead += agentCacheRead;
        totalOutput += agentOutput;
        if (agentReasoning != null) {
          totalReasoning = (totalReasoning ?? 0) + agentReasoning;
        }
      }

      // Coverage of the selected range at both ends
      const earliestDate = snap.coverage.earliestDate ?? null;
      const complete = earliestDate == null || earliestDate <= range.since;
      const agentThrough = localDateOf(snap.capturedAt) ?? undefined;
      if (!complete) anyPartial = true;
      if (agentThrough && (dataThrough == null || agentThrough < dataThrough)) {
        dataThrough = agentThrough;
      }
      const coverage: AgentCoverage = {
        complete,
        earliestDate,
        ...(complete
          ? {}
          : { note: `${meta.name} logs start ${earliestDate}` }),
        ...(agentThrough ? { dataThrough: agentThrough } : {}),
        ...(earliestDate == null ? { noActivity: true } : {}),
      };

      // Sessions active in the range. A session without a time (OpenCode), or
      // with a time after the capture (invented by older builds), can't be placed.
      let sessionsInRange = 0;
      let sessionsUntimed = 0;
      for (const s of snap.sessions) {
        const day =
          s.lastActivity && s.lastActivity <= snap.capturedAt
            ? localDateOf(s.lastActivity)
            : null;
        if (!day) {
          sessionsUntimed += 1;
        } else if (fullDateSet.has(day)) {
          sessionsInRange += 1;
          allSessions.push(s);
        }
      }

      // A failed session scan is unknown, never zero sessions.
      const sessionsKnown = snap.sessionCount != null;

      calendarAgents.push({
        id: meta.id,
        daily: snap.daily
          .filter((d) => d.date >= calendarSince && d.date <= range.until)
          .map((d) => ({ date: d.date, totalTokens: d.totalTokens })),
      });

      // Freshness calculation (fresh if captured within 10 min, stale otherwise)
      const capturedMs = Date.parse(snap.capturedAt);
      const isFresh =
        !Number.isNaN(capturedMs) &&
        now.getTime() - capturedMs < 10 * 60 * 1000;
      const freshness = isFresh ? 'fresh' : 'stale';

      agents.push({
        id: meta.id,
        name: meta.name,
        status: 'available',
        errorCode: snap.errorCode,
        errorReason: snap.errorReason,
        freshness,
        capturedAt: snap.capturedAt,
        itemized,
        ...(unitemizedTokens > 0 ? { unitemizedTokens } : {}),
        coverage,
        totalTokens: agentWindowTotal,
        components: {
          input: agentInput,
          cacheCreation: agentCacheCreation,
          cacheRead: agentCacheRead,
          output: agentOutput,
          ...(agentReasoning != null ? { reasoning: agentReasoning } : {}),
        },
        daily: dailyInRange,
        models: modelMapToList(windowModels).sort(
          (a, b) => b.totalTokens - a.totalTokens,
        ),
        sessions: sessionsKnown ? sessionsInRange : null,
        ...(sessionsKnown && sessionsUntimed > 0 ? { sessionsUntimed } : {}),
        previous: {
          tokens: snap.daily
            .filter((d) => prevDateSet.has(d.date))
            .reduce((sum, d) => sum + d.totalTokens, 0),
          ...(earliestDate != null && earliestDate > previousSince
            ? { shortHistory: true }
            : {}),
        },
      });
    } else {
      // unavailable or unsupported
      agents.push({
        id: meta.id,
        name: meta.name,
        status: snap.status,
        errorCode: snap.errorCode,
        errorReason: snap.errorReason,
        freshness: 'fresh',
        capturedAt: snap.capturedAt,
        itemized: true,
        coverage: snap.coverage,
        totalTokens: 0,
        daily: [],
        models: [],
        sessions: 0,
      });
    }
  }

  // Section 2.6: Failures are never zero. If no agent succeeds, totals are null.
  let totals: TokenUsageTotals | null = null;
  if (hasSuccessfulAgent) {
    totals = {
      totalTokens: grandTotalTokens,
      components: {
        input: totalInput,
        cacheCreation: totalCacheCreation,
        cacheRead: totalCacheRead,
        output: totalOutput,
        ...(totalReasoning != null ? { reasoning: totalReasoning } : {}),
      },
      ...(totalUnitemized > 0 ? { unitemizedTokens: totalUnitemized } : {}),
    };
  }

  // Days after the oldest capture were not collected yet.
  const staleEnd = dataThrough != null && dataThrough < range.until;

  let comparisonReason: string | undefined;
  let previousTotalTokens = 0;

  if (!hasSuccessfulAgent) {
    comparisonReason = 'No agent data available';
  } else {
    const unavailable: string[] = [];
    const shortHistory: string[] = [];
    for (const meta of AGENT_REGISTRY) {
      const snap = cache.agents[meta.id];
      if (!snap || snap.status !== 'available') {
        unavailable.push(meta.name);
        continue;
      }
      const earliest = snap.coverage.earliestDate;
      if (earliest && earliest > previousSince) {
        shortHistory.push(meta.name);
      }
      previousTotalTokens += snap.daily
        .filter((d) => prevDateSet.has(d.date))
        .reduce((sum, d) => sum + d.totalTokens, 0);
    }
    if (unavailable.length > 0) {
      comparisonReason = `No comparison — ${joinNames(unavailable)} data ${
        unavailable.length === 1 ? 'is' : 'are'
      } unavailable`;
    } else if (staleEnd && dataThrough) {
      comparisonReason = `No comparison — data only through ${formatShortDate(dataThrough)}`;
    } else if (shortHistory.length > 0) {
      comparisonReason = `No comparison — ${joinNames(shortHistory)} logs don’t reach back to ${formatShortDate(previousSince)}`;
    }
  }
  const comparisonSupported = comparisonReason == null;

  const comparison = {
    currentTokens: grandTotalTokens,
    previousTokens: previousTotalTokens,
    percentage:
      comparisonSupported && previousTotalTokens > 0
        ? Math.round(
            ((grandTotalTokens - previousTotalTokens) / previousTotalTokens) *
              100,
          )
        : null,
    supported: comparisonSupported,
    reason: comparisonReason,
    previousSince,
    previousUntil,
  };

  const isPartial = missingAgents.length > 0 || anyPartial || staleEnd;

  // Sort sessions descending by lastActivity
  allSessions.sort((a, b) =>
    (b.lastActivity ?? '').localeCompare(a.lastActivity ?? ''),
  );

  return {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    timezone,
    range,
    ...(dataThrough ? { dataThrough } : {}),
    calendar: {
      since: calendarSince,
      until: range.until,
      agents: calendarAgents,
    },
    source: {
      kind: 'ccusage',
      version: options.sourceVersion ?? '20.0.24',
    },
    agents,
    sessions: allSessions.slice(0, 100),
    totals,
    comparison,
    isPartial,
    missingAgents: missingAgents.length > 0 ? missingAgents : undefined,
  };
}
