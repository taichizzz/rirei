import { constants } from 'node:fs';
import { chmod, mkdir, open, readdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { registeredAgents } from './agents/registry.js';
import type { AgentId } from './agents/adapter.js';
import { relayPath } from './safety/path-policy.js';

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
  | 'unsupported_provider';

export interface ProviderPlanUsage {
  id: AgentId;
  displayName: string;
  status: 'available' | 'stale' | 'unknown';
  statusReason: ProviderPlanStatusReason;
  source: string;
  capturedAt: string | null;
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

export const PLAN_USAGE_STALE_MS = 15 * 60 * 1000;
export const CLAUDE_USAGE_INPUT_MAX_BYTES = 256 * 1024;
export const CODEX_ROLLOUT_FILE_LIMIT = 3;
export const CODEX_ROLLOUT_TAIL_MAX_BYTES = 512 * 1024;

const SANITIZED_USAGE_MAX_BYTES = 64 * 1024;
const CLAUDE_OBSERVATION_REFRESH_MS = 10 * 60 * 1000;
const MIN_PROVIDER_EPOCH_SECONDS = 946684800;
const MAX_PROVIDER_EPOCH_SECONDS = 32503680000;

interface StoredClaudeUsage {
  provider?: unknown;
  capturedAt?: unknown;
  fiveHour?: { usedPercentage?: unknown; resetsAt?: unknown };
  week?: { usedPercentage?: unknown; resetsAt?: unknown };
}

function validPercentage(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 100
  );
}

function resetIso(value: unknown): string | null {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < MIN_PROVIDER_EPOCH_SECONDS ||
    value > MAX_PROVIDER_EPOCH_SECONDS
  )
    return null;
  const milliseconds = value * 1000;
  if (!Number.isFinite(milliseconds)) return null;
  try {
    return new Date(milliseconds).toISOString();
  } catch {
    return null;
  }
}

function validCapturedAt(value: unknown): string | null {
  if (typeof value !== 'string' || !value.includes('T')) return null;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return null;
  const seconds = milliseconds / 1000;
  if (
    seconds < MIN_PROVIDER_EPOCH_SECONDS ||
    seconds > MAX_PROVIDER_EPOCH_SECONDS
  )
    return null;
  return new Date(milliseconds).toISOString();
}

function planWindow(
  value: StoredClaudeUsage['fiveHour'],
): PlanWindow | undefined {
  if (!value || !validPercentage(value.usedPercentage)) return undefined;
  return {
    usedPercentage: value.usedPercentage,
    remainingPercentage: 100 - value.usedPercentage,
    resetsAt: resetIso(value.resetsAt),
  };
}

export function claudeProviderUsagePath(
  options: ProviderUsagePathOptions = {},
): string {
  return (
    options.claudeUsagePath ??
    path.join(
      options.home ?? homedir(),
      '.relay',
      'provider-usage',
      'claude.json',
    )
  );
}

