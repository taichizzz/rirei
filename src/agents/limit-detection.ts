import type {
  AgentAdapter,
  AgentId,
  ProviderObservation,
  ProviderUsageSnapshot,
  UsageCollectionContext,
  UsageMetric,
} from './adapter.js';
import { PLAN_USAGE_STALE_MS } from './usage-collectors.js';

export interface LimitEvidence {
  observation: ProviderObservation & { kind: 'usage_limit' | 'rate_limit' };
  retryAt?: string;
  confidence: 'medium' | 'high';
  source: 'usage_sample' | 'provider_event';
}

export interface PreflightLimitWarning {
  adapterId: AgentId;
  metric: UsageMetric;
  retryAt?: string;
  message: string;
}

export function isQuotaExhausted(metric: UsageMetric): boolean {
  if (metric.kind !== 'quota') return false;
  if (metric.status === 'stale') return false;
  if (metric.remaining === 0) return true;
  if (
    metric.limit !== undefined &&
    metric.used !== undefined &&
    metric.used >= metric.limit
  )
    return true;
  if (
    metric.unit === 'percent' &&
    metric.remaining !== undefined &&
    metric.remaining <= 1
  )
    return true;
  if (
    metric.unit === 'percent' &&
    metric.used !== undefined &&
    metric.used >= 99
  )
    return true;
  return false;
}

export async function checkPreflightLimit(
  adapter: AgentAdapter,
  context: UsageCollectionContext,
): Promise<PreflightLimitWarning | null> {
  if (typeof adapter.readUsage !== 'function') return null;

  let snapshots: ProviderUsageSnapshot[];
  try {
    snapshots = await adapter.readUsage(context);
  } catch {
    return null;
  }

  if (!Array.isArray(snapshots) || snapshots.length === 0) return null;

  const staleWindow = context.staleAfterMs ?? PLAN_USAGE_STALE_MS;
  const now = context.now ? context.now.getTime() : Date.now();

  for (const snapshot of snapshots) {
    if (snapshot.status !== 'available' || !snapshot.capturedAt) continue;

    const captured = Date.parse(snapshot.capturedAt);
    if (!Number.isFinite(captured)) continue;
    if (Math.abs(now - captured) > staleWindow) continue;

    const exhaustedMetrics = (snapshot.metrics ?? []).filter(isQuotaExhausted);
    if (exhaustedMetrics.length === 0) continue;

    const candidateMetrics = exhaustedMetrics.some(
      (m) =>
        m.window?.durationSeconds === undefined ||
        m.window.durationSeconds >= 3600,
    )
      ? exhaustedMetrics.filter(
          (m) =>
            m.window?.durationSeconds === undefined ||
            m.window.durationSeconds >= 3600,
        )
      : exhaustedMetrics;

    const futureResets = candidateMetrics
      .map((m) => m.resetsAt)
      .filter((reset): reset is string => {
        if (!reset) return false;
        const resetTime = Date.parse(reset);
        return Number.isFinite(resetTime) && resetTime > now;
      })
      .sort((a, b) => Date.parse(a) - Date.parse(b));

    const retryAt = futureResets[0];
    const metric =
      (retryAt
        ? candidateMetrics.find((m) => m.resetsAt === retryAt)
        : undefined) ?? candidateMetrics[0];

    if (!metric) return null;

    const resetText = formatLocalReset(retryAt);
    const resetPart = resetText ? ` until ${resetText}` : '';
    const remaining =
      metric.remaining ??
      (metric.unit === 'percent' && metric.used !== undefined
        ? Math.max(0, 100 - metric.used)
        : 0);
    const remainingText =
      metric.unit === 'percent' || metric.remaining !== undefined
        ? `${remaining}% remaining`
        : '0% remaining';

    const message = `${adapter.displayName} reports ${remainingText}${resetPart}.`;

    return {
      adapterId: adapter.id,
      metric,
      ...(retryAt ? { retryAt } : {}),
      message,
    };
  }

  return null;
}

export async function detectLimitEvidence(
  adapter: AgentAdapter,
  context: UsageCollectionContext,
  run: { startedAt: string; endedAt: string; exitCode: number | null },
): Promise<LimitEvidence | null> {
  if (typeof adapter.readUsage !== 'function') return null;
  if (run.exitCode === 0) return null;

  let snapshots: ProviderUsageSnapshot[];
  try {
    snapshots = await adapter.readUsage(context);
  } catch {
    return null;
  }

  if (!Array.isArray(snapshots) || snapshots.length === 0) return null;

  const start = Date.parse(run.startedAt);
  const end = Date.parse(run.endedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;

  const staleWindow = context.staleAfterMs ?? PLAN_USAGE_STALE_MS;
  const referenceTime = context.now ? context.now.getTime() : end;

  for (const snapshot of snapshots) {
    if (snapshot.status !== 'available' || !snapshot.capturedAt) continue;

    const captured = Date.parse(snapshot.capturedAt);
    if (!Number.isFinite(captured)) continue;
    if (captured < start) continue;
    if (Math.abs(end - captured) > staleWindow) continue;

    const exhaustedMetrics = (snapshot.metrics ?? []).filter(isQuotaExhausted);
    if (exhaustedMetrics.length === 0) continue;

    const hasPlanWindow = exhaustedMetrics.some(
      (m) =>
        m.window?.durationSeconds === undefined ||
        m.window.durationSeconds >= 3600,
    );
    const isRateLimit = !hasPlanWindow;
    const kind = isRateLimit ? 'rate_limit' : 'usage_limit';
    const detail = isRateLimit ? 'rate_limited' : 'quota_exhausted';

    const candidateMetrics = isRateLimit
      ? exhaustedMetrics
      : exhaustedMetrics.filter(
          (m) =>
            m.window?.durationSeconds === undefined ||
            m.window.durationSeconds >= 3600,
        );

    let retryAt: string | undefined;
    const futureResets = candidateMetrics
      .map((m) => m.resetsAt)
      .filter((reset): reset is string => {
        if (!reset) return false;
        const resetTime = Date.parse(reset);
        return Number.isFinite(resetTime) && resetTime > referenceTime;
      })
      .sort((a, b) => Date.parse(a) - Date.parse(b));

    if (futureResets.length > 0) {
      retryAt = futureResets[0];
    }

    return {
      observation: {
        kind,
        detail,
        confidence: 'medium',
      },
      ...(retryAt ? { retryAt } : {}),
      confidence: 'medium',
      source: 'usage_sample',
    };
  }

  return null;
}

export function formatLocalReset(
  retryAt?: string,
  options?: { locale?: string; timeZone?: string },
): string | null {
  if (!retryAt) return null;
  const value = new Date(retryAt);
  if (Number.isNaN(value.getTime())) return null;
  return new Intl.DateTimeFormat(options?.locale, {
    hour: 'numeric',
    minute: '2-digit',
    ...(options?.timeZone ? { timeZone: options.timeZone } : {}),
  }).format(value);
}

export function displayExitReason(
  reason?: string,
  retryAt?: string,
  options?: { locale?: string; timeZone?: string },
): string {
  if (!reason) return 'Result unknown';
  let base: string;
  if (reason === 'usage_limit') {
    base = 'Usage limit reached';
  } else if (reason === 'rate_limit') {
    base = 'Rate limited';
  } else {
    base = reason
      .split('_')
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  }
  if (retryAt) {
    const local = formatLocalReset(retryAt, options);
    if (local) return `${base} (until ${local})`;
  }
  return base;
}
