import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import { relayPath } from '../safety/path-policy.js';
import { RelayConflictError, withNamedRepositoryLock } from '../state/lock.js';
import {
  LATEST_THREADS_SCHEMA,
  sessionIdSchema,
  THREADS_MAX_JOURNAL_BYTES,
  THREADS_MESSAGE_LIMIT,
  threadsJournalSchema,
  type RelayMessage,
  type ThreadsJournal,
} from './schema.js';

const TEMP_FILE_PATTERN = /^\.threads\.[0-9a-f-]{36}\.tmp$/;
const TEMP_STALE_AFTER_MS = 60_000;
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;

export function threadSessionHash(sessionId: string): string {
  return createHash('sha256').update(sessionId).digest('hex');
}

export function threadsDirectory(projectRoot: string): string {
  return relayPath(projectRoot, 'threads');
}

export function threadsJournalPath(
  projectRoot: string,
  sessionId: string,
): string {
  const hash = threadSessionHash(sessionId);
  return relayPath(projectRoot, 'threads', `${hash}.json`);
}

export function emptyThreadsJournal(sessionId: string): ThreadsJournal {
  const validSessionId = sessionIdSchema.parse(sessionId);
  return {
    schemaVersion: LATEST_THREADS_SCHEMA,
    sessionId: validSessionId,
    revision: 0,
    nextSequence: 1,
    recentOperations: [],
    messages: [],
  };
}