function claudeCollectorSource(destination: string): string {
  return `const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const MAX_INPUT_BYTES = ${CLAUDE_USAGE_INPUT_MAX_BYTES};
const MAX_STORED_BYTES = ${SANITIZED_USAGE_MAX_BYTES};
const OBSERVATION_REFRESH_MS = ${CLAUDE_OBSERVATION_REFRESH_MS};
const MIN_RESET_SECONDS = ${MIN_PROVIDER_EPOCH_SECONDS};
const MAX_RESET_SECONDS = ${MAX_PROVIDER_EPOCH_SECONDS};
const destination = ${JSON.stringify(destination)};
let chunks = [];
let inputBytes = 0;
let oversized = false;
let temporary;

process.stdin.on('data', chunk => {
  if (oversized) return;
  inputBytes += chunk.length;
  if (inputBytes > MAX_INPUT_BYTES) {
    oversized = true;
    chunks = [];
    return;
  }
  chunks.push(chunk);
});

process.stdin.on('end', () => {
  if (oversized) return;
  try {
    const data = JSON.parse(Buffer.concat(chunks, inputBytes).toString('utf8'));
    chunks = [];
    const limits = data && data.rate_limits;
    if (!limits || typeof limits !== 'object') return;
    const clean = value => {
      if (!value || typeof value !== 'object') return undefined;
      const percentage = value.used_percentage;
      if (typeof percentage !== 'number' || !Number.isFinite(percentage)) return undefined;
      const result = { usedPercentage: Math.max(0, Math.min(100, percentage)) };
      const reset = value.resets_at;
      if (typeof reset === 'number' && Number.isInteger(reset) && reset >= MIN_RESET_SECONDS && reset <= MAX_RESET_SECONDS)
        result.resetsAt = reset;
      return result;
    };
    const fiveHour = clean(limits.five_hour);
    const week = clean(limits.seven_day);
    if (!fiveHour && !week) return;

    let previous;
    let previousCapturedAt;
    let previousDescriptor;
    try {
      previousDescriptor = fs.openSync(destination, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      const buffer = Buffer.alloc(MAX_STORED_BYTES + 1);
      const bytesRead = fs.readSync(previousDescriptor, buffer, 0, buffer.length, 0);
      if (bytesRead <= MAX_STORED_BYTES) {
        const stored = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
        if (stored && stored.provider === 'claude') {
          const cleanStored = value => {
            if (!value || typeof value !== 'object') return undefined;
            if (typeof value.usedPercentage !== 'number' || !Number.isFinite(value.usedPercentage) || value.usedPercentage < 0 || value.usedPercentage > 100)
              return undefined;
            const result = { usedPercentage: value.usedPercentage };
            if (typeof value.resetsAt === 'number' && Number.isInteger(value.resetsAt) && value.resetsAt >= MIN_RESET_SECONDS && value.resetsAt <= MAX_RESET_SECONDS)
              result.resetsAt = value.resetsAt;
            return result;
          };
          previous = { fiveHour: cleanStored(stored.fiveHour), week: cleanStored(stored.week) };
          if (typeof stored.capturedAt === 'string') {
            const captured = Date.parse(stored.capturedAt);
            if (Number.isFinite(captured)) previousCapturedAt = captured;
          }
        }
      }
    } catch {
    } finally {
      if (previousDescriptor !== undefined) fs.closeSync(previousDescriptor);
    }

    const current = { fiveHour, week };
    const observedAt = Date.now();
    if (previous && JSON.stringify(previous) === JSON.stringify(current)
        && previousCapturedAt !== undefined && previousCapturedAt <= observedAt
        && observedAt - previousCapturedAt < OBSERVATION_REFRESH_MS) return;
    const result = {
      provider: 'claude',
      capturedAt: new Date(observedAt).toISOString(),
      ...(fiveHour ? { fiveHour } : {}),
      ...(week ? { week } : {}),
    };
    const directory = path.dirname(destination);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(directory, 0o700);
    temporary = destination + '.' + process.pid + '.' + crypto.randomUUID() + '.tmp';
    const descriptor = fs.openSync(temporary, 'wx', 0o600);
    try {
      fs.writeFileSync(descriptor, JSON.stringify(result, null, 2) + '\\n');
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    fs.renameSync(temporary, destination);
    temporary = undefined;
    fs.chmodSync(destination, 0o600);
  } catch {
  } finally {
    if (temporary) {
      try { fs.unlinkSync(temporary); } catch {}
    }
  }
});
`;
}

