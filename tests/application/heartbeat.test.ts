import { mkdir } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { ControllerHeartbeat } from '../../src/application/heartbeat.js';
import { relayPath } from '../../src/safety/path-policy.js';
import type { RelayState, RunLease } from '../../src/state/schema.js';
import { readState, writeState } from '../../src/state/store.js';
import { createRepository, removeRepository } from '../helpers.js';

const roots: string[] = [];
const NOW = '2026-01-01T00:00:00.000Z';

function state(root: string): RelayState {
  return {
    schemaVersion: 8,
    revision: 0,
    recentOperations: [],
    runs: [],
    sessionId: 'session',
    projectRoot: root,
    task: {
      title: 'Heartbeat',
      originalRequest: 'Heartbeat',
      requirements: [],
      constraints: [],
      status: 'active',
      createdAt: NOW,
      updatedAt: NOW,
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

function lease(
  runId: string,
  controllerId: string,
  lastSeenAt: string,
): RunLease {
  return {
    runId,
    worktreePath: '/worktrees/' + runId,
    projectRoot: '/worktrees',
    agent: 'claude',
    launchMode: 'new',
    controllerId,
    controller: {
      kind: 'cli',
      instanceId: controllerId.split(':').at(-1) ?? 'id',
      pid: 1,
      bootId: 'test-boot',
    },
    lifecycleStatus: 'working',
    activeRuntimeSeconds: 0,
    runtimeSequence: 0,
    startedAt: NOW,
    lastSeenAt,
    status: 'running',
  };
}

async function project(): Promise<{ root: string; state: RelayState }> {
  const root = await createRepository();
  roots.push(root);
  await mkdir(relayPath(root), { recursive: true });
  const initialState = state(root);
  await writeState(root, initialState);
  return { root, state: initialState };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeRepository));
});

describe('controller heartbeat', () => {
  it('touches owned leases so a live run never goes stale', async () => {
    const { root, state: currentState } = await project();
    const controllerId = 'cli:heartbeat-owner';
    await writeState(root, {
      ...currentState,
      runs: [lease('run-owned', controllerId, NOW)],
    });
    await new ControllerHeartbeat(root, controllerId).beat();
    const persisted = await readState(root);
    expect(persisted.runs[0]?.lastSeenAt).not.toBe(NOW);
  });

  it('never treats an old heartbeat alone as proof another owner died', async () => {
    const { root, state } = await project();
    state.runs = [
      lease('run-live', 'cli:live', new Date().toISOString()),
      lease('run-dead', 'cli:dead', '2026-01-01T00:00:00.000Z'),
    ];
    await writeState(root, state);

    const heartbeat = new ControllerHeartbeat(root, 'cli:live', {
      staleAfterMs: 1_000,
    });
    await heartbeat.beat();

    const persisted = await readState(root);
    const dead = persisted.runs.find((run) => run.runId === 'run-dead');
    const live = persisted.runs.find((run) => run.runId === 'run-live');
    expect(dead?.status).toBe('running');
    expect(live?.status).toBe('running');
  });

  it('never orphans a live owners own leases during a beat', async () => {
    const { root, state } = await project();
    state.runs = [lease('run-own', 'cli:own', new Date().toISOString())];
    await writeState(root, state);
    await new ControllerHeartbeat(root, 'cli:own', {
      staleAfterMs: 1_000,
      intervalMs: 10_000,
    }).beat();
    expect((await readState(root)).runs[0]?.status).toBe('running');
  });

  it('orphans every owned lease on graceful shutdown', async () => {
    const { root, state } = await project();
    state.runs = [
      lease('run-a', 'cli:teardown', new Date().toISOString()),
      lease('run-b', 'cli:teardown', new Date().toISOString()),
    ];
    await writeState(root, state);
    await new ControllerHeartbeat(root, 'cli:teardown').orphanOwned();
    const persisted = await readState(root);
    expect(persisted.runs.every((run) => run.status === 'orphaned')).toBe(true);
  });
});