async function inspectDirectory(
  directory: string,
  label: string,
): Promise<boolean> {
  try {
    const entry = await lstat(directory);
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new Error(
        `${label} must be a real directory and cannot be a symlink.`,
      );
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function inspectJournal(file: string): Promise<boolean> {
  try {
    const entry = await lstat(file);
    if (entry.isSymbolicLink() || !entry.isFile()) {
      throw new Error(
        'Threads journal must be a regular file and cannot be a symlink.',
      );
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function inspectThreadsPath(
  projectRoot: string,
  sessionId: string,
): Promise<{
  relayExists: boolean;
  threadsExists: boolean;
  journalExists: boolean;
}> {
  sessionIdSchema.parse(sessionId);
  const relayDirectory = relayPath(projectRoot);
  const relayExists = await inspectDirectory(relayDirectory, '.relay');
  if (!relayExists) {
    return { relayExists: false, threadsExists: false, journalExists: false };
  }

  const directory = threadsDirectory(projectRoot);
  const threadsExists = await inspectDirectory(directory, '.relay/threads');
  if (!threadsExists) {
    return { relayExists: true, threadsExists: false, journalExists: false };
  }

  const journalExists = await inspectJournal(
    threadsJournalPath(projectRoot, sessionId),
  );
  return { relayExists: true, threadsExists: true, journalExists };
}

async function readBoundedJournal(file: string): Promise<string> {
  const handle = await open(file, constants.O_RDONLY | NO_FOLLOW);
  try {
    const entry = await handle.stat();
    if (!entry.isFile()) {
      throw new Error('Threads journal must be a regular file.');
    }
    if (entry.size > THREADS_MAX_JOURNAL_BYTES) {
      throw new Error(
        `Threads journal exceeds maximum size limit of ${THREADS_MAX_JOURNAL_BYTES} bytes (current: ${entry.size} bytes).`,
      );
    }

    const expectedBytes = entry.size;
    const buffer = Buffer.alloc(expectedBytes + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const result = await handle.read(
        buffer,
        offset,
        buffer.length - offset,
        offset,
      );
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    if (offset > expectedBytes) {
      throw new Error('Threads journal changed size while it was being read.');
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(
      buffer.subarray(0, offset),
    );
  } finally {
    await handle.close();
  }
}

export async function readThreadsJournal(
  projectRoot: string,
  sessionId: string,
): Promise<ThreadsJournal> {
  const inspected = await inspectThreadsPath(projectRoot, sessionId);
  if (!inspected.journalExists) return emptyThreadsJournal(sessionId);

  const file = threadsJournalPath(projectRoot, sessionId);
  try {
    const contents = await readBoundedJournal(file);
    const parsed = threadsJournalSchema.parse(JSON.parse(contents));
    if (parsed.sessionId !== sessionId) {
      throw new Error(
        `Threads journal session mismatch: requested "${sessionId}", found "${parsed.sessionId}".`,
      );
    }
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return emptyThreadsJournal(sessionId);
    }
    throw error;
  }
}

async function fsyncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, constants.O_RDONLY | NO_FOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function ensureThreadsDirectory(projectRoot: string): Promise<string> {
  const relayDirectory = relayPath(projectRoot);
  if (!(await inspectDirectory(relayDirectory, '.relay'))) {
    await mkdir(relayDirectory, { recursive: false, mode: 0o700 });
  }
  await inspectDirectory(relayDirectory, '.relay');

  const directory = threadsDirectory(projectRoot);
  if (!(await inspectDirectory(directory, '.relay/threads'))) {
    await mkdir(directory, { recursive: false, mode: 0o700 });
    await fsyncDirectory(relayDirectory);
  }
  await inspectDirectory(directory, '.relay/threads');
  return directory;
}

async function sweepAbandonedTempFiles(dir: string): Promise<void> {
  try {
    const entries = await readdir(dir);
    const now = Date.now();
    for (const entry of entries) {
      if (!TEMP_FILE_PATTERN.test(entry)) continue;
      const fullPath = path.join(dir, entry);
      try {
        const fileStat = await lstat(fullPath);
        if (
          !fileStat.isSymbolicLink() &&
          fileStat.isFile() &&
          now - fileStat.mtimeMs > TEMP_STALE_AFTER_MS
        ) {
          await rm(fullPath, { force: true });
        }
      } catch {
        // Temp file removal is best effort.
      }
    }
  } catch {
    // Temp file sweep is best effort.
  }
}

async function writeJournalFile(
  projectRoot: string,
  sessionId: string,
  journal: ThreadsJournal,
): Promise<void> {
  const valid = threadsJournalSchema.parse(journal);
  if (valid.sessionId !== sessionId) {
    throw new Error('Cannot write a threads journal for a different session.');
  }
  const json = `${JSON.stringify(valid, null, 2)}\n`;
  const byteLength = Buffer.byteLength(json, 'utf8');

  if (byteLength > THREADS_MAX_JOURNAL_BYTES) {
    throw new Error(
      `Threads journal exceeds maximum size limit of ${THREADS_MAX_JOURNAL_BYTES} bytes (current: ${byteLength} bytes). Cannot write new messages.`,
    );
  }

  const dir = await ensureThreadsDirectory(projectRoot);
  const destination = threadsJournalPath(projectRoot, sessionId);
  await inspectJournal(destination);
  await sweepAbandonedTempFiles(dir);

  const tempFile = path.join(dir, `.threads.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let renamed = false;
  try {
    handle = await open(
      tempFile,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW,
      0o600,
    );
    await handle.writeFile(json, { encoding: 'utf8' });
    await handle.sync();
    await handle.close();
    handle = undefined;

    await inspectThreadsPath(projectRoot, sessionId);
    await rename(tempFile, destination);
    renamed = true;
    await fsyncDirectory(dir);
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    if (!renamed) {
      await rm(tempFile, { force: true }).catch(() => undefined);
    }
    throw error;
  }
}

export interface UpdateThreadsOptions {
  opId?: string;
  actor?: string;
  payloadHash?: string;
  messageId?: string;
}

export async function updateThreadsJournal(
  projectRoot: string,
  sessionId: string,
  mutator: (
    current: ThreadsJournal,
  ) => ThreadsJournal | Promise<ThreadsJournal>,
  options: UpdateThreadsOptions = {},
): Promise<{ journal: ThreadsJournal; existingMessage?: RelayMessage }> {
  await inspectThreadsPath(projectRoot, sessionId);
  return withNamedRepositoryLock(projectRoot, 'threads', async () => {
    await inspectThreadsPath(projectRoot, sessionId);
    const current = await readThreadsJournal(projectRoot, sessionId);

    if (options.opId && options.actor && options.payloadHash) {
      const existingOp = current.recentOperations.find(
        (op) => op.actor === options.actor && op.operationId === options.opId,
      );
      if (existingOp) {
        if (existingOp.payloadHash !== options.payloadHash) {
          throw new RelayConflictError(
            `Operation "${options.opId}" was already processed with a different payload.`,
          );
        }
        const existingMsg = current.messages.find(
          (message) => message.id === existingOp.messageId,
        );
        return { journal: current, existingMessage: existingMsg };
      }
    }

    const mutated = await mutator(current);
    if (mutated === current) return { journal: current };
    const revision = current.revision + 1;

    let recentOperations = current.recentOperations;
    if (
      options.opId &&
      options.actor &&
      options.payloadHash &&
      options.messageId
    ) {
      recentOperations = [
        ...current.recentOperations,
        {
          actor: options.actor,
          operationId: options.opId,
          payloadHash: options.payloadHash,
          messageId: options.messageId,
          at: new Date().toISOString(),
        },
      ].slice(-THREADS_MESSAGE_LIMIT);
    }

    const next: ThreadsJournal = {
      ...mutated,
      revision,
      recentOperations,
    };

    await writeJournalFile(projectRoot, sessionId, next);
    return { journal: next };
  });
}
