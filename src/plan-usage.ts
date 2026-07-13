import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { registeredAgents } from './agents/registry.js';
import type { AgentId } from './agents/adapter.js';
import { relayPath } from './safety/path-policy.js';

export interface PlanWindow {
  usedPercentage: number;
  remainingPercentage: number;
  resetsAt: string | null;
}

export interface ProviderPlanUsage {
  id: AgentId;
  displayName: string;
  status: 'available' | 'stale' | 'unknown';
  source: string;
  capturedAt: string | null;
  fiveHour?: PlanWindow;
  week?: PlanWindow;
  detail: string;
}

export const PLAN_USAGE_STALE_MS = 15 * 60 * 1000;

interface StoredClaudeUsage {
  provider: 'claude';
  capturedAt: string;
  fiveHour?: { usedPercentage: number; resetsAt?: number };
  week?: { usedPercentage: number; resetsAt?: number };
}

function validPercentage(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 100
  );
}

function planWindow(
  value: StoredClaudeUsage['fiveHour'],
): PlanWindow | undefined {
  if (!value || !validPercentage(value.usedPercentage)) return undefined;
  return {
    usedPercentage: value.usedPercentage,
    remainingPercentage: 100 - value.usedPercentage,
    resetsAt:
      typeof value.resetsAt === 'number' && Number.isFinite(value.resetsAt)
        ? new Date(value.resetsAt * 1000).toISOString()
        : null,
  };
}

