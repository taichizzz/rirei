import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  readValidatedActivitySnapshot,
  validateActivitySnapshot,
} from '../../desktop/activity-snapshot.mjs';
import { removeRepository } from '../helpers.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(removeRepository));
});

function snapshot() {
  const now = '2026-08-02T00:00:00.000Z';
  return {
    schemaVersion: 1,
    instanceId: 'instance',
    updatedAt: now,
    sessions: [
      {
        id: 'terminal',
        runId: 'run',
        workspaceId: 'main',
        agent: 'codex',
        projectLabel: 'Project',
        taskLabel: 'Task',
        branchLabel: 'main',
        role: 'implement',
        status: 'working',
        message: 'Agent is working',
        startedAt: now,
        updatedAt: now,
        needsAttention: false,
      },
    ],
  };
}

describe('desktop activity snapshot boundary', () => {
  test('accepts and clones the exact schema', () => {
    const value = snapshot();
    const validated = validateActivitySnapshot(value);
    expect(validated).toEqual(value);
    expect(validated).not.toBe(value);
    expect(
      validateActivitySnapshot({
        ...value,
        updatedAt: '2026-08-02T00:00:00Z',
      }),
    ).not.toBeNull();
  });

  test('rejects extra fields, future schemas, bad statuses, and oversized arrays', () => {
    expect(validateActivitySnapshot({ ...snapshot(), events: [] })).toBeNull();
    expect(
      validateActivitySnapshot({ ...snapshot(), schemaVersion: 2 }),
    ).toBeNull();
    expect(
      validateActivitySnapshot({
        ...snapshot(),
        sessions: [{ ...snapshot().sessions[0], status: 'running' }],
      }),
    ).toBeNull();
    expect(
      validateActivitySnapshot({
        ...snapshot(),
        sessions: Array.from({ length: 129 }, () => snapshot().sessions[0]),
      }),
    ).toBeNull();
  });

  test('reads a bounded file and handles a missing snapshot', async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), 'rirei-desktop-activity-'),
    );
    directories.push(directory);
    const file = path.join(directory, 'activity.json');
    await expect(readValidatedActivitySnapshot(file)).resolves.toBeNull();
    await writeFile(file, JSON.stringify(snapshot()));
    await expect(readValidatedActivitySnapshot(file)).resolves.toEqual(
      snapshot(),
    );
  });
});
