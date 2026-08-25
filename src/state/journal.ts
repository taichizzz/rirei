import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { activityDataHome } from './activity.js';

export const LATEST_JOURNAL_SCHEMA = 1;
export const JOURNAL_ENTRY_LIMIT = 500;
const JOURNAL_PREFIX = 'terminal-journal-';
const TEMP_FILE_PATTERN =
  /^\.terminal-journal-[0-9a-f]{32}\.[0-9a-f-]{36}\.tmp$/;
const TEMP_STALE_AFTER_MS = 60_000;
const LOCK_RETRY_MS = 10;
const LOCK_TIMEOUT_MS = 5_000;

export const terminalJournalEventSchema = z.enum([
  'created',
  'attached',
  'status',
  'resized',
  'interrupted',
  'stopped',
  'closed',
  'exit',
  'recovered',
]);

export const terminalJournalEntrySchema = z
  .object({
    at: z.string().datetime(),
    terminalId: z.string().min(1),
    event: terminalJournalEventSchema,
    detail: z.string().min(1).max(200).optional(),
    projectRoot: z.string().min(1),
    runId: z.string().min(1).optional(),
    workspaceId: z.string().min(1).optional(),
    provider: z.string().min(1).optional(),
    controllerInstanceId: z.string().min(1),
    createdAt: z.string().datetime(),
    lastActivityAt: z.string().datetime(),
    expectedStatus: z.enum([
      'starting',
      'running',
      'stopping',
      'closed',
      'exited',
      'recovered',
    ]),
  })
  .strict();

export type TerminalJournalEvent = z.infer<typeof terminalJournalEventSchema>;
export type TerminalJournalEntry = z.infer<typeof terminalJournalEntrySchema>;
export type TerminalJournalAppend = Omit<
  TerminalJournalEntry,
  | 'projectRoot'
  | 'controllerInstanceId'
  | 'createdAt'
  | 'lastActivityAt'
  | 'expectedStatus'
> &
  Partial<
    Pick<
      TerminalJournalEntry,
      | 'runId'
      | 'workspaceId'
      | 'provider'
      | 'controllerInstanceId'
      | 'createdAt'
      | 'lastActivityAt'
      | 'expectedStatus'
    >
  >;

const journalSchema = z
  .object({
    schemaVersion: z.literal(LATEST_JOURNAL_SCHEMA),
    entries: z.array(terminalJournalEntrySchema).max(JOURNAL_ENTRY_LIMIT),
  })
  .strict();

export type TerminalJournal = z.infer<typeof journalSchema>;

/**
 * A bounded, durable terminal lifecycle journal under Rirei app support. It records
 * terminal identity events (created/attached/status/resize/interrupt/stop/
 * close/exit/recovered) so a frontend that restarts can reconcile its terminal
 * inventory without trusting renderer state. No terminal output, prompts,
 * paths, or provider credentials are ever stored here.
 */
export function journalFilePath(projectRoot: string): string {
  const key = createHash('sha256')
    .update(projectRoot)
    .digest('hex')
    .slice(0, 32);
  return path.join(activityDataHome(), `${JOURNAL_PREFIX}${key}.json`);
}

function journalLockPath(projectRoot: string): string {
  return `${journalFilePath(projectRoot)}.lock`;
}

async function withJournalLock<T>(
  projectRoot: string,
  operation: () => Promise<T>,
): Promise<T> {
  const lock = journalLockPath(projectRoot);
  await mkdir(activityDataHome(), { recursive: true, mode: 0o700 });
  const started = Date.now();
  while (true) {
    try {
      await mkdir(lock, { mode: 0o700 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        const details = await lstat(lock);
        if (Date.now() - details.mtimeMs > LOCK_TIMEOUT_MS)
          await rm(lock, { recursive: true, force: true });
      } catch {
        // A concurrent writer released the lock.
      }
      if (Date.now() - started > LOCK_TIMEOUT_MS)
        throw new Error('Timed out waiting for terminal journal lock.');
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
    }
  }
  try {
    return await operation();
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}

function sanitizedDetail(detail: string | undefined): string | undefined {
  if (!detail) return undefined;
  if (
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/i.test(detail) ||
    /\b(?:sk-(?:proj-)?[a-z0-9_-]{8,}|gh[pousr]_[a-z0-9_]{8,}|github_pat_[a-z0-9_]{8,}|xox[baprs]-[a-z0-9-]{8,})/i.test(
      detail,
    ) ||
    /\b(?:api[_-]?key|access[_-]?token|secret|password|authorization)\b\s*[:=]/i.test(
      detail,
    )
  )
    return 'redacted';
  return detail.slice(0, 200);
}

export async function readTerminalJournal(
  projectRoot: string,
): Promise<TerminalJournal> {
  try {
    const contents = await readFile(journalFilePath(projectRoot), 'utf8');
    const parsed = journalSchema.safeParse(JSON.parse(contents));
    return parsed.success ? parsed.data : { schemaVersion: 1, entries: [] };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { schemaVersion: 1, entries: [] };
    throw error;
  }
}

async function atomicWrite(
  projectRoot: string,
  journal: TerminalJournal,
): Promise<void> {
  const directory = activityDataHome();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(
    directory,
    `.${path.basename(journalFilePath(projectRoot), '.json')}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporary, `${JSON.stringify(journal, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    await rename(temporary, journalFilePath(projectRoot));
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function sweepTemporaryFiles(): Promise<void> {
  const directory = activityDataHome();
  let entries;
  try {
    entries = await readdir(directory);
  } catch {
    return;
  }
  const now = Date.now();
  for (const entry of entries) {
    if (!TEMP_FILE_PATTERN.test(entry)) continue;
    const candidate = path.join(directory, entry);
    try {
      const details = await lstat(candidate);
      if (now - details.mtimeMs > TEMP_STALE_AFTER_MS)
        await rm(candidate, { force: true });
    } catch {
      // Concurrent cleanup already removed it.
    }
  }
}

/** Append a terminal lifecycle entry, keeping the journal bounded. */
export async function appendTerminalJournal(
  projectRoot: string,
  entry: TerminalJournalAppend,
): Promise<TerminalJournal> {
  const expectedStatus =
    entry.expectedStatus ??
    (entry.event === 'created'
      ? 'starting'
      : entry.event === 'attached' ||
          entry.event === 'status' ||
          entry.event === 'resized' ||
          entry.event === 'interrupted'
        ? 'running'
        : entry.event === 'stopped'
          ? 'stopping'
          : entry.event === 'exit'
            ? 'exited'
            : entry.event === 'recovered'
              ? 'recovered'
              : 'closed');
  const validated = terminalJournalEntrySchema.parse({
    ...entry,
    detail: sanitizedDetail(entry.detail),
    projectRoot,
    controllerInstanceId: entry.controllerInstanceId ?? entry.terminalId,
    createdAt: entry.createdAt ?? entry.at,
    lastActivityAt: entry.lastActivityAt ?? entry.at,
    expectedStatus,
  });
  return withJournalLock(projectRoot, async () => {
    const current = await readTerminalJournal(projectRoot);
    const next: TerminalJournal = {
      schemaVersion: 1,
      entries: [...current.entries, validated].slice(-JOURNAL_ENTRY_LIMIT),
    };
    await atomicWrite(projectRoot, next);
    await sweepTemporaryFiles();
    return next;
  });
}
