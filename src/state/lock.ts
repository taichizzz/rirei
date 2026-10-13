import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import path from 'node:path';
import {
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { relayPath } from '../safety/path-policy.js';

const LOCK_META = 'owner.json';
const ACQUIRE_ATTEMPTS = 40;
const ACQUIRE_INTERVAL_MS = 50;

/** Raised when another live Relay process holds the repository writer lock. */
export class RelayLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RelayLockError';
  }
}

/** Raised when persisted state changed out from under an expected revision. */
export class RelayConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RelayConflictError';
  }
}

interface LockOwner {
  token: string;
  pid: number;
  host: string;
  acquiredAt: string;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function removeDirectory(directory: string): Promise<void> {
  await rm(directory, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: ACQUIRE_INTERVAL_MS,
  });
}

async function normalizeDestinationExistsError(
  error: NodeJS.ErrnoException,
  destination: string,
): Promise<void> {
  if (error.code === 'EEXIST' || error.code === 'ENOTEMPTY') {
    error.code = 'EEXIST';
    return;
  }
  if (error.code !== 'EPERM' || process.platform !== 'win32') return;
  try {
    await lstat(destination);
    error.code = 'EEXIST';
  } catch {
    // Preserve a genuine permissions error when no competing lock exists.
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // ESRCH means the process is gone; EPERM means it exists but we cannot
    // signal it, which still counts as alive.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function readOwner(directory: string): Promise<LockOwner | undefined> {
  try {
    const parsed = JSON.parse(
      await readFile(`${directory}/${LOCK_META}`, 'utf8'),
    );
    if (
      parsed &&
      typeof parsed.token === 'string' &&
      typeof parsed.pid === 'number' &&
      typeof parsed.host === 'string' &&
      typeof parsed.acquiredAt === 'string'
    )
      return parsed as LockOwner;
  } catch {
    // Missing or unreadable metadata is treated as an unknown owner below.
  }
  return undefined;
}

function lockIsStale(owner: LockOwner | undefined): boolean {
  // Age alone is never proof that a writer died. Locks can legitimately be
  // held for longer than a timeout while Git or checkpoint work completes.
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
  const claimDirectory = `${directory}.claim-${owner.token}`;
  await mkdir(claimDirectory, { recursive: false, mode: 0o700 });
  try {
    await writeFile(`${claimDirectory}/${LOCK_META}`, JSON.stringify(owner), {
      mode: 0o600,
    });
    await rename(claimDirectory, directory);
  } catch (error) {
    await normalizeDestinationExistsError(
      error as NodeJS.ErrnoException,
      directory,
    );
    await removeDirectory(claimDirectory);
    throw error;
  }
  return owner;
}

async function removeIfOwned(
  directory: string,
  owner: LockOwner,
): Promise<void> {
  const current = await readOwner(directory);
  if (current?.token !== owner.token) return;
  try {
    await removeDirectory(directory);
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

function validateLockName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed || !/^[a-zA-Z0-9_-]+$/.test(trimmed)) {
    throw new Error(
      `Invalid lock name "${name}". Lock names must use letters, numbers, underscores, or dashes.`,
    );
  }
  return trimmed;
}

async function acquireGate(
  lockDir: string,
  lockName = 'state',
): Promise<LockOwner> {
  const directory = path.join(lockDir, `${lockName}.lock.gate`);
  for (let attempt = 0; attempt < ACQUIRE_ATTEMPTS; attempt += 1) {
    try {
      return await createOwnedDirectory(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const current = await readOwner(directory);
      if (lockIsStale(current) && current) {
        await removeIfOwned(directory, current);
        continue;
      }
      await delay(ACQUIRE_INTERVAL_MS);
    }
  }
  throw new RelayLockError(
    `Another Relay process is acquiring or releasing the ${lockName} lock. ` +
      `Wait for it to finish, or remove ${directory} if no Relay is running.`,
  );
}

async function acquire(
  lockDir: string,
  lockName = 'state',
  attempts = ACQUIRE_ATTEMPTS,
): Promise<LockOwner> {
  const directory = path.join(lockDir, `${lockName}.lock`);
  const gateDirectory = path.join(lockDir, `${lockName}.lock.gate`);
  await mkdir(lockDir, { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const gate = await acquireGate(lockDir, lockName);
    let busy = false;
    try {
      try {
        return await createOwnedDirectory(directory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const current = await readOwner(directory);
        if (lockIsStale(current)) {
          // The gate serializes acquire, release, and reclamation, so the owner
          // cannot change between this check and removal.
          await removeDirectory(directory);
          return await createOwnedDirectory(directory);
        }
        busy = true;
      }
    } finally {
      await removeIfOwned(gateDirectory, gate);
    }
    if (busy) await delay(ACQUIRE_INTERVAL_MS);
  }
  throw new RelayLockError(
    `Another Relay process is holding the ${lockName} lock. ` +
      `Wait for it to finish, or remove ${directory} if no Relay is running.`,
  );
}

async function release(
  lockDir: string,
  owner: LockOwner,
  lockName = 'state',
): Promise<void> {
  const gateDirectory = path.join(lockDir, `${lockName}.lock.gate`);
  const gate = await acquireGate(lockDir, lockName);
  try {
    await removeIfOwned(path.join(lockDir, `${lockName}.lock`), owner);
  } finally {
    await removeIfOwned(gateDirectory, gate);
  }
}

/**
 * Run `fn` while holding a named directory-scoped writer lock (e.g. in rireiDataHome or custom directory).
 * `waitMs` lets a caller wait out a holder whose work is known to be long,
 * such as a log scan; the default matches the repository lock (~2s).
 */
export async function withDirectoryLock<T>(
  directory: string,
  name: string,
  fn: () => Promise<T>,
  options: { waitMs?: number } = {},
): Promise<T> {
  const validatedName = validateLockName(name);
  const attempts =
    options.waitMs && options.waitMs > 0
      ? Math.max(1, Math.ceil(options.waitMs / ACQUIRE_INTERVAL_MS))
      : ACQUIRE_ATTEMPTS;
  const owner = await acquire(directory, validatedName, attempts);
  try {
    return await fn();
  } finally {
    await release(directory, owner, validatedName);
  }
}

/**
 * Run `fn` while holding a named repository-scoped writer lock (e.g. `state` or `threads`).
 */
export async function withNamedRepositoryLock<T>(
  root: string,
  name: string,
  fn: () => Promise<T>,
): Promise<T> {
  return withDirectoryLock(relayPath(root), name, fn);
}

/**
 * Run `fn` while holding the repository-scoped writer lock for state mutations.
 * The lock is always released in `finally`, even when `fn` throws.
 */
export async function withRepositoryLock<T>(
  root: string,
  fn: () => Promise<T>,
): Promise<T> {
  return withNamedRepositoryLock(root, 'state', fn);
}
