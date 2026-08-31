import { homedir } from 'node:os';
import path from 'node:path';
import {
  type AgentId,
  type ProviderUsageSnapshot,
  type UsageMetric,
} from './agents/adapter.js';
import { getAgent, registeredAgents } from './agents/registry.js';
import { readCodexUsageRaw } from './agents/usage-collectors.js';

export type PlanWindowStatus = 'available' | 'stale';
export type PlanWindowStatusReason =
  'live' | 'invalid_capture' | 'sample_stale' | 'window_expired';

export interface PlanWindow {
  usedPercentage: number;
  remainingPercentage: number;
  resetsAt: string | null;
  status?: PlanWindowStatus;
  statusReason?: PlanWindowStatusReason;
}

export type ProviderPlanStatusReason =
  | 'live_window'
  | 'all_windows_stale'
  | 'not_collected'
  | 'unsupported_auth'
  | 'unsupported_provider'
  | 'collector_error';

export interface ProviderPlanUsage {
  id: AgentId;
  displayName: string;
  status: 'available' | 'stale' | 'unknown' | 'unsupported' | 'error';
  statusReason: ProviderPlanStatusReason;
  source: string;
  capturedAt: string | null;
  metrics: UsageMetric[];
  fiveHour?: PlanWindow;
  week?: PlanWindow;
  detail: string;
}

export interface ProviderUsagePathOptions {
  home?: string;
  claudeUsagePath?: string;
}

export interface ReadProviderPlanUsageOptions extends ProviderUsagePathOptions {
  codexHome?: string;
  now?: Date;
  staleAfterMs?: number;
}

export {
  PLAN_USAGE_STALE_MS,
  CLAUDE_USAGE_INPUT_MAX_BYTES,
  CODEX_ROLLOUT_FILE_LIMIT,
  CODEX_ROLLOUT_TAIL_MAX_BYTES,
  claudeProviderUsagePath,
} from './agents/usage-collectors.js';

function planWindowFromMetric(
  metric: UsageMetric | undefined,
): PlanWindow | undefined {
  if (!metric || metric.used === undefined) return undefined;
  return {
    usedPercentage: metric.used,
    remainingPercentage: metric.remaining ?? 100 - metric.used,
    resetsAt: metric.resetsAt ?? null,
    status: metric.status,
    statusReason: metric.statusReason,
  };
}

const FALLBACK_DETAILS: Record<AgentId, string> = {
  claude: 'Start Claude and send one prompt to populate plan usage.',
  codex: 'Run Codex once; it records rate limits in its session telemetry.',
  gemini: 'Gemini plan usage depends on authentication method.',
  antigravity: 'Antigravity has no verified machine-readable quota interface.',
  opencode: 'OpenCode has no verified machine-readable quota interface.',
};

const FALLBACK_REASONS: Record<AgentId, ProviderPlanStatusReason> = {
  claude: 'not_collected',
  codex: 'not_collected',
  gemini: 'unsupported_auth',
  antigravity: 'unsupported_provider',
  opencode: 'unsupported_provider',
};

export async function prepareProviderUsage(
  projectRoot: string,
  agent: AgentId,
  options: ProviderUsagePathOptions = {},
): Promise<string | undefined> {
  const adapter = getAgent(agent);
  if (!adapter.prepareUsageCollection) return undefined;
  const preparation = await adapter.prepareUsageCollection({
    projectRoot,
    home: options.home,
    claudeUsagePath: options.claudeUsagePath,
  });
  return preparation.providerSettingsPath;
}

export interface CodexPlanUsage {
  capturedAt: string;
  planType: string | null;
  fiveHour?: PlanWindow;
  week?: PlanWindow;
}

/**
 * Read only recent, bounded Codex CLI telemetry tails and map recognized
 * window durations (300m => five-hour, 10080m => weekly) to plan windows.
 */
export async function readCodexPlanUsage(
  codexHome = process.env.CODEX_HOME || path.join(homedir(), '.codex'),
): Promise<CodexPlanUsage | null> {
  const record = await readCodexUsageRaw({
    projectRoot: process.cwd(),
    codexHome,
  });
  if (!record) return null;
  const result: CodexPlanUsage = {
    capturedAt: record.capturedAt,
    planType: record.planType,
  };
  for (const window of record.windows) {
    if (window.minutes === 300) {
      result.fiveHour = {
        usedPercentage: window.usedPercent,
        remainingPercentage: 100 - window.usedPercent,
        resetsAt: window.resetsAt ?? null,
      };
    } else if (window.minutes === 10080) {
      result.week = {
        usedPercentage: window.usedPercent,
        remainingPercentage: 100 - window.usedPercent,
        resetsAt: window.resetsAt ?? null,
      };
    }
  }
  if (!result.fiveHour && !result.week) return null;
  return result;
}

export async function readProviderPlanUsage(
  projectRoot: string,
  options: ReadProviderPlanUsageOptions = {},
): Promise<ProviderPlanUsage[]> {
  const context = {
    projectRoot,
    home: options.home,
    codexHome: options.codexHome,
    claudeUsagePath: options.claudeUsagePath,
    now: options.now,
    staleAfterMs: options.staleAfterMs,
  };
  const agents = registeredAgents();
  const collected = new Map<AgentId, ProviderUsageSnapshot[]>();
  await Promise.all(
    agents.map(async (agent) => {
      if (!agent.readUsage) return;
      const snapshots = await agent.readUsage(context).catch(() => [
        {
          adapterId: agent.id,
          status: 'error' as const,
          capturedAt: null,
          source: `${agent.displayName} usage reader`,
          metrics: [],
          detail: 'Provider usage could not be read safely.',
        },
      ]);
      collected.set(agent.id, snapshots);
    }),
  );
  return registeredAgents().map((agent) => {
    const snapshots = collected.get(agent.id);
    const snapshot =
      snapshots && snapshots.length > 0 ? snapshots[0] : undefined;
    if (!snapshot || snapshot.metrics.length === 0) {
      return {
        id: agent.id,
        displayName: agent.displayName,
        status:
          snapshot?.status === 'unsupported'
            ? 'unsupported'
            : snapshot?.status === 'error'
              ? 'error'
              : 'unknown',
        statusReason:
          snapshot?.status === 'error'
            ? 'collector_error'
            : FALLBACK_REASONS[agent.id],
        source: snapshot?.source ?? 'Unavailable',
        capturedAt: snapshot?.capturedAt ?? null,
        metrics: [],
        detail: snapshot?.detail ?? FALLBACK_DETAILS[agent.id],
      };
    }
    const metrics = snapshot.metrics;
    const fiveHour = planWindowFromMetric(
      metrics.find((metric) => metric.id === 'fiveHour'),
    );
    const week = planWindowFromMetric(
      metrics.find((metric) => metric.id === 'week'),
    );
    const available =
      snapshot.status === 'available' ||
      metrics.some((metric) => metric.status === 'available');
    return {
      id: agent.id,
      displayName: agent.displayName,
      status: available ? 'available' : 'stale',
      statusReason: available ? 'live_window' : 'all_windows_stale',
      source: snapshot.source,
      capturedAt: snapshot.capturedAt,
      metrics,
      fiveHour,
      week,
      detail:
        snapshot.detail ??
        (available
          ? 'Official provider usage fields.'
          : 'Provider usage is available but currently stale.'),
    };
  });
}
