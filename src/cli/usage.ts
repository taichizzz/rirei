import { Command } from 'commander';
import { discoverRepository } from '../git/repository.js';
import { readState } from '../state/store.js';
import { summarizeUsage, type AgentUsage } from '../usage.js';
import {
  readProviderPlanUsage,
  type PlanWindow,
  type ProviderPlanUsage,
} from '../plan-usage.js';

function relativeTime(iso: string | null): string {
  if (!iso) return 'never';
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return 'unknown';
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function duration(ms: number): string {
  if (ms <= 0) return '—';
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function row(agent: AgentUsage): string {
  const activity = agent.activeNow
    ? 'running now'
    : relativeTime(agent.lastRunAt);
  return (
    agent.displayName.padEnd(13) +
    String(agent.runs).padEnd(6) +
    duration(agent.fiveHours.totalMs).padEnd(9) +
    duration(agent.week.totalMs).padEnd(9) +
    activity.padEnd(15) +
    (agent.lastReason ?? '—')
  );
}

function planWindow(window: PlanWindow | undefined): string {
  if (!window) return '-';
  const value = `${Math.round(window.usedPercentage)}% used`;
  return window.status === 'stale' ? `${value} (stale)` : value;
}

function planRow(plan: ProviderPlanUsage): string {
  return (
    plan.displayName.padEnd(15) +
    plan.status.padEnd(11) +
    planWindow(plan.fiveHour).padEnd(20) +
    planWindow(plan.week)
  );
}

export function usageCommand(): Command {
  return new Command('usage')
    .description('Show how much each agent has been used during this task')
    .option('--json', 'print machine-readable JSON')
    .option('--plans-only', 'read provider plan usage without requiring a task')
    .action(async (options: { json?: boolean; plansOnly?: boolean }) => {
      const discoveredRoot = await discoverRepository(process.cwd());
      const root = discoveredRoot ?? process.cwd();
      if (options.plansOnly) {
        const plans = await readProviderPlanUsage(root);
        if (options.json) {
          process.stdout.write(
            `${JSON.stringify(
              {
                schemaVersion: 1,
                task: { title: 'Provider plans', status: 'active' },
                plans,
              },
              null,
              2,
            )}\n`,
          );
          return;
        }
        process.stdout.write(
          `${['Provider plan usage', 'Provider       Status     5-hour              Weekly', ...plans.map(planRow)].join('\n')}\n`,
        );
        return;
      }
      if (!discoveredRoot)
        throw new Error('Relay must be run inside a Git repository.');
      let state;
      try {
        state = await readState(root);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT')
          throw new Error('No Relay task found. Run relay start first.');
        throw error;
      }
      const summary = summarizeUsage(state);
      const plans = await readProviderPlanUsage(root);
      if (options.json) {
        process.stdout.write(
          `${JSON.stringify({ schemaVersion: 1, ...summary, plans }, null, 2)}\n`,
        );
        return;
      }
      const lines = [
        `Task: ${summary.task.title} (${summary.task.status})`,
        `Checkpoints: ${summary.checkpoints}`,
        '',
        'Agent        Runs  Last 5h  Last 7d  Last          Last reason',
        ...summary.agents.map(row),
        '',
        'Provider plan usage',
        'Provider       Status     5-hour              Weekly',
        ...plans.map(planRow),
      ];
      process.stdout.write(`${lines.join('\n')}\n`);
    });
}
