import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { constants } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  rm,
} from 'node:fs/promises';
import path from 'node:path';
import { relayPath } from '../safety/path-policy.js';
import type { RelayState } from '../state/schema.js';
import type { ThreadActor } from './schema.js';

export interface MessageCapabilityDescriptor {
  schemaVersion: 1;
  sessionId: string;
  runId: string;
  terminalId?: string;
  tokenHash: string;
  createdAt: string;
}

const CAPABILITY_MAX_BYTES = 4096;
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;

async function ensureRealDirectory(directory: string): Promise<void> {
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const details = await lstat(directory);
  if (!details.isDirectory() || details.isSymbolicLink())
    throw new Error('Message capability paths must be real directories.');
  await chmod(directory, 0o700);
}

async function ensureCapabilityDirectory(projectRoot: string): Promise<string> {
  const directories = [
    relayPath(projectRoot),
    relayPath(projectRoot, 'runtime'),
    relayPath(projectRoot, 'runtime', 'message-capabilities'),
  ];
  for (const directory of directories) await ensureRealDirectory(directory);
  return directories.at(-1)!;
}

async function assertCapabilityDirectories(projectRoot: string): Promise<void> {
  for (const directory of [
    relayPath(projectRoot),
    relayPath(projectRoot, 'runtime'),
    relayPath(projectRoot, 'runtime', 'message-capabilities'),
  ]) {
    const details = await lstat(directory);
    if (!details.isDirectory() || details.isSymbolicLink())
      throw new Error('Message capability paths must be real directories.');
  }
}

export function capabilityDescriptorPath(
  projectRoot: string,
  runId: string,
): string {
  const hash = createHash('sha256').update(runId).digest('hex');
  return relayPath(
    projectRoot,
    'runtime',
    'message-capabilities',
    `${hash}.json`,
  );
}

