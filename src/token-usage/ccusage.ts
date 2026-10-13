import { execFile } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createErrorSnapshot,
  normalizeAgentDailyOutput,
  normalizeAgentSessionOutput,
} from './normalize.js';
import { PINNED_CCUSAGE_VERSION, resolveCcusageBinary } from './resolve.js';
import type { AgentCacheSnapshot, AgentId } from './schema.js';
import { calculateHistoryWindow } from './timezone.js';

/**
 * Per-call ccusage timeout. Antigravity takes ~33s; give it 120s. Others take
 * < 1s; give 30s. A snapshot makes two calls (daily, then sessions).
 */
export function scanTimeoutMs(agentId: AgentId): number {
  return agentId === 'antigravity' ? 120_000 : 30_000;
}

export interface CcusageSourceOptions {
  binaryPath?: string;
  configPath?: string;
}

export interface CollectAgentOptions {
  timezone: string;
  now?: Date;
  historyDays?: number;
}

function runProcess(
  binary: string,
  args: string[],
  options: { cwd: string; timeout: number; maxBuffer: number },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      binary,
      args,
      {
        cwd: options.cwd,
        timeout: options.timeout,
        maxBuffer: options.maxBuffer,
        encoding: 'utf8',
        env: {
          ...process.env,
          CI: '1',
          NO_COLOR: '1',
        },
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(error);
        } else {
          resolve({ stdout: String(stdout), stderr: String(stderr) });
        }
      },
    );
    // Section 3.5: Closed stdin
    child.stdin?.end();
  });
}

/**
 * Executes per-agent ccusage scans offline in isolated subprocesses.
 * Enforces per-agent timeouts, closed stdin, neutral working directory,
 * empty configuration override, and fixed error classifications.
 */
export class CcusageSource {
  private customBinaryPath?: string;
  private customConfigPath?: string;

  constructor(options?: CcusageSourceOptions) {
    this.customBinaryPath = options?.binaryPath;
    this.customConfigPath = options?.configPath;
  }

  private ensureEmptyConfig(): string {
    if (this.customConfigPath && existsSync(this.customConfigPath)) {
      return this.customConfigPath;
    }
    const emptyConfig = path.join(tmpdir(), 'rirei-empty-ccusage-config.json');
    if (!existsSync(emptyConfig)) {
      try {
        writeFileSync(emptyConfig, '{}\n', { mode: 0o600 });
      } catch {
        // Ignore file write error if tmpdir is read-only
      }
    }
    return emptyConfig;
  }

  /**
   * Collect a single agent's 180-day daily and session history.
   * Daily is collected first; session failures never invalidate daily data.
   */
  async collectAgentSnapshot(
    agentId: AgentId,
    options: CollectAgentOptions,
  ): Promise<AgentCacheSnapshot> {
    const now = options.now ?? new Date();
    const timezone = options.timezone;
    const historyDays = options.historyDays ?? 180;
    const window = calculateHistoryWindow(timezone, now, historyDays);

    const resolved = this.customBinaryPath
      ? {
          binaryPath: this.customBinaryPath,
          pathClass: 'dev' as const,
          version: PINNED_CCUSAGE_VERSION,
        }
      : resolveCcusageBinary();

    if (!resolved || !existsSync(resolved.binaryPath)) {
      return createErrorSnapshot(
        agentId,
        'binary_unavailable',
        'ccusage native binary not found',
        now,
      );
    }

    const emptyConfig = this.ensureEmptyConfig();
    const timeoutMs = scanTimeoutMs(agentId);

    // 1. Collect Daily Report (Primary)
    const dailyArgs = [
      agentId,
      'daily',
      '--json',
      '--offline',
      '--no-cost',
      '--timezone',
      timezone,
      '--since',
      window.since,
      '--until',
      window.until,
      '--config',
      emptyConfig,
    ];

    let dailyStdout = '';
    try {
      const res = await runProcess(resolved.binaryPath, dailyArgs, {
        cwd: tmpdir(),
        timeout: timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
      });
      dailyStdout = res.stdout;
    } catch (err: unknown) {
      const error = err as NodeJS.ErrnoException & {
        killed?: boolean;
        signal?: string;
      };

      if (
        error.killed ||
        error.signal === 'SIGTERM' ||
        error.code === 'ETIMEDOUT'
      ) {
        return createErrorSnapshot(
          agentId,
          'timed_out',
          `Timed out after ${Math.round(timeoutMs / 1000)}s`,
          now,
        );
      }
      if (error.code === 'ENOENT') {
        return createErrorSnapshot(
          agentId,
          'binary_unavailable',
          'ccusage native binary not found',
          now,
        );
      }
      if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
        return createErrorSnapshot(
          agentId,
          'output_too_large',
          'ccusage output exceeded buffer limit',
          now,
        );
      }
      if (typeof error.code === 'number' && error.code !== 0) {
        return createErrorSnapshot(
          agentId,
          'nonzero_exit',
          `ccusage exited with code ${error.code}`,
          now,
        );
      }
      return createErrorSnapshot(
        agentId,
        'invalid_output',
        'ccusage execution failed',
        now,
      );
    }

    let parsedDaily: unknown;
    try {
      parsedDaily = JSON.parse(dailyStdout);
    } catch {
      return createErrorSnapshot(
        agentId,
        'invalid_output',
        'Failed to parse ccusage JSON',
        now,
      );
    }

    let normalizedDaily: ReturnType<typeof normalizeAgentDailyOutput>;
    try {
      normalizedDaily = normalizeAgentDailyOutput(agentId, parsedDaily);
    } catch {
      return createErrorSnapshot(
        agentId,
        'invalid_output',
        'ccusage returned invalid output',
        now,
      );
    }

    // 2. Collect Session Report (Secondary — failures do not block daily charts)
    let sessions: ReturnType<typeof normalizeAgentSessionOutput> = [];
    // null = the session scan failed, which must not read as "no sessions".
    let sessionCount: number | null = null;
    try {
      const sessionArgs = [
        agentId,
        'session',
        '--json',
        '--offline',
        '--no-cost',
        '--timezone',
        timezone,
        '--since',
        window.since,
        '--until',
        window.until,
        '--config',
        emptyConfig,
      ];

      const res = await runProcess(resolved.binaryPath, sessionArgs, {
        cwd: tmpdir(),
        timeout: timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
      });

      const parsedSession = JSON.parse(res.stdout);
      sessions = normalizeAgentSessionOutput(agentId, parsedSession);
      sessionCount = sessions.length;
    } catch {
      // Session parsing/execution failure does not invalidate daily report
      sessions = [];
    }

    const isComplete =
      normalizedDaily.earliestDate == null ||
      normalizedDaily.earliestDate <= window.since;

    return {
      agentId,
      capturedAt: now.toISOString(),
      status: 'available',
      coverage: {
        complete: isComplete,
        earliestDate: normalizedDaily.earliestDate,
        note: isComplete
          ? undefined
          : `Earliest log from ${normalizedDaily.earliestDate}`,
      },
      totalTokens: normalizedDaily.totals.totalTokens,
      components: normalizedDaily.totals.components,
      itemized: normalizedDaily.totals.itemized,
      daily: normalizedDaily.daily,
      models: normalizedDaily.models,
      sessions,
      sessionCount,
    };
  }
}