export async function prepareProviderUsage(
  projectRoot: string,
  agent: AgentId,
): Promise<string | undefined> {
  if (agent !== 'claude') return undefined;
  const runtime = relayPath(projectRoot, 'runtime');
  const usageDirectory = relayPath(projectRoot, 'provider-usage');
  await Promise.all([
    mkdir(runtime, { recursive: true, mode: 0o700 }),
    mkdir(usageDirectory, { recursive: true, mode: 0o700 }),
  ]);
  const outputPath = relayPath(projectRoot, 'provider-usage', 'claude.json');
  const collectorPath = relayPath(projectRoot, 'runtime', 'claude-usage.cjs');
  const settingsPath = relayPath(
    projectRoot,
    'runtime',
    'claude-settings.json',
  );
  const collector = `const fs = require('node:fs');\nlet input = '';\nprocess.stdin.setEncoding('utf8');\nprocess.stdin.on('data', chunk => input += chunk);\nprocess.stdin.on('end', () => {\n  try {\n    const data = JSON.parse(input);\n    const limits = data.rate_limits;\n    if (!limits) return;\n    const clean = value => value && Number.isFinite(value.used_percentage) ? { usedPercentage: Math.max(0, Math.min(100, value.used_percentage)), ...(Number.isFinite(value.resets_at) ? { resetsAt: value.resets_at } : {}) } : undefined;\n    const result = { provider: 'claude', capturedAt: new Date().toISOString(), fiveHour: clean(limits.five_hour), week: clean(limits.seven_day) };\n    if (!result.fiveHour && !result.week) return;\n    const destination = ${JSON.stringify(outputPath)};\n    const temporary = destination + '.tmp';\n    fs.writeFileSync(temporary, JSON.stringify(result, null, 2) + '\\n', { mode: 0o600 });\n    fs.renameSync(temporary, destination);\n  } catch {}\n});\n`;
  await writeFile(collectorPath, collector, { encoding: 'utf8', mode: 0o600 });
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  await writeFile(
    settingsPath,
    `${JSON.stringify(
      {
        statusLine: {
          type: 'command',
          command: `${quote(process.execPath)} ${quote(collectorPath)}`,
          refreshInterval: 30,
        },
      },
      null,
      2,
    )}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );
  return settingsPath;
}

interface CodexRateWindow {
  used_percent?: unknown;
  window_minutes?: unknown;
  resets_at?: unknown;
}

interface CodexUsage {
  capturedAt: string;
  planType: string | null;
  fiveHour?: PlanWindow;
  week?: PlanWindow;
}

function codexWindow(
  value: CodexRateWindow | null | undefined,
): PlanWindow | undefined {
  if (!value || !validPercentage(value.used_percent)) return undefined;
  return {
    usedPercentage: value.used_percent,
    remainingPercentage: 100 - value.used_percent,
    resetsAt:
      typeof value.resets_at === 'number' && Number.isFinite(value.resets_at)
        ? new Date(value.resets_at * 1000).toISOString()
        : null,
  };
}

/**
 * Read plan usage from the Codex CLI's own session telemetry. Codex writes
 * `token_count` events into rollout-*.jsonl files under $CODEX_HOME/sessions;
 * each carries a `rate_limits` block with used percentage, window length, and
 * reset time. Only those numeric fields (and the event timestamp / plan type)
 * are parsed — conversation content is never read into Relay state.
 */
export async function readCodexPlanUsage(
  codexHome = process.env.CODEX_HOME || path.join(homedir(), '.codex'),
): Promise<CodexUsage | null> {
  const sessions = path.join(codexHome, 'sessions');
  let files: string[];
  try {
    files = (await readdir(sessions, { recursive: true }))
      .filter((name) => /rollout-.*\.jsonl$/.test(name))
      .sort();
  } catch {
    return null;
  }
  // Rollout filenames embed a zero-padded timestamp, so the lexicographic
  // maximum is the newest session. Scan a few in case the newest has no
  // token_count event yet.
  for (const name of files.slice(-3).reverse()) {
    try {
      const contents = await readFile(path.join(sessions, name), 'utf8');
      for (const line of contents.split('\n').reverse()) {
        if (!line.includes('"rate_limits"')) continue;
        let parsed: {
          timestamp?: unknown;
          payload?: {
            rate_limits?: {
              primary?: CodexRateWindow | null;
              secondary?: CodexRateWindow | null;
              plan_type?: unknown;
            } | null;
          };
        };
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        const limits = parsed.payload?.rate_limits;
        if (!limits) continue;
        const windows: { fiveHour?: PlanWindow; week?: PlanWindow } = {};
        for (const candidate of [limits.primary, limits.secondary]) {
          const window = codexWindow(candidate);
          if (!window) continue;
          const minutes = candidate?.window_minutes;
          if (typeof minutes === 'number' && minutes <= 360)
            windows.fiveHour ??= window;
          else windows.week ??= window;
        }
        if (!windows.fiveHour && !windows.week) continue;
        return {
          capturedAt:
            typeof parsed.timestamp === 'string'
              ? parsed.timestamp
              : new Date().toISOString(),
          planType:
            typeof limits.plan_type === 'string' ? limits.plan_type : null,
          ...windows,
        };
      }
    } catch {
      // Unreadable session file; try the next one.
    }
  }
  return null;
}

export async function readProviderPlanUsage(
  projectRoot: string,
  options: { codexHome?: string; now?: Date; staleAfterMs?: number } = {},
): Promise<ProviderPlanUsage[]> {
  const now = (options.now ?? new Date()).getTime();
  const staleAfterMs = options.staleAfterMs ?? PLAN_USAGE_STALE_MS;
  const freshness = (
    capturedAt: string,
    windows: Array<PlanWindow | undefined>,
  ): 'available' | 'stale' => {
    const captured = Date.parse(capturedAt);
    if (
      !Number.isFinite(captured) ||
      captured > now ||
      now - captured > staleAfterMs
    )
      return 'stale';
    if (
      windows.some(
        (window) => window?.resetsAt && Date.parse(window.resetsAt) <= now,
      )
    )
      return 'stale';
    return 'available';
  };
  let claude: StoredClaudeUsage | null = null;
  try {
    claude = JSON.parse(
      await readFile(
        relayPath(projectRoot, 'provider-usage', 'claude.json'),
        'utf8',
      ),
    ) as StoredClaudeUsage;
  } catch {
    claude = null;
  }
  const codex = await readCodexPlanUsage(options.codexHome).catch(() => null);
  return registeredAgents().map((agent) => {
    if (agent.id === 'claude' && claude?.provider === 'claude') {
      const fiveHour = planWindow(claude.fiveHour);
      const week = planWindow(claude.week);
      if (fiveHour || week) {
        return {
          id: agent.id,
          displayName: agent.displayName,
          status: freshness(claude.capturedAt, [fiveHour, week]),
          source: 'Claude Code status line',
          capturedAt: claude.capturedAt,
          fiveHour,
          week,
          detail: 'Official Claude.ai subscriber rate-limit fields.',
        };
      }
    }
    if (agent.id === 'codex' && codex) {
      return {
        id: agent.id,
        displayName: agent.displayName,
        status: freshness(codex.capturedAt, [codex.fiveHour, codex.week]),
        source: 'Codex CLI session telemetry (local)',
        capturedAt: codex.capturedAt,
        fiveHour: codex.fiveHour,
        week: codex.week,
        detail: codex.planType
          ? `Rate-limit fields Codex recorded for your ChatGPT ${codex.planType} plan.`
          : 'Rate-limit fields recorded by the Codex CLI.',
      };
    }
    const details: Record<AgentId, string> = {
      claude: 'Start Claude and send one prompt to populate plan usage.',
      codex: 'Run Codex once; it records rate limits in its session telemetry.',
      gemini: 'Gemini plan usage depends on authentication method.',
      antigravity:
        'Antigravity has no verified machine-readable quota interface.',
    };
    return {
      id: agent.id,
      displayName: agent.displayName,
      status: 'unknown',
      source: 'Unavailable',
      capturedAt: null,
      detail: details[agent.id],
    };
  });
}
