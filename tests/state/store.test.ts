import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { relayPath } from '../../src/safety/path-policy.js';
import { type RelayState } from '../../src/state/schema.js';
import { readState, writeState } from '../../src/state/store.js';
import { createRepository, removeRepository } from '../helpers.js';

const directories: string[] = [];

function state(root: string): RelayState {
  const now = '2026-01-01T00:00:00.000Z';
  return {
    schemaVersion: 1,
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
});
