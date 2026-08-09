import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { relayPath } from '../safety/path-policy.js';

const LOCK_DIRECTORY = 'state.lock';
const GATE_DIRECTORY = 'state.lock.gate';
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
    await rm(claimDirectory, { recursive: true, force: true });
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
  const current = await readOwner(directory);
  if (current?.token !== owner.token) return;
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

async function acquireGate(root: string): Promise<LockOwner> {
  const directory = relayPath(root, GATE_DIRECTORY);
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
    'Another Relay process is acquiring or releasing the repository writer lock. ' +
      'Wait for it to finish, or remove .relay/state.lock.gate if no Relay is running.',
  );
}

async function acquire(root: string): Promise<LockOwner> {
  const directory = relayPath(root, LOCK_DIRECTORY);
  const gateDirectory = relayPath(root, GATE_DIRECTORY);
  await mkdir(relayPath(root), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < ACQUIRE_ATTEMPTS; attempt += 1) {
    const gate = await acquireGate(root);
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
  throw new RelayLockError(
    'Another Relay process is holding the repository writer lock. ' +
      'Wait for it to finish, or remove .relay/state.lock if no Relay is running.',
  );
}

async function release(root: string, owner: LockOwner): Promise<void> {
  const gateDirectory = relayPath(root, GATE_DIRECTORY);
  const gate = await acquireGate(root);
  try {
    await removeIfOwned(relayPath(root, LOCK_DIRECTORY), owner);
  } finally {
    await removeIfOwned(gateDirectory, gate);
  }
}

/**
 * Run `fn` while holding the repository-scoped writer lock. The lock is always
 * released in `finally`, even when `fn` throws.
 */
export async function withRepositoryLock<T>(
  root: string,
  fn: () => Promise<T>,
): Promise<T> {
  const owner = await acquire(root);
  try {
    return await fn();
  } finally {
    await release(root, owner);
  }
}
