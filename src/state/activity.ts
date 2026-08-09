import { createHash, randomUUID } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { readConfig } from '../config/loader.js';
import {
  readProviderPlanUsage,
  type ProviderPlanUsage,
} from '../plan-usage.js';
import { rireiDataHome } from '../worktrees/data-dir.js';
import { readRegistry } from '../worktrees/registry.js';
import type { WorkspaceRole } from '../worktrees/schema.js';
import type { RelayState, RunLease } from './schema.js';
import { readState } from './store.js';

export const LATEST_ACTIVITY_SCHEMA = 1;
export const ACTIVITY_SESSION_LIMIT = 128;
export const ACTIVITY_PROJECT_LIMIT = 128;
export const ACTIVITY_STRING_LIMIT = 160;
export const COMPLETED_SESSION_RETENTION_MS = 30_000;

const ACTIVITY_FILE = 'activity.json';
const SOURCES_FILE = 'activity-sources.json';
const LOCK_DIRECTORY = 'activity.lock';
const GATE_DIRECTORY = 'activity.lock.gate';
const LOCK_META = 'owner.json';
const ACQUIRE_ATTEMPTS = 200;
const ACQUIRE_INTERVAL_MS = 25;
const HEARTBEAT_INTERVAL_MS = 5_000;
const ACTIVE_SESSION_STALE_MS = 15_000;
const TEMP_STALE_AFTER_MS = 60_000;
const TEMP_FILE_PATTERN =
  /^\.activity(?:-sources|-source-[0-9a-f]{64})?\.json\.[0-9a-f-]{36}\.tmp$/;
const SOURCE_FILE_PATTERN = /^activity-source-([0-9a-f]{64})\.json$/;
const MAX_SUPPORT_FILE_BYTES = 1_000_000;
const USAGE_CACHE_MS = 60_000;

const agentSchema = z.enum(['claude', 'codex', 'gemini', 'antigravity']);
const roleSchema = z.enum(['implement', 'review', 'verify', 'investigate']);
const statusSchema = z.enum([
  'starting',
  'working',
  'waiting',
  'needs_attention',
  'completed',
  'cancelled',
  'failed',
  'orphaned',
]);
const boundedString = z.string().min(1).max(ACTIVITY_STRING_LIMIT);
const usageSchema = z
  .object({
    window: z.enum(['five_hour', 'week']),
    remainingPercentage: z.number().min(0).max(100),
    resetsAt: z.string().datetime().nullable(),
    fresh: z.boolean(),
  })
  .strict();
const activitySessionSchema = z
  .object({
    id: boundedString,
    runId: boundedString,
    workspaceId: boundedString,
    agent: agentSchema,
    projectLabel: boundedString,
    taskLabel: boundedString,
    branchLabel: boundedString,
    role: roleSchema,
    status: statusSchema,
    message: boundedString.optional(),
    startedAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    needsAttention: z.boolean(),
    usage: usageSchema.optional(),
  })
  .strict();

export const activitySnapshotSchema = z
  .object({
    schemaVersion: z.literal(LATEST_ACTIVITY_SCHEMA),
    instanceId: boundedString,
    updatedAt: z.string().datetime(),
    sessions: z.array(activitySessionSchema).max(ACTIVITY_SESSION_LIMIT),
  })
  .strict();

export type RireiActivitySession = z.infer<typeof activitySessionSchema>;
export type RireiActivitySnapshotV1 = z.infer<typeof activitySnapshotSchema>;

const sourceRegistrySchema = z
  .object({
    schemaVersion: z.literal(1),
    sources: z
      .array(
        z
          .object({
            key: z.string().regex(/^[0-9a-f]{64}$/),
            updatedAt: z.string().datetime(),
          })
          .strict(),
      )
      .max(ACTIVITY_PROJECT_LIMIT),
  })
  .strict();
type SourceRegistry = z.infer<typeof sourceRegistrySchema>;
const sourceSnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    key: z.string().regex(/^[0-9a-f]{64}$/),
    updatedAt: z.string().datetime(),
    sessions: z.array(activitySessionSchema).max(ACTIVITY_SESSION_LIMIT),
  })
  .strict();

interface LockOwner {
  token: string;
  pid: number;
  host: string;
  acquiredAt: string;
}

const heartbeatTimers = new Map<string, NodeJS.Timeout>();
const heartbeatInFlight = new Set<string>();
const usageCache = new Map<
  string,
  {
    readAt: number;
    byAgent: Map<RireiActivitySession['agent'], RireiActivitySession['usage']>;
  }
