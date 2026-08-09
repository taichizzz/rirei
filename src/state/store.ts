import { randomUUID } from 'node:crypto';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { relayPath } from '../safety/path-policy.js';
import {
  LATEST_STATE_SCHEMA,
  OPERATION_LEDGER_LIMIT,
  relayStateSchema,
  type RelayState,
} from './schema.js';
import { migrateState, readSchemaVersion } from './migrations.js';
import { RelayConflictError, withRepositoryLock } from './lock.js';
import { syncActivity } from './activity.js';

const STATE_FILE = 'state.json';
const ARCHIVE_STATE_MAX_BYTES = 2 * 1024 * 1024;
const ARCHIVE_READ_LIMIT = 200;
const TEMP_FILE_PATTERN = new RegExp(
  `^\\.${STATE_FILE}\\.[0-9a-f-]{36}\\.tmp$`,
);
const TEMP_STALE_AFTER_MS = 60_000;

export async function readState(projectRoot: string): Promise<RelayState> {
  const contents = await readFile(relayPath(projectRoot, STATE_FILE), 'utf8');
  return migrateState(JSON.parse(contents));
}

interface UpdateOptions {
  /** Idempotency key; a repeated opId returns current state without mutating. */
  opId?: string;
  /** Optimistic-concurrency guard; rejects if on-disk revision differs. */
  expectedRevision?: number;
}

/**
 * The canonical read-modify-write path. Acquires the repository writer lock,
 * migrates and reads current state, enforces optional revision/opId guards,
 * applies `mutator`, bumps `revision`, and atomically publishes the result.
 */
export async function updateState(
  projectRoot: string,
  mutator: (current: RelayState) => RelayState | Promise<RelayState>,
  options: UpdateOptions = {},
): Promise<RelayState> {
  const next = await withRepositoryLock(projectRoot, async () => {
    const version = await readOnDiskSchemaVersion(projectRoot);
    if (version !== undefined && version < LATEST_STATE_SCHEMA)
      await backupPreMigrationState(projectRoot, version);
    const current = await readState(projectRoot);
    if (
      options.opId &&
      current.recentOperations.some((entry) => entry.opId === options.opId)
    )
      return current;
    if (
      options.expectedRevision !== undefined &&
      options.expectedRevision !== current.revision
    )
      throw new RelayConflictError(
        `Relay state changed underneath this operation ` +
          `(expected revision ${options.expectedRevision}, found ${current.revision}).`,
      );
    const mutated = await mutator(current);
    const revision = current.revision + 1;
    const recentOperations = options.opId
      ? [
          ...current.recentOperations,
          { opId: options.opId, at: new Date().toISOString(), revision },
        ].slice(-OPERATION_LEDGER_LIMIT)
      : current.recentOperations;
    const next: RelayState = { ...mutated, revision, recentOperations };
    await writeState(projectRoot, next);
    await sweepAbandonedTempFiles(projectRoot);
    return next;
  });
  await syncActivity(projectRoot, next).catch(() => undefined);
  return next;
}

/**
 * Replace the current task under the same writer lock used by ordinary state
 * mutations. Existing completed state is archived before the replacement is
 * published, and the repository revision remains monotonic across tasks.
 */
