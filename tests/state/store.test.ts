import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { relayPath } from '../../src/safety/path-policy.js';
import { relayStateSchema, type RelayState } from '../../src/state/schema.js';
import {
  archiveState,
  readArchivedStates,
  readState,
  replaceState,
  writeState,
} from '../../src/state/store.js';
import { createRepository, removeRepository } from '../helpers.js';

const directories: string[] = [];

function state(root: string): RelayState {
  const now = '2026-01-01T00:00:00.000Z';
  return {
    schemaVersion: 8,
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
    notes: [],
  };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(removeRepository));
});

describe('state store', () => {
  it('atomically replaces valid state', async () => {
    const root = await createRepository();
    directories.push(root);
    await mkdir(relayPath(root), { recursive: true });
    await writeState(root, state(root));
    const replacement = state(root);
    replacement.task.title = 'Replacement';
    await writeState(root, replacement);

    await expect(readState(root)).resolves.toMatchObject({
      task: { title: 'Replacement' },
    });
    await expect(
      readFile(relayPath(root, 'state.json'), 'utf8'),
    ).resolves.toContain('Replacement');
  });

  it('rejects malformed persisted state', async () => {
    const root = await createRepository();
    directories.push(root);
    await mkdir(relayPath(root), { recursive: true });
    await writeFile(relayPath(root, 'state.json'), '{ not JSON }');
    await expect(readState(root)).rejects.toThrow();
  });

  it('rejects checkpoint paths outside their validated directory', () => {
    const unsafe = state('/repo');
    unsafe.checkpoints = [
      {
        id: 'checkpoint-1',
        createdAt: '2026-01-01T00:00:00.000Z',
        path: '.',
      },
    ];
    expect(() => relayStateSchema.parse(unsafe)).toThrow(
      /Checkpoint paths must match/,
    );
  });

  it('rejects contradictory handoff-note provenance', () => {
    const invalid = state('/repo');
    invalid.notes = [
      {
        id: 'd68b385a-e4c6-4cd6-9ea8-3b15ec329c4a',
        type: 'decision',
        text: 'Use PKCE',
        createdAt: '2026-01-01T00:00:00.000Z',
        provenance: {
          source: 'user',
          agent: 'claude',
          recordedBy: 'relay-cli',
        },
        git: {
          commit: 'abc',
          branch: 'main',
          fingerprint: 'a'.repeat(64),
        },
      },
    ];
    expect(() => relayStateSchema.parse(invalid)).toThrow(
      /User-reported notes cannot claim an agent name/,
    );
  });

  it('migrates schema-version-1 state to the current schema on read', async () => {
    const root = await createRepository();
    directories.push(root);
    await mkdir(relayPath(root), { recursive: true });
    // A genuine v1 payload: no revision, no recentOperations, no run metadata.
    const legacy = {
      ...state(root),
      schemaVersion: 1,
      agentHistory: [
        { agent: 'claude', startedAt: '2026-01-01T00:00:00.000Z' },
      ],
    };
    delete (legacy as Record<string, unknown>).revision;
    delete (legacy as Record<string, unknown>).recentOperations;
    delete (legacy as Record<string, unknown>).runs;
    await writeFile(
      relayPath(root, 'state.json'),
      `${JSON.stringify(legacy)}\n`,
    );

    const parsed = await readState(root);
    expect(parsed).toMatchObject({
      schemaVersion: 8,
      revision: 0,
      recentOperations: [],
      runs: [{ agent: 'claude', status: 'orphaned' }],
      currentAgent: 'claude',
      agentHistory: [{ id: expect.any(String), agent: 'claude' }],
      notes: [],
    });
  });

  it('writes secure atomic task archives and reads them back', async () => {
    const root = await createRepository();
    directories.push(root);
    await mkdir(relayPath(root), { recursive: true });
    const completed = state(root);
    completed.task.status = 'completed';
    await archiveState(root, completed);

    await expect(readArchivedStates(root)).resolves.toMatchObject([
      { sessionId: 'session', task: { status: 'completed' } },
    ]);
    const directoryMode = (await stat(relayPath(root, 'tasks', 'session')))
      .mode;
    const fileMode = (
      await stat(relayPath(root, 'tasks', 'session', 'state.json'))
    ).mode;
    expect(directoryMode & 0o777).toBe(0o700);
    expect(fileMode & 0o777).toBe(0o600);
  });

  it('migrates older archived tasks instead of hiding them', async () => {
    const root = await createRepository();
    directories.push(root);
    const directory = relayPath(root, 'tasks', 'legacy-session');
    await mkdir(directory, { recursive: true });
    const legacy = {
      ...state(root),
      schemaVersion: 3,
      sessionId: 'legacy-session',
      task: { ...state(root).task, status: 'completed' },
    } as Record<string, unknown>;
    delete legacy.notes;
    await writeFile(
      relayPath(root, 'tasks', 'legacy-session', 'state.json'),
      `${JSON.stringify(legacy)}\n`,
    );

    await expect(readArchivedStates(root)).resolves.toMatchObject([
      { schemaVersion: 8, sessionId: 'legacy-session', notes: [] },
    ]);
  });

  it('replaces tasks under one monotonic repository revision', async () => {
    const root = await createRepository();
    directories.push(root);
    await mkdir(relayPath(root), { recursive: true });
    const completed = state(root);
    completed.revision = 7;
    completed.task.status = 'completed';
    await writeState(root, completed);

    const replacement = await replaceState(root, () => {
      const next = state(root);
      next.sessionId = 'next-session';
      return next;
    });

    expect(replacement.revision).toBe(8);
    expect((await readState(root)).sessionId).toBe('next-session');
    expect((await readArchivedStates(root))[0]?.sessionId).toBe('session');
  });
});
