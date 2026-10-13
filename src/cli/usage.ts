import { Command } from 'commander';
import { ZodError } from 'zod';
import { discoverRepository } from '../git/repository.js';
import { RelayLockError } from '../state/lock.js';
import { readState } from '../state/store.js';
import { summarizeUsage, type AgentUsage } from '../usage.js';
import {
  readProviderPlanUsage,
  type PlanWindow,
  type ProviderPlanUsage,
} from '../plan-usage.js';
import {
  getCachedTokenUsage,
  getTokenUsageOptIn,
  setTokenUsageOptIn,
  type AgentId,
} from '../token-usage/index.js';
import { TokenUsagePrivacyError } from '../token-usage/privacy.js';

/**
 * Token usage errors cross stderr into the desktop app, so they carry fixed
 * wording only: never a lock path, cache path, or matched username.
 */
export function safeTokenUsageError(error: unknown): Error {
  if (error instanceof RelayLockError)
    return new Error(
      'Another token usage refresh is still running. Try again shortly.',
    );
  if (error instanceof TokenUsagePrivacyError)
    return new Error(
      'Token usage data failed a privacy check and was not shown.',
    );
  if (error instanceof ZodError)
    return new Error('Invalid token usage option.');
  return new Error('Token usage could not be read.');
}

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

function metricValue(metric: ProviderPlanUsage['metrics'][number]): string {
  if (metric.unit === 'percent' && metric.used !== undefined) {
    const remaining =
      metric.remaining !== undefined
        ? ` (${Math.round(metric.remaining * 100) / 100}% remaining)`
        : '';
    const display = `${Math.round(metric.used * 100) / 100}% used${remaining}`;
    return metric.status === 'stale' ? `${display} (stale)` : display;
  }
  const value = metric.remaining ?? metric.used;
  if (value === undefined) return '-';
  const suffix = metric.unit === 'percent' ? '%' : ` ${metric.unit}`;
  const display = `${Math.round(value * 100) / 100}${suffix}`;
  return metric.status === 'stale' ? `${display} (stale)` : display;
}

function planRow(plan: ProviderPlanUsage): string {
  const windows =
    plan.metrics.length > 0
      ? plan.metrics.map((metric) => ({
          label: metric.window?.label ?? metric.id,
          value: metricValue(metric),
        }))
      : [
          { label: '5-hour', value: planWindow(plan.fiveHour) },
          { label: 'Weekly', value: planWindow(plan.week) },
        ];
  return windows
    .map(
      ({ label, value }) =>
        plan.displayName.padEnd(15) +
        plan.status.padEnd(11) +
        label.padEnd(16) +
        value,
    )
    .join('\n');
}

function compactTokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1).replace(/\.0$/, '')}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1).replace(/\.0$/, '')}K`;
  return String(n);
}

function fullTokens(n: number): string {
  return n.toLocaleString('en-US');
}

export function tokensCommand(): Command {
  return new Command('tokens')
    .description(
      'Show machine-wide token analytics across all coding agents on this machine',
    )
    .option('--json', 'print machine-readable JSON')
    .option('--days <number>', 'number of days to report (7, 30, 90)', '30')
    .option(
      '--agent <id>',
      'limit refresh to a specific agent (claude, codex, gemini, antigravity, opencode)',
    )
    .option('--opt-in', 'enable token usage analytics from local agent logs')
    .option('--opt-out', 'disable token usage analytics')
    .option('--check-opt-in', 'check whether token usage analytics is enabled')
    .option('--refresh', 'bypass cache and rescan agent logs immediately')
    .action(
      async (
        options: {
          json?: boolean;
          days?: string;
          agent?: string;
          optIn?: boolean;
          optOut?: boolean;
          checkOptIn?: boolean;
          refresh?: boolean;
        },
        cmd: Command,
      ) => {
        const isJson = Boolean(
          options.json ||
          cmd.optsWithGlobals?.()?.json ||
          cmd.parent?.opts?.()?.json,
        );
        if (options.checkOptIn) {
          const isOptedIn = await getTokenUsageOptIn();
          if (isJson) {
            process.stdout.write(`${JSON.stringify({ optedIn: isOptedIn })}\n`);
          } else {
            process.stdout.write(
              `Token usage analytics: ${isOptedIn ? 'enabled' : 'disabled'}\n`,
            );
          }
          return;
        }
        if (options.optIn) {
          await setTokenUsageOptIn(true);
          process.stdout.write('Token usage analytics enabled.\n');
          return;
        }
        if (options.optOut) {
          await setTokenUsageOptIn(false);
          process.stdout.write('Token usage analytics disabled.\n');
          return;
        }

        const isOptedIn = await getTokenUsageOptIn();
        if (!isOptedIn) {
          process.stderr.write(
            'Notice: Token usage analytics reads local coding-agent logs. Run `relay usage tokens --opt-in` to acknowledge.\n',
          );
        }

        const daysNum = Math.max(1, parseInt(options.days ?? '30', 10) || 30);
        let report;
        try {
          report = await getCachedTokenUsage({
            days: daysNum,
            forceRefresh: options.refresh,
            agent: options.agent as AgentId | undefined,
          });
        } catch (error) {
          throw safeTokenUsageError(error);
        }

        if (isJson) {
          process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
          return;
        }

        const total = report.totals?.totalTokens ?? null;
        const totalStr =
          total != null
            ? `${fullTokens(total)} (${compactTokens(total)})`
            : 'Unavailable';

        const lines = [
          `Machine-wide token analytics · Last ${report.range.days} days (${report.range.since} to ${report.range.until})`,
          `Total tokens: ${totalStr}`,
          '',
          'Agent            Tokens        Share   Coverage',
        ];

        for (const agent of report.agents) {
          const tokensStr =
            agent.totalTokens != null ? fullTokens(agent.totalTokens) : '—';
          const sharePct =
            agent.totalTokens != null && total != null && total > 0
              ? Math.round((agent.totalTokens / total) * 100)
              : null;
          const shareStr = sharePct != null ? `${sharePct}%` : '—';
          let coverageStr =
            agent.status === 'unavailable' ? 'No logs found' : 'Complete';
          if (agent.status === 'error') {
            coverageStr = `Error (${agent.errorCode ?? agent.errorReason ?? 'unknown'})`;
          } else if (agent.coverage.noActivity) {
            coverageStr = 'No activity found';
          } else if (!agent.coverage.complete) {
            coverageStr = agent.coverage.note
              ? `${agent.coverage.note} (Partial)`
              : `Logs from ${agent.coverage.earliestDate ?? 'recent'} (Partial)`;
          }

          if (
            agent.status === 'available' &&
            agent.coverage.dataThrough &&
            agent.coverage.dataThrough < report.range.until
          ) {
            coverageStr += ` [data through ${agent.coverage.dataThrough}]`;
          } else if (agent.freshness === 'stale') {
            coverageStr += ' [stale]';
          }

          lines.push(
            agent.name.padEnd(17) +
              tokensStr.padEnd(14) +
              shareStr.padEnd(8) +
              coverageStr,
          );
        }

        const partialAgents = report.agents.filter(
          (a) => !a.coverage.complete && a.status === 'available',
        );
        if (partialAgents.length > 0) {
          lines.push('');
          lines.push(
            `* Note: ${partialAgents.map((a) => a.name).join(', ')} logs don't reach back to ${report.range.since}, so the ranking may be off.`,
          );
        }
        if (report.dataThrough && report.dataThrough < report.range.until) {
          lines.push(
            `* Note: Data only through ${report.dataThrough}. Later days were not collected yet; run with --refresh.`,
          );
        }

        if (report.sessions.length > 0) {
          lines.push('');
          lines.push('Recent sessions:');
          lines.push(
            'Agent        Project               Models                  Tokens       Activity',
          );
          for (const session of report.sessions.slice(0, 10)) {
            const agentMeta = report.agents.find((a) => a.id === session.agent);
            const agentName = agentMeta?.name ?? session.agent;
            const modelsStr = session.models.join(', ') || '—';
            const activityStr = session.live
              ? 'Active now'
              : session.lastActivity
                ? relativeTime(session.lastActivity)
                : '—';
            lines.push(
              agentName.padEnd(13) +
                session.projectLabel.slice(0, 20).padEnd(22) +
                modelsStr.slice(0, 22).padEnd(24) +
                fullTokens(session.totalTokens).padEnd(13) +
                activityStr,
            );
          }
        }

        process.stdout.write(`${lines.join('\n')}\n`);
      },
    );
}

export function usageCommand(): Command {
  const cmd = new Command('usage')
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
                schemaVersion: 2,
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
          `${['Provider plan usage', 'Provider       Status      Window          Usage', ...plans.map(planRow)].join('\n')}\n`,
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
          `${JSON.stringify({ schemaVersion: 2, ...summary, plans }, null, 2)}\n`,
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
        'Provider       Status      Window          Usage',
        ...plans.map(planRow),
      ];
      process.stdout.write(`${lines.join('\n')}\n`);
    });

  cmd.addCommand(tokensCommand());
  return cmd;
}
