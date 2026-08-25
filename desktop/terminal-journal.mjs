import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

// Mirrors src/state/journal.ts so the Electron main process can append the
// same bounded, durable terminal lifecycle journal the CLI SessionManager
// writes. Keep this shape in sync with the TypeScript module.
export const JOURNAL_EVENT_TYPES = [
  'created',
  'attached',
  'status',
  'resized',
  'interrupted',
  'stopped',
  'closed',
  'exit',
  'recovered',
];

const JOURNAL_LIMIT = 500;
const JOURNAL_FILE_PATTERN = /^terminal-journal-[0-9a-f]{32}\.json$/;
const JOURNAL_SCAN_LIMIT = 512;
const JOURNAL_PROJECT_LIMIT = 64;
const JOURNAL_FILE_LIMIT_BYTES = 512_000;
const TEMP_FILE_PATTERN =
  /^\.terminal-journal-[0-9a-f]{32}\.[0-9a-f-]{36}\.tmp$/;
const TEMP_STALE_AFTER_MS = 60_000;
const LOCK_TIMEOUT_MS = 5_000;

function journalPath(project) {
  return path.join(journalDirectory(), journalFileName(project));
}

function journalDirectory() {
  return (
    process.env.RIREI_DATA_HOME ||
    path.join(homedir(), 'Library', 'Application Support', 'Rirei')
  );
}

function journalFileName(project) {
  const key = createHash('sha256').update(project).digest('hex').slice(0, 32);
  return `terminal-journal-${key}.json`;
}

async function withJournalLock(project, operation) {
  const lock = `${journalPath(project)}.lock`;
  await mkdir(path.dirname(lock), { recursive: true, mode: 0o700 });
  const started = Date.now();
  while (true) {
    try {
      await mkdir(lock, { mode: 0o700 });
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      try {
        const details = await lstat(lock);
        if (Date.now() - details.mtimeMs > LOCK_TIMEOUT_MS)
          await rm(lock, { recursive: true, force: true });
      } catch {
        // A concurrent writer released the lock.
      }
      if (Date.now() - started > LOCK_TIMEOUT_MS)
        throw new Error('Timed out waiting for terminal journal lock.');
      await new Promise((resolve) => globalThis.setTimeout(resolve, 10));
    }
  }
  try {
    return await operation();
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}

function sanitizedDetail(detail) {
  if (typeof detail !== 'string') return undefined;
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

function validEntry(entry) {
  return (
    entry &&
    typeof entry === 'object' &&
    typeof entry.at === 'string' &&
    typeof entry.terminalId === 'string' &&
    entry.terminalId.length >= 1 &&
    JOURNAL_EVENT_TYPES.includes(entry.event) &&
    typeof entry.projectRoot === 'string' &&
    typeof entry.controllerInstanceId === 'string' &&
    typeof entry.createdAt === 'string' &&
    typeof entry.lastActivityAt === 'string' &&
    [
      'starting',
      'running',
      'stopping',
      'closed',
      'exited',
      'recovered',
    ].includes(entry.expectedStatus) &&
    (entry.detail === undefined ||
      (typeof entry.detail === 'string' &&
        entry.detail.length >= 1 &&
        entry.detail.length <= 200))
  );
}

async function readJournal(project) {
  try {
    const contents = await readFile(journalPath(project), 'utf8');
    const parsed = JSON.parse(contents);
    if (
      parsed &&
      parsed.schemaVersion === 1 &&
      Array.isArray(parsed.entries) &&
      parsed.entries.every(validEntry)
    )
      return parsed;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  return { schemaVersion: 1, entries: [] };
}

export async function listTerminalJournalProjects() {
  let entries;
  try {
    entries = await readdir(journalDirectory(), { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const candidates = [];
  for (const entry of entries
    .filter(
      (candidate) =>
        candidate.isFile() && JOURNAL_FILE_PATTERN.test(candidate.name),
    )
    .slice(0, JOURNAL_SCAN_LIMIT)) {
    const file = path.join(journalDirectory(), entry.name);
    try {
      const details = await lstat(file);
      if (
        !details.isFile() ||
        details.isSymbolicLink() ||
        details.size > JOURNAL_FILE_LIMIT_BYTES
      )
        continue;
      const parsed = JSON.parse(await readFile(file, 'utf8'));
      if (
        parsed?.schemaVersion !== 1 ||
        !Array.isArray(parsed.entries) ||
        parsed.entries.length === 0 ||
        !parsed.entries.every(validEntry)
      )
        continue;
      const project = parsed.entries[0].projectRoot;
      if (
        parsed.entries.some((item) => item.projectRoot !== project) ||
        journalFileName(project) !== entry.name
      )
        continue;
      candidates.push({ project, modifiedAt: details.mtimeMs });
    } catch {
      // One damaged journal must not prevent reconciliation of other projects.
    }
  }
  return candidates
    .sort((left, right) => right.modifiedAt - left.modifiedAt)
    .slice(0, JOURNAL_PROJECT_LIMIT)
    .map((candidate) => candidate.project);
}

async function atomicWrite(project, journal) {
  const directory = path.dirname(journalPath(project));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(
    directory,
    `.${path.basename(journalPath(project), '.json')}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporary, `${JSON.stringify(journal, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    await rename(temporary, journalPath(project));
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function sweepTemporaryFiles(project) {
  const directory = path.dirname(journalPath(project));
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

/** Append a terminal lifecycle entry; never stores output, paths, or secrets. */
export async function appendTerminalJournal(project, entry) {
  const expectedStatus =
    entry.expectedStatus ??
    (entry.event === 'created'
      ? 'starting'
      : ['attached', 'status', 'resized', 'interrupted'].includes(entry.event)
        ? 'running'
        : entry.event === 'stopped'
          ? 'stopping'
          : entry.event === 'exit'
            ? 'exited'
            : entry.event === 'recovered'
              ? 'recovered'
              : 'closed');
  const validated = {
    ...entry,
    detail: sanitizedDetail(entry.detail),
    projectRoot: project,
    controllerInstanceId: entry.controllerInstanceId ?? entry.terminalId,
    createdAt: entry.createdAt ?? entry.at,
    lastActivityAt: entry.lastActivityAt ?? entry.at,
    expectedStatus,
  };
  if (!validEntry(validated))
    throw new Error('Invalid terminal journal entry.');
  return withJournalLock(project, async () => {
    const current = await readJournal(project);
    const next = {
      schemaVersion: 1,
      entries: [...current.entries, validated].slice(-JOURNAL_LIMIT),
    };
    await atomicWrite(project, next);
    await sweepTemporaryFiles(project);
    return next;
  });
}
