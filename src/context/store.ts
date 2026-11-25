import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { relayPath } from '../safety/path-policy.js';
import { withDirectoryLock } from '../state/lock.js';
import {
  CONTEXT_EVENT_LIMIT,
  CONTEXT_JOURNAL_LIMIT,
  contextEventSchema,
  contextObservationSchema,
  type ContextEvent,
  type ContextJournal,
  type ContextObservation,
} from './schema.js';

export const hash = (value: string | Uint8Array): string =>
  createHash('sha256').update(value).digest('hex');
const EMPTY_HASH = '0'.repeat(64);
const policySchema = z.object({
  enabled: z.boolean(),
  epoch: z.string().uuid(),
});
const grantSchema = z.object({
  taskId: z.string(),
  runId: z.string(),
  epoch: z.string(),
  tokenHash: z.string().regex(/^[a-f0-9]{64}$/),
  workspace: z.string(),
  provider: z.enum(['claude', 'codex']).optional(),
  providerSessionId: z.string().optional(),
  launchPromptHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  launchGitFingerprint: z.string(),
});
export type CaptureGrant = z.infer<typeof grantSchema>;

export function contextDirectory(root: string, taskId: string): string {
  return relayPath(root, 'context', hash(taskId));
}

export function workspaceKey(workspace: string): string {
  const resolved = path.resolve(workspace);
  return hash(process.platform === 'win32' ? resolved.toLowerCase() : resolved);
}