export async function prepareProviderUsage(
  projectRoot: string,
  agent: AgentId,
  options: ProviderUsagePathOptions = {},
): Promise<string | undefined> {
  if (agent !== 'claude') return undefined;
  const runtime = relayPath(projectRoot, 'runtime');
  await mkdir(runtime, { recursive: true, mode: 0o700 });
  await chmod(runtime, 0o700);
  const collectorPath = relayPath(projectRoot, 'runtime', 'claude-usage.cjs');
  const settingsPath = relayPath(
    projectRoot,
    'runtime',
    'claude-settings.json',
  );
  await writeFile(
    collectorPath,
    claudeCollectorSource(claudeProviderUsagePath(options)),
    { encoding: 'utf8', mode: 0o600 },
  );
  await chmod(collectorPath, 0o600);
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  await writeFile(
    settingsPath,
    `${JSON.stringify(
      {
        statusLine: {
          type: 'command',
          command: `${quote(process.execPath)} ${quote(collectorPath)}`,
        },
      },
      null,
      2,
    )}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );
  await chmod(settingsPath, 0o600);
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
    resetsAt: resetIso(value.resets_at),
  };
}

async function readFileTail(filePath: string): Promise<string> {
  const handle = await open(
    filePath,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const metadata = await handle.stat();
    const length = Math.min(metadata.size, CODEX_ROLLOUT_TAIL_MAX_BYTES);
    const offset = Math.max(0, metadata.size - length);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    let contents = buffer.subarray(0, bytesRead).toString('utf8');
    if (offset > 0) {
      const firstNewline = contents.indexOf('\n');
      if (firstNewline < 0) return '';
      contents = contents.slice(firstNewline + 1);
    }
    return contents;
  } finally {
    await handle.close();
  }
}

/**
 * Read only recent, bounded Codex CLI telemetry tails. Matching token_count
 * records contribute numeric rate-limit fields; conversation records are
 * ignored and nothing from a rollout is persisted by Relay.
 */
export async function readCodexPlanUsage(
  codexHome = process.env.CODEX_HOME || path.join(homedir(), '.codex'),
): Promise<CodexUsage | null> {
  const sessions = path.join(codexHome, 'sessions');
  let files: string[];
  try {
    files = (await readdir(sessions, { recursive: true }))
      .filter((name) => /(?:^|[\\/])rollout-.*\.jsonl$/.test(name))
      .sort();
  } catch {
    return null;
  }
  for (const name of files.slice(-CODEX_ROLLOUT_FILE_LIMIT).reverse()) {
    try {
      const contents = await readFileTail(path.join(sessions, name));
      for (const line of contents.split('\n').reverse()) {
        if (!line.includes('"rate_limits"')) continue;
        let parsed: {
          timestamp?: unknown;
          type?: unknown;
          payload?: {
            type?: unknown;
            rate_limits?: {
              primary?: CodexRateWindow | null;
              secondary?: CodexRateWindow | null;
              plan_type?: unknown;
            } | null;
          };
        };
        try {
          parsed = JSON.parse(line) as typeof parsed;
        } catch {
          continue;
        }
        if (
          parsed.type !== 'event_msg' ||
          parsed.payload?.type !== 'token_count'
        )
          continue;
        const capturedAt = validCapturedAt(parsed.timestamp);
        const limits = parsed.payload.rate_limits;
        if (!capturedAt || !limits) continue;
        const windows: { fiveHour?: PlanWindow; week?: PlanWindow } = {};
        for (const candidate of [limits.primary, limits.secondary]) {
          const window = codexWindow(candidate);
          if (!window) continue;
          if (candidate?.window_minutes === 300) windows.fiveHour ??= window;
          if (candidate?.window_minutes === 10080) windows.week ??= window;
        }
        if (!windows.fiveHour && !windows.week) continue;
        return {
          capturedAt,
          planType:
            typeof limits.plan_type === 'string' &&
            /^[a-zA-Z0-9_-]{1,32}$/.test(limits.plan_type)
              ? limits.plan_type
              : null,
          ...windows,
        };
      }
    } catch {
      // Unreadable session file; try the next recent file.
    }
  }
  return null;
}

async function readStoredClaude(
  filePath: string,
): Promise<StoredClaudeUsage | null> {
  let handle;
  try {
    handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const buffer = Buffer.alloc(SANITIZED_USAGE_MAX_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > SANITIZED_USAGE_MAX_BYTES) return null;
    const parsed = JSON.parse(
      buffer.subarray(0, bytesRead).toString('utf8'),
    ) as StoredClaudeUsage;
    return parsed?.provider === 'claude' ? parsed : null;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function withFreshness(
  window: PlanWindow,
  capturedAt: string | null,
  now: number,
  staleAfterMs: number,
): PlanWindow {
  const captured = capturedAt ? Date.parse(capturedAt) : Number.NaN;
  let statusReason: PlanWindowStatusReason = 'live';
  if (!Number.isFinite(captured) || captured > now) {
    statusReason = 'invalid_capture';
  } else if (now - captured > staleAfterMs) {
    statusReason = 'sample_stale';
  } else if (window.resetsAt && Date.parse(window.resetsAt) <= now) {
    statusReason = 'window_expired';
  }
  return {
    ...window,
    status: statusReason === 'live' ? 'available' : 'stale',
    statusReason,
  };
}

async function loadClaudeUsage(
  projectRoot: string,
  options: ProviderUsagePathOptions,
): Promise<{
  capturedAt: string | null;
  fiveHour?: PlanWindow;
  week?: PlanWindow;
} | null> {
  const globalPath = claudeProviderUsagePath(options);
  const localPath = relayPath(projectRoot, 'provider-usage', 'claude.json');
  const candidates =
    path.resolve(globalPath) === path.resolve(localPath)
      ? [globalPath]
      : [globalPath, localPath];
  for (const candidate of candidates) {
    const sample = await readStoredClaude(candidate);
    if (!sample) continue;
    const fiveHour = planWindow(sample.fiveHour);
    const week = planWindow(sample.week);
    if (!fiveHour && !week) continue;
    return {
      capturedAt: validCapturedAt(sample.capturedAt),
      fiveHour,
      week,
    };
  }
  return null;
}

export async function readProviderPlanUsage(
  projectRoot: string,
  options: ReadProviderPlanUsageOptions = {},
): Promise<ProviderPlanUsage[]> {
  const now = (options.now ?? new Date()).getTime();
  const staleAfterMs = options.staleAfterMs ?? PLAN_USAGE_STALE_MS;
  const [claude, codex] = await Promise.all([
    loadClaudeUsage(projectRoot, options),
    readCodexPlanUsage(options.codexHome).catch(() => null),
  ]);
  return registeredAgents().map((agent) => {
    if (agent.id === 'claude' && claude) {
      const fiveHour = claude.fiveHour
        ? withFreshness(claude.fiveHour, claude.capturedAt, now, staleAfterMs)
        : undefined;
      const week = claude.week
        ? withFreshness(claude.week, claude.capturedAt, now, staleAfterMs)
        : undefined;
      const available = [fiveHour, week].some(
        (window) => window?.status === 'available',
      );
      return {
        id: agent.id,
        displayName: agent.displayName,
        status: available ? 'available' : 'stale',
        statusReason: available ? 'live_window' : 'all_windows_stale',
        source: 'Claude Code status line',
        capturedAt: claude.capturedAt,
        fiveHour,
        week,
        detail: 'Official Claude.ai subscriber rate-limit fields.',
      };
    }
    if (agent.id === 'codex' && codex) {
      const fiveHour = codex.fiveHour
        ? withFreshness(codex.fiveHour, codex.capturedAt, now, staleAfterMs)
        : undefined;
      const week = codex.week
        ? withFreshness(codex.week, codex.capturedAt, now, staleAfterMs)
        : undefined;
      const available = [fiveHour, week].some(
        (window) => window?.status === 'available',
      );
      return {
        id: agent.id,
        displayName: agent.displayName,
        status: available ? 'available' : 'stale',
        statusReason: available ? 'live_window' : 'all_windows_stale',
        source: 'Codex CLI session telemetry (local)',
        capturedAt: codex.capturedAt,
        fiveHour,
        week,
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
    const reasons: Record<AgentId, ProviderPlanStatusReason> = {
      claude: 'not_collected',
      codex: 'not_collected',
      gemini: 'unsupported_auth',
      antigravity: 'unsupported_provider',
    };
    return {
      id: agent.id,
      displayName: agent.displayName,
      status: 'unknown',
      statusReason: reasons[agent.id],
      source: 'Unavailable',
      capturedAt: null,
      detail: details[agent.id],
    };
  });
}