export async function replaceState(
  projectRoot: string,
  replacement: (
    current: RelayState | undefined,
  ) => RelayState | Promise<RelayState>,
): Promise<RelayState> {
  const next = await withRepositoryLock(projectRoot, async () => {
    const version = await readOnDiskSchemaVersion(projectRoot);
    if (version !== undefined && version < LATEST_STATE_SCHEMA)
      await backupPreMigrationState(projectRoot, version);
    let current: RelayState | undefined;
    try {
      current = await readState(projectRoot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const proposed = await replacement(current);
    const next: RelayState = {
      ...proposed,
      revision: current ? current.revision + 1 : 0,
    };
    if (current) await archiveState(projectRoot, normalizeClosedTask(current));
    await writeState(projectRoot, next);
    await sweepAbandonedTempFiles(projectRoot);
    return next;
  });
  await syncActivity(projectRoot, next).catch(() => undefined);
  return next;
}

function normalizeClosedTask(state: RelayState): RelayState {
  if (
    (state.task.status !== 'completed' && state.task.status !== 'cancelled') ||
    state.runs.length > 0
  )
    return state;
  return {
    ...state,
    currentAgent: undefined,
    currentRunId: undefined,
    agentHistory: state.agentHistory.map((run) =>
      run.endedAt
        ? run
        : {
            ...run,
            endedAt: state.task.updatedAt,
            exitCode: null,
            exitReason: 'interrupted',
          },
    ),
  };
}

async function readOnDiskSchemaVersion(
  projectRoot: string,
): Promise<number | undefined> {
  try {
    const contents = await readFile(relayPath(projectRoot, STATE_FILE), 'utf8');
    return readSchemaVersion(JSON.parse(contents));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function backupPreMigrationState(
  projectRoot: string,
  version: number,
): Promise<void> {
  const backups = relayPath(projectRoot, 'backups');
  await ensureSecureDirectory(backups, true);
  const stamp = new Date().toISOString().replaceAll(':', '-');
  await copyFile(
    relayPath(projectRoot, STATE_FILE),
    relayPath(projectRoot, 'backups', `state.v${version}.${stamp}.json`),
  );
}

async function sweepAbandonedTempFiles(projectRoot: string): Promise<void> {
  const directory = relayPath(projectRoot);
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  const now = Date.now();
  await Promise.all(
    entries
      .filter((entry) => entry.isFile() && TEMP_FILE_PATTERN.test(entry.name))
      .map(async (entry) => {
        const candidate = relayPath(projectRoot, entry.name);
        try {
          const details = await lstat(candidate);
          if (details.isFile() && now - details.mtimeMs > TEMP_STALE_AFTER_MS)
            await rm(candidate, { force: true });
        } catch {
          // A temp file vanishing mid-sweep is exactly what we wanted.
        }
      }),
  );
}

export async function writeState(
  projectRoot: string,
  state: RelayState,
): Promise<void> {
  await writeStateFile(
    relayPath(projectRoot, STATE_FILE),
    relayPath(projectRoot, `.${STATE_FILE}.${randomUUID()}.tmp`),
    state,
  );
}

async function writeStateFile(
  destination: string,
  temporary: string,
  state: RelayState,
): Promise<void> {
  const validState = relayStateSchema.parse(state);
  await writeFile(temporary, `${JSON.stringify(validState, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  await rename(temporary, destination);
}

function validateSessionId(sessionId: string): void {
  if (
    sessionId === '.' ||
    sessionId === '..' ||
    sessionId.includes('/') ||
    sessionId.includes('\\')
  )
    throw new Error('Relay session IDs cannot contain path separators.');
}

async function ensureSecureDirectory(
  directory: string,
  recursive: boolean,
): Promise<void> {
  try {
    await mkdir(directory, { recursive, mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const details = await lstat(directory);
  if (!details.isDirectory() || details.isSymbolicLink())
    throw new Error('Relay archive paths must be real directories.');
  await chmod(directory, 0o700);
}

export async function archiveState(
  projectRoot: string,
  state: RelayState,
): Promise<void> {
  if (state.task.status !== 'completed' && state.task.status !== 'cancelled')
    throw new Error('Only completed or cancelled Relay tasks can be archived.');
  validateSessionId(state.sessionId);
  const tasksDirectory = relayPath(projectRoot, 'tasks');
  const sessionDirectory = relayPath(projectRoot, 'tasks', state.sessionId);
  await ensureSecureDirectory(tasksDirectory, true);
  await ensureSecureDirectory(sessionDirectory, false);
  await writeStateFile(
    relayPath(projectRoot, 'tasks', state.sessionId, STATE_FILE),
    relayPath(
      projectRoot,
      'tasks',
      state.sessionId,
      `.${STATE_FILE}.${randomUUID()}.tmp`,
    ),
    state,
  );
  // Retain checkpoint artifacts referenced by the archived task. Deleting them
  // here made history incomplete and turned persisted paths into deletion input.
}

export async function readArchivedStates(
  projectRoot: string,
): Promise<RelayState[]> {
  const tasksDirectory = relayPath(projectRoot, 'tasks');
  let entries;
  try {
    entries = await readdir(tasksDirectory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const states: RelayState[] = [];
  for (const entry of entries
    .filter((candidate) => candidate.isDirectory())
    .slice(-ARCHIVE_READ_LIMIT)) {
    try {
      validateSessionId(entry.name);
      const statePath = relayPath(projectRoot, 'tasks', entry.name, STATE_FILE);
      const details = await lstat(statePath);
      if (
        !details.isFile() ||
        details.isSymbolicLink() ||
        details.size > ARCHIVE_STATE_MAX_BYTES
      )
        continue;
      const contents = await readFile(statePath, 'utf8');
      states.push(relayStateSchema.parse(JSON.parse(contents)));
    } catch {
      // A damaged archive must not hide otherwise readable task history.
    }
  }
  return states;
}
