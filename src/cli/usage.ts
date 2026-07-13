import { Command } from 'commander';
import { discoverRepository } from '../git/repository.js';
import { readState } from '../state/store.js';
import { summarizeUsage, type AgentUsage } from '../usage.js';
import { readProviderPlanUsage } from '../plan-usage.js';

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

export function usageCommand(): Command {
  return new Command('usage')
    .description('Show how much each agent has been used during this task')
    .option('--json', 'print machine-readable JSON')
    .action(async (options: { json?: boolean }) => {
      const root = await discoverRepository(process.cwd());
      if (!root) throw new Error('Relay must be run inside a Git repository.');
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
          `${JSON.stringify({ ...summary, plans }, null, 2)}\n`,
        );
        return;
      }
      const lines = [
        `Task: ${summary.task.title} (${summary.task.status})`,
        `Checkpoints: ${summary.checkpoints}`,
        '',
        'Agent        Runs  Last 5h  Last 7d  Last          Last reason',
        ...summary.agents.map(row),
      ];
      process.stdout.write(`${lines.join('\n')}\n`);
    });
}