export async function issueMessageCapability(
  projectRoot: string,
  sessionId: string,
  runId: string,
  terminalId?: string,
): Promise<{ token: string; env: Record<string, string> }> {
  const token = randomBytes(32).toString('hex');
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const filePath = capabilityDescriptorPath(projectRoot, runId);
  const dir = await ensureCapabilityDirectory(projectRoot);

  const descriptor: MessageCapabilityDescriptor = {
    schemaVersion: 1,
    sessionId,
    runId,
    terminalId,
    tokenHash,
    createdAt: new Date().toISOString(),
  };

  try {
    const existing = await lstat(filePath);
    if (!existing.isFile() || existing.isSymbolicLink())
      throw new Error('Capability descriptor must be a regular file.');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const tempFile = path.join(dir, `.capability.${randomUUID()}.tmp`);
  const contents = `${JSON.stringify(descriptor, null, 2)}\n`;
  const handle = await open(tempFile, 'wx', 0o600);
  try {
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(tempFile, filePath);
    const directoryHandle = await open(dir, 'r');
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } finally {
    await rm(tempFile, { force: true }).catch(() => undefined);
  }

  return {
    token,
    env: {
      RIREI_PROJECT_ROOT: projectRoot,
      RIREI_TASK_SESSION_ID: sessionId,
      RIREI_RUN_ID: runId,
      RIREI_MESSAGE_TOKEN: token,
      ...(terminalId ? { RIREI_TERMINAL_ID: terminalId } : {}),
    },
  };
}

export async function revokeMessageCapability(
  projectRoot: string,
  runId: string,
): Promise<void> {
  const filePath = capabilityDescriptorPath(projectRoot, runId);
  try {
    await rm(filePath, { force: true });
  } catch {
    // Best-effort removal of capability descriptor file
  }
}

export async function resolveCurrentActor(
  projectRoot: string,
  state: RelayState,
): Promise<ThreadActor> {
  const envToken = process.env.RIREI_MESSAGE_TOKEN;
  const envRunId = process.env.RIREI_RUN_ID;
  const envSessionId = process.env.RIREI_TASK_SESSION_ID;
  const envProjectRoot = process.env.RIREI_PROJECT_ROOT;
  const envTerminalId = process.env.RIREI_TERMINAL_ID;
  const hasRunMarker = Boolean(
    envProjectRoot ||
    envTerminalId ||
    process.env.RIREI_LIFECYCLE_TOKEN ||
    process.env.RIREI_LIFECYCLE_HOOK,
  );

  // A plain local shell is the operator. Any managed-run marker must validate.
  if (!envToken && !envRunId && !envSessionId && !hasRunMarker) {
    return { kind: 'operator' };
  }

  // If any capability variable is present, validation must succeed or fail closed
  if (!envToken || !envRunId || !envSessionId) {
    throw new Error(
      'Incomplete run capability environment. Failing closed for security.',
    );
  }

  if (envSessionId !== state.sessionId) {
    throw new Error('Run capability session mismatch. Task has changed.');
  }
  if (!envProjectRoot) throw new Error('Run capability project root mismatch.');
  const [canonicalRoot, canonicalEnvRoot, canonicalStateRoot] =
    await Promise.all([
      realpath(projectRoot),
      realpath(envProjectRoot),
      realpath(state.projectRoot),
    ]);
  if (canonicalEnvRoot !== canonicalRoot)
    throw new Error('Run capability project root mismatch.');
  if (canonicalStateRoot !== canonicalRoot)
    throw new Error('Relay state project root mismatch.');

  const filePath = capabilityDescriptorPath(projectRoot, envRunId);
  await assertCapabilityDirectories(projectRoot).catch(() => {
    throw new Error(`Capability descriptor not found for run ${envRunId}.`);
  });

  // Reject symlinks
  try {
    const fileStat = await lstat(filePath);
    if (
      fileStat.isSymbolicLink() ||
      !fileStat.isFile() ||
      fileStat.size > CAPABILITY_MAX_BYTES
    ) {
      throw new Error('Capability descriptor cannot be a symbolic link.');
    }
  } catch {
    throw new Error(`Capability descriptor not found for run ${envRunId}.`);
  }

  let descriptor: MessageCapabilityDescriptor;
  try {
    const handle = await open(filePath, constants.O_RDONLY | NO_FOLLOW);
    try {
      const details = await handle.stat();
      if (!details.isFile() || details.size > CAPABILITY_MAX_BYTES)
        throw new Error('Invalid capability descriptor file.');
      descriptor = JSON.parse(await handle.readFile('utf8'));
    } finally {
      await handle.close();
    }
  } catch {
    throw new Error('Unreadable or corrupted capability descriptor.');
  }

  if (
    descriptor.schemaVersion !== 1 ||
    descriptor.runId !== envRunId ||
    descriptor.sessionId !== envSessionId ||
    !/^[0-9a-f]{64}$/.test(descriptor.tokenHash) ||
    (descriptor.terminalId !== undefined &&
      typeof descriptor.terminalId !== 'string')
  ) {
    throw new Error('Invalid run capability descriptor metadata.');
  }

  // Timing-safe token comparison
  const expectedHashBuf = Buffer.from(descriptor.tokenHash, 'hex');
  const actualHash = createHash('sha256').update(envToken).digest('hex');
  const actualHashBuf = Buffer.from(actualHash, 'hex');

  if (
    expectedHashBuf.length !== actualHashBuf.length ||
    !timingSafeEqual(expectedHashBuf, actualHashBuf)
  ) {
    throw new Error('Invalid run capability token.');
  }

  // Verify that the run is currently an active lease
  const lease = state.runs.find((run) => run.runId === envRunId);
  if (!lease || lease.status === 'orphaned') {
    throw new Error(`Run ${envRunId} is no longer an active lease.`);
  }
  if (
    descriptor.terminalId !== lease.terminalId ||
    descriptor.terminalId !== envTerminalId
  )
    throw new Error('Run capability terminal mismatch.');

  return { kind: 'run', runId: envRunId };
}