>();

export function activityDataHome(): string {
  const override = process.env.RIREI_DATA_HOME?.trim();
  if (override)
    return path.isAbsolute(override)
      ? path.resolve(override)
      : path.resolve(homedir(), override);
  if (process.platform === 'darwin')
    return path.join(homedir(), 'Library', 'Application Support', 'Rirei');
  return rireiDataHome();
}

export function activityFilePath(): string {
  return path.join(activityDataHome(), ACTIVITY_FILE);
}

function sourceFilePath(): string {
  return path.join(activityDataHome(), SOURCES_FILE);
}

function projectSourceFilePath(key: string): string {
  return path.join(activityDataHome(), `activity-source-${key}.json`);
}

async function ensureDataHome(): Promise<void> {
  const directory = activityDataHome();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const details = await lstat(directory);
  if (!details.isDirectory() || details.isSymbolicLink())
    throw new Error('The Rirei activity data home must be a real directory.');
  await chmod(directory, 0o700);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function readOwner(directory: string): Promise<LockOwner | undefined> {
  try {
    const parsed = JSON.parse(
      await readFile(path.join(directory, LOCK_META), 'utf8'),
    ) as Partial<LockOwner>;
    if (
      typeof parsed.token === 'string' &&
      typeof parsed.pid === 'number' &&
      typeof parsed.host === 'string' &&
      typeof parsed.acquiredAt === 'string'
    )
      return parsed as LockOwner;
  } catch {
    // A claim is prepared completely before rename, so unreadable live lock
    // metadata is conservatively treated as owned.
  }
  return undefined;
}

function lockIsStale(owner: LockOwner | undefined): boolean {
  return Boolean(
    owner && owner.host === hostname() && !processIsAlive(owner.pid),
  );
}

async function createOwnedDirectory(directory: string): Promise<LockOwner> {
  const owner: LockOwner = {
    token: randomUUID(),
    pid: process.pid,
    host: hostname(),
    acquiredAt: new Date().toISOString(),
  };
  const claim = `${directory}.claim-${owner.token}`;
  await mkdir(claim, { mode: 0o700 });
  try {
    await writeFile(path.join(claim, LOCK_META), JSON.stringify(owner), {
      mode: 0o600,
    });
    await rename(claim, directory);
  } catch (error) {
    await rm(claim, { recursive: true, force: true });
    if ((error as NodeJS.ErrnoException).code === 'ENOTEMPTY')
      (error as NodeJS.ErrnoException).code = 'EEXIST';
    throw error;
  }
  return owner;
}

async function removeIfOwned(
  directory: string,
  owner: LockOwner,
): Promise<void> {
  if ((await readOwner(directory))?.token !== owner.token) return;
  try {
    await rm(directory, { recursive: true, force: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (
      (code === 'ENOTEMPTY' || code === 'EEXIST') &&
      (await readOwner(directory))?.token !== owner.token
    )
      return;
    throw error;
  }
}

async function acquireGate(): Promise<LockOwner> {
  const directory = path.join(activityDataHome(), GATE_DIRECTORY);
  for (let attempt = 0; attempt < ACQUIRE_ATTEMPTS; attempt += 1) {
    try {
      return await createOwnedDirectory(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const owner = await readOwner(directory);
      if (lockIsStale(owner) && owner) {
        await removeIfOwned(directory, owner);
        continue;
      }
      await delay(ACQUIRE_INTERVAL_MS);
    }
  }
  throw new Error('Another Rirei process is updating the activity feed.');
}

async function acquireActivityLock(): Promise<LockOwner> {
  await ensureDataHome();
  const directory = path.join(activityDataHome(), LOCK_DIRECTORY);
  const gateDirectory = path.join(activityDataHome(), GATE_DIRECTORY);
  for (let attempt = 0; attempt < ACQUIRE_ATTEMPTS; attempt += 1) {
    const gate = await acquireGate();
    let busy = false;
    try {
      try {
        return await createOwnedDirectory(directory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const owner = await readOwner(directory);
        if (lockIsStale(owner)) {
          await rm(directory, { recursive: true, force: true });
          return await createOwnedDirectory(directory);
        }
        busy = true;
      }
    } finally {
      await removeIfOwned(gateDirectory, gate);
    }
    if (busy) await delay(ACQUIRE_INTERVAL_MS);
  }
  throw new Error('Another Rirei process is holding the activity writer lock.');
}

async function withActivityLock<T>(operation: () => Promise<T>): Promise<T> {
  const owner = await acquireActivityLock();
  const directory = path.join(activityDataHome(), LOCK_DIRECTORY);
  const gateDirectory = path.join(activityDataHome(), GATE_DIRECTORY);
  try {
    return await operation();
  } finally {
    const gate = await acquireGate();
    try {
      await removeIfOwned(directory, owner);
    } finally {
      await removeIfOwned(gateDirectory, gate);
    }
  }
}

function parseJson(contents: string): unknown {
  try {
    return JSON.parse(contents);
  } catch {
    return undefined;
  }
}

async function readRaw(file: string): Promise<unknown> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(file, 'r');
    const details = await handle.stat();
    if (!details.isFile() || details.size > MAX_SUPPORT_FILE_BYTES)
      return undefined;
    return parseJson(await handle.readFile('utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  } finally {
    await handle?.close();
  }
}

function rejectFutureSchema(raw: unknown, label: string): void {
  if (
    raw &&
    typeof raw === 'object' &&
    !Array.isArray(raw) &&
    typeof (raw as { schemaVersion?: unknown }).schemaVersion === 'number' &&
    (raw as { schemaVersion: number }).schemaVersion > LATEST_ACTIVITY_SCHEMA
  )
    throw new Error(
      `${label} schema v${(raw as { schemaVersion: number }).schemaVersion} is newer than this build supports.`,
    );
}

export async function readActivity(): Promise<
  RireiActivitySnapshotV1 | undefined
> {
  const raw = await readRaw(activityFilePath());
  const parsed = activitySnapshotSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

async function readSources(): Promise<SourceRegistry> {
  const raw = await readRaw(sourceFilePath());
  rejectFutureSchema(raw, 'Rirei activity source registry');
  const parsed = sourceRegistrySchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  const entries = await readdir(activityDataHome(), { withFileTypes: true });
  const recovered: SourceRegistry['sources'] = [];
  for (const entry of entries) {
    const match = entry.isFile() && SOURCE_FILE_PATTERN.exec(entry.name);
    if (!match) continue;
    const recoveredKey = match[1];
    if (!recoveredKey) continue;
    const source = sourceSnapshotSchema.safeParse(
      await readRaw(projectSourceFilePath(recoveredKey)),
    );
    if (source.success && source.data.key === recoveredKey)
      recovered.push({
        key: source.data.key,
        updatedAt: source.data.updatedAt,
      });
  }
  return sourceRegistrySchema.parse({
    schemaVersion: 1,
    sources: recovered
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, ACTIVITY_PROJECT_LIMIT),
  });
}

async function atomicWrite(file: string, value: unknown): Promise<void> {
  const temporary = path.join(
    activityDataHome(),
    `.${path.basename(file)}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    await rename(temporary, file);
    await chmod(file, 0o600);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function sweepTemporaryFiles(): Promise<void> {
  const now = Date.now();
  const entries = await readdir(activityDataHome(), { withFileTypes: true });
  await Promise.all(
    entries
      .filter((entry) => entry.isFile() && TEMP_FILE_PATTERN.test(entry.name))
      .map(async (entry) => {
        const candidate = path.join(activityDataHome(), entry.name);
        try {
          const details = await lstat(candidate);
          if (now - details.mtimeMs > TEMP_STALE_AFTER_MS)
            await rm(candidate, { force: true });
        } catch {
          // Concurrent cleanup or replacement already removed it.
        }
      }),
  );
}

function sourceKey(projectRoot: string): string {
  return createHash('sha256').update(path.resolve(projectRoot)).digest('hex');
}

function safeValue(value: string, fallback: string): string {
  const normalized = Array.from(value, (character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f ? ' ' : character;
  })
    .join('')
    .trim();
  if (
    !normalized ||
    path.isAbsolute(normalized) ||
    normalized.startsWith('file://') ||
    /(?:^|[^a-z0-9._-])\/(?!\/)[^\s"'`,)]+/i.test(normalized) ||
    /[a-z]:\\[^\s]+/i.test(normalized) ||
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/i.test(normalized) ||
    /\b(?:sk-(?:proj-)?[a-z0-9_-]{8,}|gh[pousr]_[a-z0-9_]{8,}|github_pat_[a-z0-9_]{8,}|xox[baprs]-[a-z0-9-]{8,}|AIza[a-z0-9_-]{16,}|eyJ[a-z0-9_-]{8,}\.[a-z0-9_-]{8,})/i.test(
      normalized,
    ) ||
    /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/.test(normalized) ||
    /\b(?:api[_-]?key|access[_-]?token|secret|password|authorization)\b\s*[:=]/i.test(
      normalized,
    )
  )
    return fallback;
  return normalized.slice(0, ACTIVITY_STRING_LIMIT);
}

function fixedMessage(status: RireiActivitySession['status']): string {
  switch (status) {
    case 'starting':
      return 'Starting agent';
    case 'working':
      return 'Agent is working';
    case 'waiting':
      return 'Agent is waiting';
    case 'needs_attention':
      return 'Agent needs attention';
    case 'completed':
      return 'Run completed';
    case 'cancelled':
      return 'Run cancelled';
    case 'failed':
      return 'Run failed';
    case 'orphaned':
      return 'Run ownership is uncertain';
  }
}

export function selectActivityUsage(
  provider: ProviderPlanUsage,
): RireiActivitySession['usage'] {
  const candidates = [
    provider.fiveHour
      ? { window: 'five_hour' as const, value: provider.fiveHour }
      : undefined,
    provider.week
      ? { window: 'week' as const, value: provider.week }
      : undefined,
  ].filter((candidate) => candidate !== undefined);
  candidates.sort(
    (left, right) =>
      Number(left.value.status !== 'available') -
        Number(right.value.status !== 'available') ||
      left.value.remainingPercentage - right.value.remainingPercentage ||
      (left.window === 'five_hour' ? -1 : 1),
  );
  const selected = candidates[0];
  if (!selected) return undefined;
  return {
    window: selected.window,
    remainingPercentage: selected.value.remainingPercentage,
    resetsAt: selected.value.resetsAt,
    fresh: selected.value.status === 'available',
  };
}

async function projectUsage(
  projectRoot: string,
  now: number,
): Promise<Map<RireiActivitySession['agent'], RireiActivitySession['usage']>> {
  const key = path.resolve(projectRoot);
  const cached = usageCache.get(key);
  if (cached && now - cached.readAt < USAGE_CACHE_MS) return cached.byAgent;

  const isolatedHome = process.env.RIREI_PROVIDER_USAGE_HOME?.trim();
  const providers = await readProviderPlanUsage(
    projectRoot,
    isolatedHome
      ? {
          home: path.resolve(isolatedHome),
          codexHome: path.join(path.resolve(isolatedHome), '.codex'),
          now: new Date(now),
        }
      : { now: new Date(now) },
  ).catch(() => []);
  const byAgent = new Map<
    RireiActivitySession['agent'],
    RireiActivitySession['usage']
  >();
  for (const provider of providers) {
    const agent = agentSchema.safeParse(provider.id);
    const usage = selectActivityUsage(provider);
    if (agent.success && usage) byAgent.set(agent.data, usage);
  }
  usageCache.set(key, { readAt: now, byAgent });
  return byAgent;
}

export function mapLeaseStatus(
  status: RunLease['status'],
): RireiActivitySession['status'] {
  switch (status) {
    case 'starting':
      return 'starting';
    case 'running':
    case 'stopping':
      return 'working';
    case 'waiting':
      return 'waiting';
    case 'orphaned':
      return 'orphaned';
  }
}

function historyStatus(
  reason: string | undefined,
): RireiActivitySession['status'] {
  if (reason === 'completed') return 'completed';
  if (reason === 'user_cancelled' || reason === 'interrupted')
    return 'cancelled';
  return 'failed';
}

async function projectSessions(
  projectRoot: string,
  state: RelayState,
  now: number,
): Promise<RireiActivitySession[]> {
  const usageByAgent = await projectUsage(projectRoot, now);
  let privacyMode = true;
  try {
    privacyMode = (await readConfig(projectRoot)).activity.privacyMode;
  } catch {
    // Fail closed when privacy settings cannot be established.
  }
  let workspaces: Awaited<ReturnType<typeof readRegistry>>['workspaces'] = [];
  try {
    workspaces = (await readRegistry(projectRoot)).workspaces;
  } catch {
    // State metadata still permits a safe projection when the registry is gone.
  }
  const projectLabel = privacyMode
    ? 'Project'
    : safeValue(path.basename(projectRoot), 'Project');
  const taskLabel = privacyMode ? 'Task' : safeValue(state.task.title, 'Task');
  const mainBranch = safeValue(
    state.git.currentBranch ?? state.git.startingBranch,
    'main',
  );
  const workspaceMetadata = (
    workspaceId: string | undefined,
    branchLabel: string | undefined,
    role: WorkspaceRole | undefined,
  ): { workspaceId: string; branchLabel: string; role: WorkspaceRole } => {
    const workspace = workspaceId
      ? workspaces.find(
          (candidate) =>
            candidate.id === workspaceId &&
            candidate.parentTaskId === state.sessionId,
        )
      : undefined;
    return {
      workspaceId: safeValue(workspaceId ?? 'main', 'main'),
      branchLabel: privacyMode
        ? 'Branch'
        : safeValue(workspace?.branch ?? branchLabel ?? mainBranch, 'Branch'),
      role: workspace?.role ?? role ?? 'implement',
    };
  };
  const sessions: RireiActivitySession[] = [];
  const projectionTime = new Date(now).toISOString();
  for (const lease of state.runs) {
    if (!lease.terminalId) continue;
    const agent = agentSchema.safeParse(lease.agent);
    if (!agent.success) continue;
    const metadata = workspaceMetadata(
      lease.workspaceId,
      lease.branchLabel,
      lease.role,
    );
    const status = mapLeaseStatus(lease.status);
    const usage = usageByAgent.get(agent.data);
    sessions.push({
      id: safeValue(lease.terminalId, 'session'),
      runId: safeValue(lease.runId, 'run'),
      workspaceId: metadata.workspaceId,
      agent: agent.data,
      projectLabel,
      taskLabel,
      branchLabel: metadata.branchLabel,
      role: metadata.role,
      status,
      message: fixedMessage(status),
      startedAt: lease.startedAt,
      updatedAt: projectionTime,
      needsAttention: status === 'orphaned' || status === 'needs_attention',
      ...(usage ? { usage } : {}),
    });
  }
  for (const run of state.agentHistory) {
    if (!run.id || !run.terminalId || !run.endedAt) continue;
    const endedAt = Date.parse(run.endedAt);
    if (
      !Number.isFinite(endedAt) ||
      now - endedAt > COMPLETED_SESSION_RETENTION_MS
    )
      continue;
    if (sessions.some((session) => session.runId === run.id)) continue;
    const agent = agentSchema.safeParse(run.agent);
    if (!agent.success) continue;
    const metadata = workspaceMetadata(
      run.workspaceId,
      run.branchLabel,
      run.role,
    );
    const status = historyStatus(run.exitReason);
    const usage = usageByAgent.get(agent.data);
    sessions.push({
      id: safeValue(run.terminalId, 'session'),
      runId: safeValue(run.id, 'run'),
      workspaceId: metadata.workspaceId,
      agent: agent.data,
      projectLabel,
      taskLabel,
      branchLabel: metadata.branchLabel,
      role: metadata.role,
      status,
      message: fixedMessage(status),
      startedAt: run.startedAt,
      updatedAt: run.endedAt,
      needsAttention: status === 'failed',
      ...(usage ? { usage } : {}),
    });
  }
  return sessions;
}

const statusPriority: Record<RireiActivitySession['status'], number> = {
  needs_attention: 0,
  failed: 1,
  orphaned: 2,
  starting: 3,
  working: 4,
  waiting: 5,
  completed: 6,
  cancelled: 7,
};

async function publishLocked(
  projectRoot: string,
  currentState: RelayState,
): Promise<RireiActivitySnapshotV1> {
  const existingRaw = await readRaw(activityFilePath());
  rejectFutureSchema(existingRaw, 'Rirei activity snapshot');
  const existing = activitySnapshotSchema.safeParse(existingRaw);
  const nowIso = new Date().toISOString();
  const key = sourceKey(projectRoot);
  const registry = await readSources();
  const projectProjection = sourceSnapshotSchema.parse({
    schemaVersion: 1,
    key,
    updatedAt: nowIso,
    sessions: (
      await projectSessions(projectRoot, currentState, Date.now())
    ).slice(0, ACTIVITY_SESSION_LIMIT),
  });
  await atomicWrite(projectSourceFilePath(key), projectProjection);
  const sources = [
    ...registry.sources.filter((source) => source.key !== key),
    { key, updatedAt: nowIso },
  ]
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, ACTIVITY_PROJECT_LIMIT);
  const validRegistry = sourceRegistrySchema.parse({
    schemaVersion: 1,
    sources,
  });
  await atomicWrite(sourceFilePath(), validRegistry);
  const retainedKeys = new Set(sources.map((source) => source.key));
  await Promise.all(
    registry.sources
      .filter((source) => !retainedKeys.has(source.key))
      .map((source) => rm(projectSourceFilePath(source.key), { force: true })),
  );

  const sessions: RireiActivitySession[] = [];
  const aggregateTime = Date.now();
  for (const source of sources) {
    try {
      const projection = sourceSnapshotSchema.parse(
        source.key === key
          ? projectProjection
          : await readRaw(projectSourceFilePath(source.key)),
      );
      for (const session of projection.sessions) {
        const age = aggregateTime - Date.parse(session.updatedAt);
        if (
          ['completed', 'cancelled', 'failed'].includes(session.status) &&
          age > COMPLETED_SESSION_RETENTION_MS
        )
          continue;
        if (
          ['starting', 'working', 'waiting'].includes(session.status) &&
          age > ACTIVE_SESSION_STALE_MS
        ) {
          sessions.push({
            ...session,
            status: 'needs_attention',
            message: fixedMessage('needs_attention'),
            needsAttention: true,
          });
        } else {
          sessions.push(session);
        }
      }
    } catch {
      // One missing or malformed source cannot poison the global projection.
    }
  }
  sessions.sort(
    (left, right) =>
      statusPriority[left.status] - statusPriority[right.status] ||
      right.updatedAt.localeCompare(left.updatedAt),
  );
  const snapshot = activitySnapshotSchema.parse({
    schemaVersion: LATEST_ACTIVITY_SCHEMA,
    instanceId: existing.success ? existing.data.instanceId : randomUUID(),
    updatedAt: nowIso,
    sessions: sessions.slice(0, ACTIVITY_SESSION_LIMIT),
  });
  await atomicWrite(activityFilePath(), snapshot);
  await sweepTemporaryFiles();
  return snapshot;
}

function hasPublishableSessions(state: RelayState, now = Date.now()): boolean {
  if (state.runs.some((run) => Boolean(run.terminalId))) return true;
  return state.agentHistory.some(
    (run) =>
      Boolean(run.terminalId && run.endedAt) &&
      now - Date.parse(run.endedAt!) <= COMPLETED_SESSION_RETENTION_MS,
  );
}

function updateHeartbeat(projectRoot: string, state: RelayState): void {
  if (!hasPublishableSessions(state)) {
    stopActivityHeartbeat(projectRoot);
    return;
  }
  const key = path.resolve(projectRoot);
  if (heartbeatTimers.has(key)) return;
  const timer = setInterval(() => {
    if (heartbeatInFlight.has(key)) return;
    heartbeatInFlight.add(key);
    void readState(projectRoot)
      .then(async (latest) => {
        await withActivityLock(() => publishLocked(projectRoot, latest));
        if (!hasPublishableSessions(latest)) stopActivityHeartbeat(projectRoot);
      })
      .catch(() => undefined)
      .finally(() => heartbeatInFlight.delete(key));
  }, HEARTBEAT_INTERVAL_MS);
  timer.unref();
  heartbeatTimers.set(key, timer);
}

export function stopActivityHeartbeat(projectRoot: string): void {
  const key = path.resolve(projectRoot);
  const timer = heartbeatTimers.get(key);
  if (timer) clearInterval(timer);
  heartbeatTimers.delete(key);
  heartbeatInFlight.delete(key);
  usageCache.delete(key);
}

export async function syncActivity(
  projectRoot: string,
  state: RelayState,
): Promise<RireiActivitySnapshotV1> {
  updateHeartbeat(projectRoot, state);
  const snapshot = await withActivityLock(() =>
    publishLocked(projectRoot, state),
  );
  return snapshot;
}

/**
 * Compatibility projection hook. Event names and data are deliberately
 * ignored; the public file is rebuilt only from validated Relay state.
 */
export async function appendEvent(
  projectRoot: string,
  type: string,
  data: Record<string, unknown>,
): Promise<void> {
  void type;
  void data;
  try {
    await syncActivity(projectRoot, await readState(projectRoot));
  } catch {
    // Activity publication is best-effort and never owns a product mutation.
  }
}
