import { registeredAgents } from './agents/registry.js';
import type { RelayState } from './state/schema.js';

export interface AgentUsage {
  id: string;
  displayName: string;
  runs: number;
  activeNow: boolean;
  lastRunAt: string | null;
  lastReason: string | null;
  totalMs: number;
  fiveHours: UsageWindow;
  week: UsageWindow;
}

export interface UsageWindow {
  runs: number;
  totalMs: number;
}

export interface UsageSummary {
  generatedAt: string;
  task: { title: string; status: string };
  checkpoints: number;
  fiveHours: UsageWindow;
  week: UsageWindow;
  agents: AgentUsage[];
}

function windowUsage(
  runs: RelayState['agentHistory'],
  since: number,
  now: number,
): UsageWindow {
  let count = 0;
  let totalMs = 0;
  for (const run of runs) {
    const start = Date.parse(run.startedAt);
    const end = run.endedAt ? Date.parse(run.endedAt) : now;
    if (
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      end <= since ||
      start > now
    )
      continue;
    count += 1;
    totalMs += Math.max(0, Math.min(end, now) - Math.max(start, since));
  }
  return { runs: count, totalMs };
}

/**
 * Summarize how much each registered agent has been used during the current
 * task, derived entirely from Relay's own observations in `agentHistory`
 * (run counts, durations, last exit reason). This never inspects provider
 * credentials, quotas, or token counts — Relay only reports what it saw.
 */
export function summarizeUsage(
  state: RelayState,
  now = new Date(),
): UsageSummary {
  const nowMs = now.getTime();
  const fiveHoursSince = nowMs - 5 * 60 * 60 * 1000;
  const weekSince = nowMs - 7 * 24 * 60 * 60 * 1000;
  const agents: AgentUsage[] = registeredAgents().map((adapter) => {
    const runs = state.agentHistory.filter((run) => run.agent === adapter.id);
    const last = runs.at(-1);
    const totalMs = runs.reduce((sum, run) => {
      if (!run.endedAt) return sum;
      return sum + (Date.parse(run.endedAt) - Date.parse(run.startedAt));
    }, 0);
    const running = last !== undefined && last.endedAt === undefined;
    return {
      id: adapter.id,
      displayName: adapter.displayName,
      runs: runs.length,
      activeNow: state.currentAgent === adapter.id,
      lastRunAt: last ? (last.endedAt ?? last.startedAt) : null,
      lastReason: last
        ? (last.exitReason ?? (running ? 'running' : null))
        : null,
      totalMs,
      fiveHours: windowUsage(runs, fiveHoursSince, nowMs),
      week: windowUsage(runs, weekSince, nowMs),
    };
  });
  const sumWindow = (key: 'fiveHours' | 'week'): UsageWindow =>
    agents.reduce(
      (total, agent) => ({
        runs: total.runs + agent[key].runs,
        totalMs: total.totalMs + agent[key].totalMs,
      }),
      { runs: 0, totalMs: 0 },
    );
  return {
    generatedAt: now.toISOString(),
    task: { title: state.task.title, status: state.task.status },
    checkpoints: state.checkpoints.length,
    fiveHours: sumWindow('fiveHours'),
    week: sumWindow('week'),
    agents,
  };
}
