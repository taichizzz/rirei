import { describe, expect, it } from 'vitest';
import {
  formatDefaultSessionLabel,
  renameSessionLabel,
  validateSessionLabel,
} from '../../src/state/run-labels.js';
import {
  LATEST_STATE_SCHEMA,
  type RelayState,
} from '../../src/state/schema.js';
import { readState, writeState } from '../../src/state/store.js';
import { mkdir } from 'node:fs/promises';
import { relayPath } from '../../src/safety/path-policy.js';
import { createRepository, removeRepository } from '../helpers.js';

function makeState(root: string): RelayState {
  const now = '2026-01-01T00:00:00.000Z';
  return {
    schemaVersion: LATEST_STATE_SCHEMA,
    revision: 0,
    recentOperations: [],
    runs: [],
    sessionId: 'session-test',
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

describe('session labels', () => {
  it('formats deterministic session labels in launch order', () => {
    expect(formatDefaultSessionLabel('claude', 1)).toBe('Claude 1');
    expect(formatDefaultSessionLabel('claude', 2)).toBe('Claude 2');
    expect(formatDefaultSessionLabel('codex', 1)).toBe('Codex 1');
    expect(formatDefaultSessionLabel('opencode', 1)).toBe('OpenCode 1');
    expect(formatDefaultSessionLabel('custom-bot', 3)).toBe('Custom-bot 3');
  });

  it('validates session label strings', () => {
    expect(validateSessionLabel('Frontend Run')).toBe('Frontend Run');
    expect(validateSessionLabel('  Padded Label  ')).toBe('Padded Label');
    expect(() => validateSessionLabel('')).toThrow();
    expect(() => validateSessionLabel('a'.repeat(81))).toThrow();
    expect(() => validateSessionLabel('Line 1\nLine 2')).toThrow();
    expect(() => validateSessionLabel('Bad\x00Control')).toThrow();
  });

  it('atomically renames session labels in state', async () => {
    const root = await createRepository();
    try {
      await mkdir(relayPath(root), { recursive: true });
      const now = new Date().toISOString();
      const initial = makeState(root);
      initial.agentHistory = [
        {
          id: 'run-abc',
          displayLabel: 'Claude 1',
          agent: 'claude',
          startedAt: now,
        },
      ];
      initial.runs = [
        {
          runId: 'run-abc',
          displayLabel: 'Claude 1',
          agent: 'claude',
          worktreePath: root,
          projectRoot: root,
          launchMode: 'new',
          controller: {
            kind: 'cli',
            instanceId: 'inst',
            bootId: 'boot',
          },
          controllerId: 'cli:boot:inst',
          lifecycleStatus: 'working',
          activeRuntimeSeconds: 0,
          runtimeSequence: 0,
          startedAt: now,
          lastSeenAt: now,
          status: 'running',
        },
      ];
      await writeState(root, initial);

      const updated = await renameSessionLabel(
        root,
        'run-abc',
        'Investigate Bug #42',
      );
      expect(updated.runs[0]?.displayLabel).toBe('Investigate Bug #42');
      expect(updated.agentHistory[0]?.displayLabel).toBe('Investigate Bug #42');

      const reloaded = await readState(root);
      expect(reloaded.runs[0]?.displayLabel).toBe('Investigate Bug #42');
      expect(reloaded.agentHistory[0]?.displayLabel).toBe(
        'Investigate Bug #42',
      );
    } finally {
      await removeRepository(root);
    }
  });

  it('fails when renaming an unknown run ID', async () => {
    const root = await createRepository();
    try {
      await mkdir(relayPath(root), { recursive: true });
      await writeState(root, makeState(root));
      await expect(
        renameSessionLabel(root, 'unknown-run', 'New Label'),
      ).rejects.toThrow(/was not found/);
    } finally {
      await removeRepository(root);
    }
  });
});