async function realDirectory(
  directory: string,
  create: boolean,
): Promise<boolean> {
  try {
    if (create) await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  try {
    const entry = await lstat(directory);
    if (entry.isSymbolicLink() || !entry.isDirectory())
      throw new Error('Context storage requires real directories.');
    return true;
  } catch (error) {
    if (!create && (error as NodeJS.ErrnoException).code === 'ENOENT')
      return false;
    throw error;
  }
}

async function directory(
  root: string,
  taskId: string,
  create = false,
): Promise<string | null> {
  // Never initialize a project as a side effect of observation or retrieval.
  if (!(await realDirectory(relayPath(root), false))) {
    if (create)
      throw new Error(
        'Initialize the Relay project before enabling context capture.',
      );
    return null;
  }
  for (const candidate of [
    relayPath(root, 'context'),
    contextDirectory(root, taskId),
  ])
    if (!(await realDirectory(candidate, create))) return null;
  return contextDirectory(root, taskId);
}

async function readBytes(
  file: string,
  limit = CONTEXT_JOURNAL_LIMIT,
): Promise<Buffer | null> {
  let handle;
  try {
    const entry = await lstat(file);
    if (!entry.isFile() || entry.isSymbolicLink())
      throw new Error('Context records must be regular files.');
    handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    if ((await handle.stat()).size > limit)
      throw new Error('Context record exceeds its storage limit.');
    const buffer = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < buffer.length) {
      const result = await handle.read(
        buffer,
        length,
        buffer.length - length,
        length,
      );
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    if (length > limit)
      throw new Error('Context record exceeds its storage limit.');
    return buffer.subarray(0, length);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  } finally {
    await handle?.close();
  }
}

async function readBounded(
  file: string,
  limit = CONTEXT_JOURNAL_LIMIT,
): Promise<string | null> {
  const bytes = await readBytes(file, limit);
  return bytes === null
    ? null
    : new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

async function atomicWrite(
  dir: string,
  name: string,
  text: string,
): Promise<void> {
  const file = path.join(dir, name);
  await readBounded(file);
  const temporary = path.join(dir, `.context-${randomUUID()}.tmp`);
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(text);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, file);
    if (process.platform !== 'win32') {
      const parent = await open(
        dir,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      try {
        await parent.sync();
      } finally {
        await parent.close();
      }
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function readContextPolicy(root: string, taskId: string) {
  const dir = await directory(root, taskId);
  const text = dir
    ? await readBounded(path.join(dir, 'policy.json'), 4096)
    : null;
  return text ? policySchema.parse(JSON.parse(text)) : null;
}

export async function setContextConsent(
  root: string,
  taskId: string,
  enabled: boolean,
): Promise<void> {
  const dir = (await directory(root, taskId, true))!;
  await withDirectoryLock(dir, 'context', async () => {
    const previous = await readContextPolicy(root, taskId);
    if (previous?.enabled === enabled) return;
    // Toggling consent invalidates every existing capture grant.
    await atomicWrite(
      dir,
      'policy.json',
      JSON.stringify({ enabled, epoch: randomUUID() }),
    );
  });
}

/** Forget this task's generated capture files without modifying task state or other tasks. */
export async function clearContext(
  root: string,
  taskId: string,
): Promise<void> {
  const dir = await directory(root, taskId);
  if (!dir) return;
  await withDirectoryLock(dir, 'context', async () => {
    await atomicWrite(
      dir,
      'policy.json',
      JSON.stringify({ enabled: false, epoch: randomUUID() }),
    );
    for (const name of await readdir(dir)) {
      if (
        name === 'events.jsonl' ||
        name === 'diagnostic.json' ||
        /^\.context-[a-f0-9-]{36}\.tmp$/.test(name) ||
        /^run-[a-f0-9]{64}\.json$/.test(name) ||
        /^claude-[a-f0-9]{64}-[a-f0-9]{12}\.json$/.test(name)
      ) {
        const file = path.join(dir, name);
        const entry = await lstat(file);
        if (!entry.isFile() || entry.isSymbolicLink())
          throw new Error('Context cleanup requires regular generated files.');
        await rm(file);
      }
    }
  });
}

export async function issueCaptureGrant(
  root: string,
  request: Omit<CaptureGrant, 'tokenHash' | 'epoch'>,
): Promise<{ grant: CaptureGrant; token: string } | null> {
  const dir = await directory(root, request.taskId);
  if (!dir) return null;
  return withDirectoryLock(dir, 'context', async () => {
    const policy = await readContextPolicy(root, request.taskId);
    if (!policy?.enabled) return null;
    const token = randomBytes(32).toString('hex');
    const grant = grantSchema.parse({
      ...request,
      epoch: policy.epoch,
      tokenHash: hash(token),
    });
    await atomicWrite(
      dir,
      `run-${hash(request.runId)}.json`,
      JSON.stringify(grant),
    );
    return { grant, token };
  });
}

export async function readCaptureGrant(
  root: string,
  taskId: string,
  runId: string,
  token: string,
): Promise<CaptureGrant> {
  const dir = await directory(root, taskId);
  const policy = await readContextPolicy(root, taskId);
  if (!dir || !policy?.enabled)
    throw new Error('Context capture is disabled for this task.');
  const text = await readBounded(
    path.join(dir, `run-${hash(runId)}.json`),
    8192,
  );
  if (!text) throw new Error('Context capture grant is missing.');
  const grant = grantSchema.parse(JSON.parse(text));
  if (
    grant.taskId !== taskId ||
    grant.runId !== runId ||
    grant.epoch !== policy.epoch ||
    !timingSafeEqual(Buffer.from(hash(token)), Buffer.from(grant.tokenHash))
  )
    throw new Error('Context capture grant is invalid or revoked.');
  return grant;
}

export async function readContextJournal(
  root: string,
  taskId: string,
): Promise<ContextJournal> {
  const dir = await directory(root, taskId);
  const bytes = dir ? await readBytes(path.join(dir, 'events.jsonl')) : null;
  if (!bytes?.length)
    return { events: [], incompleteTail: false, digest: hash('') };
  const incompleteTail = bytes.at(-1) !== 10;
  const complete = bytes.subarray(0, bytes.lastIndexOf(10) + 1);
  const text = new TextDecoder('utf-8', { fatal: true }).decode(complete);
  const lines = text.split('\n');
  lines.pop(); // The last unterminated line is never treated as durable evidence.
  const events: ContextEvent[] = [];
  const ids = new Set<string>();
  let previousHash = EMPTY_HASH;
  for (const line of lines) {
    const event = contextEventSchema.parse(JSON.parse(line));
    const { hash: storedHash, ...body } = event;
    if (
      event.taskId !== taskId ||
      event.previousHash !== previousHash ||
      event.sequence !== events.length + 1 ||
      ids.has(event.id) ||
      events.length >= CONTEXT_EVENT_LIMIT ||
      hash(JSON.stringify(body)) !== storedHash
    )
      throw new Error('Context journal integrity check failed.');
    events.push(event);
    ids.add(event.id);
    previousHash = storedHash;
  }
  return { events, incompleteTail, digest: hash(bytes) };
}

export async function contextFingerprint(
  root: string,
  taskId: string,
): Promise<string> {
  const policy = await readContextPolicy(root, taskId);
  if (!policy?.enabled) return 'disabled';
  const journal = await readContextJournal(root, taskId);
  const diagnostic = await readCaptureDiagnostic(root, taskId);
  return contextSnapshotFingerprint(policy, journal, diagnostic);
}

export function contextSnapshotFingerprint(
  policy: { enabled: boolean; epoch: string },
  journal: ContextJournal,
  diagnostic: string | null,
): string {
  return hash(JSON.stringify({ policy, digest: journal.digest, diagnostic }));
}

export async function readCaptureDiagnostic(
  root: string,
  taskId: string,
): Promise<string | null> {
  const dir = await directory(root, taskId);
  const text = dir
    ? await readBounded(path.join(dir, 'diagnostic.json'), 4096)
    : null;
  if (!text) return null;
  const value = z
    .object({ epoch: z.string(), failedAt: z.iso.datetime() })
    .parse(JSON.parse(text));
  return value.failedAt;
}

export async function recordCaptureFailure(
  root: string,
  taskId: string,
  runId: string,
  token: string,
): Promise<void> {
  const dir = await directory(root, taskId);
  if (!dir) return;
  await withDirectoryLock(dir, 'context', async () => {
    const grant = await readCaptureGrant(root, taskId, runId, token);
    await atomicWrite(
      dir,
      'diagnostic.json',
      JSON.stringify({
        epoch: grant.epoch,
        failedAt: new Date().toISOString(),
      }),
    );
  });
}

export async function appendCapturedObservation(
  root: string,
  taskId: string,
  runId: string,
  token: string,
  observation: ContextObservation,
): Promise<ContextEvent> {
  const dir = await directory(root, taskId);
  if (!dir) throw new Error('Context capture is disabled for this task.');
  return withDirectoryLock(
    dir,
    'context',
    async () => {
      const grant = await readCaptureGrant(root, taskId, runId, token);
      const value = contextObservationSchema.parse(observation);
      if (grant.provider && value.provider !== grant.provider)
        throw new Error('Context provider does not match the capture grant.');
      if (
        grant.providerSessionId &&
        value.providerSessionId !== grant.providerSessionId
      )
        throw new Error(
          'Context provider session does not match the capture grant.',
        );
      const journal = await readContextJournal(root, taskId);
      if (!grant.providerSessionId) {
        // A picker/fork can choose its session at startup; bind the first observed identity.
        grant.providerSessionId = value.providerSessionId;
        await atomicWrite(
          dir,
          `run-${hash(runId)}.json`,
          JSON.stringify(grant),
        );
      }
      if (journal.incompleteTail)
        throw new Error(
          'Context journal has an incomplete tail; capture stopped without overwriting evidence.',
        );
      if (value.sourceId) {
        const existing = journal.events.find(
          (event) => event.runId === runId && event.sourceId === value.sourceId,
        );
        if (existing) {
          if (
            JSON.stringify(contextObservationSchema.parse(existing)) !==
            JSON.stringify(value)
          )
            throw new Error(
              'Conflicting delivery for an existing context source event.',
            );
          return existing;
        }
      }
      if (journal.events.length >= CONTEXT_EVENT_LIMIT)
        throw new Error('Context event limit reached; capture is incomplete.');
      const body = {
        ...value,
        schemaVersion: 1 as const,
        id: `e-${randomBytes(16).toString('hex')}`,
        sequence: journal.events.length + 1,
        receivedAt: new Date().toISOString(),
        taskId,
        runId,
        launchGitFingerprint: grant.launchGitFingerprint,
        workspace: workspaceKey(grant.workspace),
        previousHash: journal.events.at(-1)?.hash ?? EMPTY_HASH,
      };
      // Hash the schema's canonical field order, not caller object insertion order.
      const unsigned = contextEventSchema.omit({ hash: true }).parse(body);
      const event = { ...unsigned, hash: hash(JSON.stringify(unsigned)) };
      const text =
        [...journal.events, event]
          .map((item) => JSON.stringify(item))
          .join('\n') + '\n';
      if (Buffer.byteLength(text) > CONTEXT_JOURNAL_LIMIT)
        throw new Error(
          'Context storage limit reached; capture is incomplete.',
        );
      // Logical append with atomic publication: readers see either complete revision.
      await atomicWrite(dir, 'events.jsonl', text);
      return event;
    },
    { waitMs: 10_000 },
  );
}
