import { hostname } from 'node:os';
import { mkdir, readFile, readdir, utimes, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { relayPath } from '../../src/safety/path-policy.js';
import { type RelayState } from '../../src/state/schema.js';
import { RelayConflictError, RelayLockError } from '../../src/state/lock.js';
import { readState, updateState, writeState } from '../../src/state/store.js';
import { createRepository, removeRepository } from '../helpers.js';

const directories: string[] = [];

function seed(root: string): RelayState {
  const now = '2026-01-01T00:00:00.000Z';
  return {
    schemaVersion: 3,
    revision: 0,
    recentOperations: [],
    runs: [],
    sessionId: 'session',
    projectRoot: root,
    task: {
      title: 'Task',
      originalRequest: 'Task',
      requirements: [],
      constraints: [],
      status: 'active',
      createdAt: now,
      updatedAt: now,
    },
    git: { startingCommit: 'abc', startingBranch: 'main', dirtyAtStart: false },
    agentHistory: [],
    decisions: [],
    completedWork: [],
    remainingWork: [],
    tests: [],
    checkpoints: [],
    blockers: [],
  };
}

async function initialize(): Promise<string> {
  const root = await createRepository();
  directories.push(root);
  await mkdir(relayPath(root), { recursive: true });
  await writeState(root, seed(root));
  return root;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(removeRepository));
});

describe('updateState', () => {
  it('bumps the monotonic revision on every mutation', async () => {
    const root = await initialize();
    const first = await updateState(root, (current) => ({
      ...current,
      task: { ...current.task, title: 'First' },
    }));
    expect(first.revision).toBe(1);
    const second = await updateState(root, (current) => ({ ...current }));
    expect(second.revision).toBe(2);
    expect((await readState(root)).revision).toBe(2);
  });

  it('rejects a stale expected revision with a conflict error', async () => {
    const root = await initialize();
    await updateState(root, (current) => ({ ...current }));
    await expect(
      updateState(root, (current) => ({ ...current }), { expectedRevision: 0 }),
    ).rejects.toBeInstanceOf(RelayConflictError);
  });

  it('applies an operation id exactly once for retried mutations', async () => {
    const root = await initialize();
    const mutator = (current: RelayState): RelayState => ({
      ...current,
      decisions: [
        ...current.decisions,
        { summary: 'once', createdAt: '2026-01-01T00:00:00.000Z' },
      ],
    });
    const first = await updateState(root, mutator, { opId: 'op-1' });
    const second = await updateState(root, mutator, { opId: 'op-1' });
    expect(first.decisions).toHaveLength(1);
    expect(second.decisions).toHaveLength(1);
    expect(second.revision).toBe(first.revision);
  });

  it('serializes concurrent mutations without losing writes', async () => {
    const root = await initialize();
    const mutationCount = 20;
    await Promise.all(
      Array.from({ length: mutationCount }, (_, index) =>
        updateState(root, (current) => ({
          ...current,
          decisions: [
            ...current.decisions,
            { summary: `d${index}`, createdAt: '2026-01-01T00:00:00.000Z' },
          ],
        })),
      ),
    );
    const final = await readState(root);
    expect(final.decisions).toHaveLength(mutationCount);
    expect(final.revision).toBe(mutationCount);
  });

  it('backs up pre-migration state before writing a newer schema', async () => {
    const root = await createRepository();
    directories.push(root);
    await mkdir(relayPath(root), { recursive: true });
    const legacy = { ...seed(root), schemaVersion: 1 } as Record<
      string,
      unknown
    >;
    delete legacy.revision;
    delete legacy.recentOperations;
    delete legacy.runs;
    await writeFile(
      relayPath(root, 'state.json'),
      `${JSON.stringify(legacy)}\n`,
    );

    await updateState(root, (current) => ({ ...current }));

    const backups = await readdir(relayPath(root, 'backups'));
    expect(backups.some((name) => name.startsWith('state.v1.'))).toBe(true);
    const migrated = await readState(root);
    expect(migrated.schemaVersion).toBe(3);
    expect(migrated.revision).toBe(1);
  });

  it('reclaims a writer lock left by a dead process', async () => {
    const root = await initialize();
    const lockDir = relayPath(root, 'state.lock');
    await mkdir(lockDir, { recursive: true });
    await writeFile(
      relayPath(root, 'state.lock', 'owner.json'),
      JSON.stringify({
        token: 'dead-owner',
        pid: 2 ** 30, // A PID this build will not have assigned.
        host: hostname(),
        acquiredAt: '2000-01-01T00:00:00.000Z',
      }),
    );
    const next = await updateState(root, (current) => ({ ...current }));
    expect(next.revision).toBe(1);
  });

  it('reclaims the lock gate left by a dead process', async () => {
    const root = await initialize();
    const gateDir = relayPath(root, 'state.lock.gate');
    await mkdir(gateDir, { recursive: true });
    await writeFile(
      relayPath(root, 'state.lock.gate', 'owner.json'),
      JSON.stringify({
        token: 'dead-gate-owner',
        pid: 2 ** 30,
        host: hostname(),
        acquiredAt: '2000-01-01T00:00:00.000Z',
      }),
    );
    const next = await updateState(root, (current) => ({ ...current }));
    expect(next.revision).toBe(1);
  });

  it('never reclaims an old lock while its local owner is alive', async () => {
    const root = await initialize();
    const lockDir = relayPath(root, 'state.lock');
    await mkdir(lockDir, { recursive: true });
    await writeFile(
      relayPath(root, 'state.lock', 'owner.json'),
      JSON.stringify({
        token: 'live-owner',
        pid: process.pid,
        host: hostname(),
        acquiredAt: '2000-01-01T00:00:00.000Z',
      }),
    );
    await expect(
      updateState(root, (current) => ({ ...current })),
    ).rejects.toBeInstanceOf(RelayLockError);
    expect((await readState(root)).revision).toBe(0);
  });

  it('sweeps abandoned temp files but keeps fresh ones', async () => {
    const root = await initialize();
    const stale = relayPath(
      root,
      '.state.json.00000000-0000-0000-0000-000000000000.tmp',
    );
    const fresh = relayPath(
      root,
      '.state.json.11111111-1111-1111-1111-111111111111.tmp',
    );
    await writeFile(stale, 'stale');
    await writeFile(fresh, 'fresh');
    const old = new Date(Date.now() - 5 * 60_000);
    await utimes(stale, old, old);

    await updateState(root, (current) => ({ ...current }));

    const remaining = await readdir(relayPath(root));
    expect(remaining).not.toContain(
      '.state.json.00000000-0000-0000-0000-000000000000.tmp',
    );
    expect(remaining).toContain(
      '.state.json.11111111-1111-1111-1111-111111111111.tmp',
    );
    await expect(
      readFile(relayPath(root, 'state.json'), 'utf8'),
    ).resolves.toContain('"revision": 1');
  });
});
