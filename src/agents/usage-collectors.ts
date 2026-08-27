import { constants } from 'node:fs';
import { chmod, mkdir, open, readdir, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import {
  type ProviderUsageSnapshot,
  type UsageCollectionContext,
  type UsageMetric,
  type UsageMetricStatusReason,
  type UsagePreparation,
} from './adapter.js';
import { relayPath } from '../safety/path-policy.js';

export const PLAN_USAGE_STALE_MS = 15 * 60 * 1000;
export const CLAUDE_USAGE_INPUT_MAX_BYTES = 256 * 1024;
export const CODEX_ROLLOUT_FILE_LIMIT = 3;
export const CODEX_ROLLOUT_TAIL_MAX_BYTES = 512 * 1024;

const SANITIZED_USAGE_MAX_BYTES = 64 * 1024;
const CLAUDE_OBSERVATION_REFRESH_MS = 10 * 60 * 1000;
const MIN_PROVIDER_EPOCH_SECONDS = 946684800;
const MAX_PROVIDER_EPOCH_SECONDS = 32503680000;
const CODEX_TRAVERSAL_FILE_CAP = 2000;

const WINDOW_LABELS: Record<
  string,
  { id: string; label: string; seconds?: number }
> = {
  five_hour: { id: 'fiveHour', label: '5-hour', seconds: 5 * 60 * 60 },
  seven_day: { id: 'week', label: 'Weekly', seconds: 7 * 24 * 60 * 60 },
};

export function claudeProviderUsagePath(
  options: { home?: string; claudeUsagePath?: string } = {},
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

export function withFreshness(
  window: { used?: number; remaining?: number; resetsAt?: string | null },
  capturedAt: string | null,
  now: number,
  staleAfterMs: number,
): Omit<UsageMetric, 'id' | 'kind' | 'unit' | 'window'> {
  const captured = capturedAt ? Date.parse(capturedAt) : Number.NaN;
  let statusReason: UsageMetricStatusReason = 'live';
  if (!Number.isFinite(captured) || captured > now) {
    statusReason = 'invalid_capture';
  } else if (now - captured > staleAfterMs) {
    statusReason = 'sample_stale';
  } else if (window.resetsAt && Date.parse(window.resetsAt) <= now) {
    statusReason = 'window_expired';
  }
  return {
    ...window,
    resetsAt: window.resetsAt ?? undefined,
    status: statusReason === 'live' ? 'available' : 'stale',
    statusReason,
  };
}

interface ClaudeWindow {
  usedPercentage: number;
  resetsAt?: number;
}

interface StoredClaudeSample {
  provider?: unknown;
  capturedAt?: unknown;
  status?: unknown;
  reason?: unknown;
  fiveHour?: ClaudeWindow | unknown;
  week?: ClaudeWindow | unknown;
  windows?: Record<string, ClaudeWindow> | unknown;
}

function cleanClaudeWindow(value: unknown): ClaudeWindow | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const used = (value as Record<string, unknown>).usedPercentage;
  if (typeof used !== 'number' || !Number.isFinite(used)) return undefined;
  const result: ClaudeWindow = {
    usedPercentage: Math.max(0, Math.min(100, used)),
  };
  const reset = (value as Record<string, unknown>).resetsAt;
  if (
    typeof reset === 'number' &&
    Number.isInteger(reset) &&
    reset >= MIN_PROVIDER_EPOCH_SECONDS &&
    reset <= MAX_PROVIDER_EPOCH_SECONDS
  )
    result.resetsAt = reset;
  return result;
}

function storedWindows(
  sample: StoredClaudeSample,
): Record<string, ClaudeWindow> {
  const windows: Record<string, ClaudeWindow> = {};
  const legacy: Array<[string, unknown]> = [
    ['five_hour', sample.fiveHour],
    ['seven_day', sample.week],
  ];
  for (const [key, value] of legacy) {
    const cleaned = cleanClaudeWindow(value);
    if (cleaned) windows[key] = cleaned;
  }
  if (sample.windows && typeof sample.windows === 'object') {
    for (const [key, value] of Object.entries(sample.windows)) {
      const cleaned = cleanClaudeWindow(value);
      if (cleaned) windows[key] = cleaned;
    }
  }
  return windows;
}

function claudeMetric(
  key: string,
  window: ClaudeWindow,
  capturedAt: string | null,
  now: number,
  staleAfterMs: number,
): UsageMetric {
  const meta = WINDOW_LABELS[key] ?? {
    id: `window_${key}`,
    label: key,
  };
  const freshness = withFreshness(
    {
      used: window.usedPercentage,
      remaining: 100 - window.usedPercentage,
      resetsAt:
        window.resetsAt !== undefined ? resetIso(window.resetsAt) : undefined,
    },
    capturedAt,
    now,
    staleAfterMs,
  );
  return {
    id: meta.id,
    kind: 'quota',
    unit: 'percent',
    window: { label: meta.label, durationSeconds: meta.seconds },
    ...freshness,
  };
}

async function readStoredClaude(
  filePath: string,
): Promise<StoredClaudeSample | null> {
  let handle;
  try {
    handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const buffer = Buffer.alloc(SANITIZED_USAGE_MAX_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > SANITIZED_USAGE_MAX_BYTES) return null;
    const parsed = JSON.parse(
      buffer.subarray(0, bytesRead).toString('utf8'),
    ) as StoredClaudeSample;
    return parsed?.provider === 'claude' ? parsed : null;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function claudeCollectorSource(destination: string): string {
  const MAX_INPUT_BYTES = CLAUDE_USAGE_INPUT_MAX_BYTES;
  const MAX_STORED_BYTES = SANITIZED_USAGE_MAX_BYTES;
  const OBSERVATION_REFRESH_MS = CLAUDE_OBSERVATION_REFRESH_MS;
  const MIN_RESET_SECONDS = MIN_PROVIDER_EPOCH_SECONDS;
  const MAX_RESET_SECONDS = MAX_PROVIDER_EPOCH_SECONDS;
  return `const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const MAX_INPUT_BYTES = ${MAX_INPUT_BYTES};
const MAX_STORED_BYTES = ${MAX_STORED_BYTES};
const OBSERVATION_REFRESH_MS = ${OBSERVATION_REFRESH_MS};
const MIN_RESET_SECONDS = ${MIN_RESET_SECONDS};
const MAX_RESET_SECONDS = ${MAX_RESET_SECONDS};
const destination = ${JSON.stringify(destination)};
let chunks = [];
let inputBytes = 0;
let oversized = false;
let temporary;
const writeResult = (result) => {
  try {
    const serialized = JSON.stringify(result, null, 2) + '\\n';
    if (Buffer.byteLength(serialized) > MAX_STORED_BYTES) return;
    const directory = path.dirname(destination);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(directory, 0o700);
    temporary = destination + '.' + process.pid + '.' + crypto.randomUUID() + '.tmp';
    const descriptor = fs.openSync(temporary, 'wx', 0o600);
    try {
      fs.writeFileSync(descriptor, serialized);
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
};
const cleanWindow = (value) => {
  if (!value || typeof value !== 'object') return undefined;
  const percentage = value.used_percentage;
  if (typeof percentage !== 'number' || !Number.isFinite(percentage)) return undefined;
  if (percentage < 0 || percentage > 100) return undefined;
  const result = { usedPercentage: percentage };
  const reset = value.resets_at;
  if (typeof reset === 'number' && Number.isInteger(reset) && reset >= MIN_RESET_SECONDS && reset <= MAX_RESET_SECONDS)
    result.resetsAt = reset;
  return result;
};
const cleanStoredWindow = (value) => {
  if (!value || typeof value !== 'object') return undefined;
  if (typeof value.usedPercentage !== 'number' || !Number.isFinite(value.usedPercentage)) return undefined;
  const result = { usedPercentage: value.usedPercentage };
  if (typeof value.resetsAt === 'number' && Number.isInteger(value.resetsAt) && value.resetsAt >= MIN_RESET_SECONDS && value.resetsAt <= MAX_RESET_SECONDS)
    result.resetsAt = value.resetsAt;
  return result;
};
const readPreviousWindows = () => {
  let descriptor;
  try {
    descriptor = fs.openSync(destination, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const buffer = Buffer.alloc(MAX_STORED_BYTES + 1);
    const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
    if (bytesRead <= MAX_STORED_BYTES) {
      const stored = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
      if (stored && stored.provider === 'claude' && stored.status === undefined) {
        const windows = {};
        for (const key of ['five_hour', 'seven_day']) {
          const cleaned = cleanStoredWindow(stored.windows && stored.windows[key]);
          if (cleaned) windows[key] = cleaned;
        }
        for (const [key, value] of Object.entries({
          five_hour: stored.fiveHour,
          seven_day: stored.week,
        })) {
          const cleaned = cleanStoredWindow(value);
          if (cleaned) windows[key] = cleaned;
        }
        return { windows, capturedAt: typeof stored.capturedAt === 'string' ? Date.parse(stored.capturedAt) : undefined };
      }
    }
  } catch {
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
  return undefined;
};
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
  if (oversized) {
    writeResult({ provider: 'claude', status: 'error', reason: 'oversized_input', capturedAt: new Date().toISOString() });
    return;
  }
  const observedAt = Date.now();
  let data;
  try {
    data = JSON.parse(Buffer.concat(chunks, inputBytes).toString('utf8'));
  } catch {
    writeResult({ provider: 'claude', status: 'error', reason: 'invalid_json', capturedAt: new Date(observedAt).toISOString() });
    return;
  }
  chunks = [];
  const limits = data && data.rate_limits;
  if (!limits || typeof limits !== 'object') {
    writeResult({ provider: 'claude', status: 'error', reason: 'no_rate_limits', capturedAt: new Date(observedAt).toISOString() });
    return;
  }
  const windows = {};
  for (const key of Object.keys(limits)) {
    const cleaned = cleanWindow(limits[key]);
    if (cleaned) windows[key] = cleaned;
  }
  if (Object.keys(windows).length === 0) {
    writeResult({ provider: 'claude', status: 'error', reason: 'invalid_rate_limits', capturedAt: new Date(observedAt).toISOString() });
    return;
  }
  const previous = readPreviousWindows();
  if (previous && JSON.stringify(previous.windows) === JSON.stringify(windows)
      && previous.capturedAt !== undefined && previous.capturedAt <= observedAt
      && observedAt - previous.capturedAt < OBSERVATION_REFRESH_MS) return;
  writeResult({
    provider: 'claude',
    capturedAt: new Date(observedAt).toISOString(),
    windows,
  });
});
`;
}

export async function claudePrepareUsage(
  context: UsageCollectionContext,
): Promise<UsagePreparation> {
  const projectRoot = context.projectRoot;
  const runtime = relayPath(projectRoot, 'runtime');
  await mkdir(runtime, { recursive: true, mode: 0o700 });
  await chmod(runtime, 0o700).catch(() => undefined);
  const collectorPath = relayPath(projectRoot, 'runtime', 'claude-usage.cjs');
  const settingsPath = relayPath(
    projectRoot,
    'runtime',
    'claude-settings.json',
  );
  const destination = claudeProviderUsagePath(context);
  await writeFile(collectorPath, claudeCollectorSource(destination), {
    encoding: 'utf8',
    mode: 0o600,
  });
  await chmod(collectorPath, 0o600).catch(() => undefined);
  const quote = (value: string) =>
    process.platform === 'win32'
      ? `"${value.replaceAll('"', '""')}"`
      : `'${value.replaceAll("'", "'\\''")}'`;
  const lifecycleCommand = (state: string) =>
    process.platform === 'win32'
      ? `if defined RIREI_TERMINAL_ID if defined RIREI_NODE_PATH if defined RIREI_LIFECYCLE_HOOK "%RIREI_NODE_PATH%" "%RIREI_LIFECYCLE_HOOK%" ${state}`
      : `if [ -n "$RIREI_TERMINAL_ID" ] && [ -n "$RIREI_NODE_PATH" ] && [ -n "$RIREI_LIFECYCLE_HOOK" ]; then "$RIREI_NODE_PATH" "$RIREI_LIFECYCLE_HOOK" ${state}; fi`;
  await writeFile(
    settingsPath,
    `${JSON.stringify(
      {
        statusLine: {
          type: 'command',
          command: `${quote(process.execPath)} ${quote(collectorPath)}`,
        },
        hooks: {
          PermissionRequest: [
            {
              matcher: '',
              hooks: [
                {
                  type: 'command',
                  command: lifecycleCommand('needs_permission'),
                  timeout: 2,
                },
              ],
            },
          ],
          PreToolUse: [
            {
              matcher: 'AskUserQuestion',
              hooks: [
                {
                  type: 'command',
                  command: lifecycleCommand('waiting_for_input'),
                  timeout: 2,
                },
              ],
            },
          ],
        },
      },
      null,
      2,
    )}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );
  await chmod(settingsPath, 0o600);
  return {
    providerSettingsPath: settingsPath,
    preparedAt: new Date().toISOString(),
  };
}

export async function claudeReadUsage(
  context: UsageCollectionContext,
): Promise<ProviderUsageSnapshot[]> {
  const now = (context.now ?? new Date()).getTime();
  const staleAfterMs = context.staleAfterMs ?? PLAN_USAGE_STALE_MS;
  const globalPath = claudeProviderUsagePath(context);
  const localPath = relayPath(
    context.projectRoot,
    'provider-usage',
    'claude.json',
  );
  const candidates =
    path.resolve(globalPath) === path.resolve(localPath)
      ? [globalPath]
      : [globalPath, localPath];
  for (const candidate of candidates) {
    const sample = await readStoredClaude(candidate);
    if (!sample) continue;
    const capturedAt = validCapturedAt(sample.capturedAt);
    if (sample.status === 'error') {
      return [
        {
          adapterId: 'claude',
          status: 'error',
          capturedAt,
          source: 'Claude Code status line',
          metrics: [],
          detail:
            typeof sample.reason === 'string'
              ? `The Claude usage collector reported an invalid sample (${sample.reason}).`
              : 'The Claude usage collector reported an invalid sample.',
        },
      ];
    }
    const windows = storedWindows(sample);
    const metrics = Object.entries(windows).map(([key, window]) =>
      claudeMetric(key, window, capturedAt, now, staleAfterMs),
    );
    if (metrics.length === 0)
      return [
        {
          adapterId: 'claude',
          status: 'unknown',
          capturedAt,
          source: 'Claude Code status line',
          metrics: [],
          detail: 'No valid Claude quota windows were recorded.',
        },
      ];
    const available = metrics.some((metric) => metric.status === 'available');
    return [
      {
        adapterId: 'claude',
        status: available ? 'available' : 'stale',
        capturedAt,
        source: 'Claude Code status line',
        metrics,
        detail: 'Official Claude.ai subscriber rate-limit fields.',
      },
    ];
  }
  return [
    {
      adapterId: 'claude',
      status: 'unknown',
      capturedAt: null,
      source: 'Claude Code status line',
      metrics: [],
      detail: 'Start Claude and send one prompt to populate plan usage.',
    },
  ];
}

interface CodexRateWindow {
  used_percent?: unknown;
  window_minutes?: unknown;
  resets_at?: unknown;
}

interface CodexRecord {
  capturedAt: string;
  planType: string | null;
  windows: Array<{
    usedPercent: number;
    minutes: number;
    resetsAt?: string;
  }>;
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

function codexWindow(value: CodexRateWindow | null | undefined):
  | {
      usedPercent: number;
      minutes: number;
      resetsAt?: string;
    }
  | undefined {
  if (!value || !validPercentage(value.used_percent)) return undefined;
  if (
    typeof value.window_minutes !== 'number' ||
    !Number.isFinite(value.window_minutes) ||
    !Number.isInteger(value.window_minutes) ||
    value.window_minutes > 525_600 ||
    value.window_minutes <= 0
  )
    return undefined;
  return {
    usedPercent: value.used_percent,
    minutes: value.window_minutes,
    resetsAt:
      value.resets_at !== undefined
        ? (resetIso(value.resets_at) ?? undefined)
        : undefined,
  };
}

async function listRolloutFiles(codexHome: string): Promise<string[]> {
  const sessions = path.join(codexHome, 'sessions');
  let pending = [sessions];
  const files: Array<{ file: string; mtime: number }> = [];
  let visitedEntries = 0;
  try {
    while (pending.length > 0 && visitedEntries < CODEX_TRAVERSAL_FILE_CAP) {
      const current = pending.pop()!;
      const entries = await readdir(current, { withFileTypes: true });
      for (const entry of entries) {
        visitedEntries += 1;
        if (visitedEntries > CODEX_TRAVERSAL_FILE_CAP) break;
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          pending = [...pending, full];
        } else if (/^rollout-.*\.jsonl$/.test(entry.name)) {
          try {
            const metadata = await stat(full);
            files.push({ file: full, mtime: metadata.mtimeMs });
          } catch {
            // Skip unreadable rollout files.
          }
        }
      }
    }
  } catch {
    return [];
  }
  return files
    .sort(
      (left, right) =>
        right.mtime - left.mtime || right.file.localeCompare(left.file),
    )
    .slice(0, CODEX_ROLLOUT_FILE_LIMIT)
    .map((entry) => entry.file);
}

async function readCodexRecord(filePath: string): Promise<CodexRecord | null> {
  try {
    const contents = await readFileTail(filePath);
    let newest: CodexRecord | null = null;
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
      if (parsed.type !== 'event_msg' || parsed.payload?.type !== 'token_count')
        continue;
      const capturedAt = validCapturedAt(parsed.timestamp);
      const limits = parsed.payload.rate_limits;
      if (!capturedAt || !limits) continue;
      const windows = [];
      for (const candidate of [limits.primary, limits.secondary]) {
        const window = codexWindow(candidate);
        if (window) windows.push(window);
      }
      if (windows.length === 0) continue;
      const candidate: CodexRecord = {
        capturedAt,
        planType:
          typeof limits.plan_type === 'string' &&
          /^[a-zA-Z0-9_-]{1,32}$/.test(limits.plan_type)
            ? limits.plan_type
            : null,
        windows,
      };
      if (!newest || capturedAt > newest.capturedAt) newest = candidate;
    }
    return newest;
  } catch {
    return null;
  }
}

export async function codexReadUsage(
  context: UsageCollectionContext,
): Promise<ProviderUsageSnapshot[]> {
  const now = (context.now ?? new Date()).getTime();
  const staleAfterMs = context.staleAfterMs ?? PLAN_USAGE_STALE_MS;
  const codexHome =
    context.codexHome ??
    (process.env.CODEX_HOME || path.join(context.home ?? homedir(), '.codex'));
  const files = await listRolloutFiles(codexHome);
  let newest: CodexRecord | null = null;
  for (const file of files) {
    const record = await readCodexRecord(file);
    if (!record) continue;
    if (!newest || record.capturedAt > newest.capturedAt) newest = record;
  }
  if (!newest) return [];
  const metrics = newest.windows.map((window): UsageMetric => {
    const minutes = window.minutes;
    const meta =
      minutes === 300
        ? { id: 'fiveHour', label: '5-hour', seconds: 5 * 60 * 60 }
        : minutes === 10080
          ? { id: 'week', label: 'Weekly', seconds: 7 * 24 * 60 * 60 }
          : {
              id: `window_${minutes}m`,
              label: `${minutes}m`,
              seconds: minutes * 60,
            };
    const freshness = withFreshness(
      {
        used: window.usedPercent,
        remaining: 100 - window.usedPercent,
        resetsAt: window.resetsAt,
      },
      newest.capturedAt,
      now,
      staleAfterMs,
    );
    return {
      id: meta.id,
      kind: 'quota',
      unit: 'percent',
      window: { label: meta.label, durationSeconds: meta.seconds },
      ...freshness,
    };
  });
  const available = metrics.some((metric) => metric.status === 'available');
  return [
    {
      adapterId: 'codex',
      status: available ? 'available' : 'stale',
      capturedAt: newest.capturedAt,
      source: 'Codex CLI session telemetry (local)',
      metrics,
      detail: newest.planType
        ? `Rate-limit fields Codex recorded for your ChatGPT ${newest.planType} plan.`
        : 'Rate-limit fields recorded by the Codex CLI.',
    },
  ];
}

/** Read raw Codex quota windows for direct tests and diagnostics. */
export async function readCodexUsageRaw(
  context: UsageCollectionContext,
): Promise<CodexRecord | null> {
  const codexHome =
    context.codexHome ??
    (process.env.CODEX_HOME || path.join(context.home ?? homedir(), '.codex'));
  const files = await listRolloutFiles(codexHome);
  let newest: CodexRecord | null = null;
  for (const file of files) {
    const record = await readCodexRecord(file);
    if (!record) continue;
    if (!newest || record.capturedAt > newest.capturedAt) newest = record;
  }
  return newest;
}

export async function readStoredClaudeSample(
  context: UsageCollectionContext,
): Promise<StoredClaudeSample | null> {
  return readStoredClaude(claudeProviderUsagePath(context));
}
