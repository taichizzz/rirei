import { mkdir } from 'node:fs/promises';
import { hostname } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { currentBootId } from '../../src/application/controller.js';
import { reconcileProjectRuns } from '../../src/application/reconciliation.js';
import { relayPath } from '../../src/safety/path-policy.js';
import type { RelayState, RunLease } from '../../src/state/schema.js';
import { writeState } from '../../src/state/store.js';
import { appendTerminalJournal } from '../../src/state/journal.js';
import { createRepository, removeRepository } from '../helpers.js';

const roots: string[] = [];
const NOW = '2026-01-01T00:00:00.000Z';

function state(root: string, lease: RunLease): RelayState {
  return {
    schemaVersion: 8,
    revision: 0,
    recentOperations: [],
    runs: [lease],
    sessionId: 'session',
    projectRoot: root,
    task: {
      title: 'Reconcile',
      originalRequest: 'Reconcile',
      requirements: [],
      constraints: [],
      status: 'active',
      createdAt: NOW,
      updatedAt: NOW,
    },
    git: { startingCommit: 'abc', startingBranch: 'main', dirtyAtStart: false },
    agentHistory: [{ id: lease.runId, agent: lease.agent, startedAt: NOW }],
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
  root: string,
  pid: number | undefined,
  bootId: string,
): RunLease {
  return {
    runId: 'run',
    terminalId: 'terminal',
    worktreePath: root,
    projectRoot: root,
    agent: 'opencode',
    launchMode: 'new',
    controllerId: `desktop:${bootId}:terminal`,
    controller: { kind: 'desktop', instanceId: 'terminal', pid, bootId },
    lifecycleStatus: 'working',
    activeRuntimeSeconds: 0,
    runtimeSequence: 0,
    startedAt: NOW,
    lastSeenAt: NOW,
    status: 'running',
  };
}

async function project(leaseFactory: (root: string) => RunLease) {
  const root = await createRepository();
  roots.push(root);
  await mkdir(relayPath(root), { recursive: true });
  await writeState(root, state(root, leaseFactory(root)));
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeRepository));
});

describe('run reconciliation', () => {
  it('adopts a terminal proven live by the complete daemon inventory', async () => {
    const root = await project((value) =>
      lease(value, 2_147_483_647, `${hostname()}:older-boot`),
    );
    const result = await reconcileProjectRuns(root, {
      instanceId: 'daemon-a',
      pid: process.pid,
      bootId: currentBootId(),
      terminalIds: new Set(['terminal']),
    });
    expect(result.runs[0]).toMatchObject({
      status: 'live',
      reason: 'daemon_inventory',
    });
    expect(result.state.runs[0]?.controller).toMatchObject({
      kind: 'daemon',
      instanceId: 'daemon-a',
      pid: process.pid,
    });
  });

  it('orphans but retains a lease missing from complete daemon inventory', async () => {
    const root = await project((value) =>
      lease(value, process.pid, currentBootId()),
    );
    const result = await reconcileProjectRuns(root, {
      instanceId: 'daemon-a',
      pid: process.pid,
      bootId: currentBootId(),
      terminalIds: new Set(),
    });
    expect(result.runs[0]).toMatchObject({
      status: 'orphaned',
      reason: 'terminal_missing',
    });
    expect(result.state.runs).toHaveLength(1);
    expect(result.state.runs[0]).toMatchObject({
      status: 'orphaned',
      lifecycleStatus: 'orphaned',
    });
  });

  it('leaves a provably live same-boot controller untouched', async () => {
    const root = await project((value) =>
      lease(value, process.pid, currentBootId()),
    );
    await appendTerminalJournal(root, {
      at: new Date().toISOString(),
      terminalId: 'terminal',
      event: 'status',
      detail: 'running',
    });
    const result = await reconcileProjectRuns(root);
    expect(result.runs[0]).toMatchObject({
      status: 'live',
      reason: 'process_alive',
      journalStatus: 'running',
    });
    expect(result.state.runs[0]?.status).toBe('running');
  });

  it('orphans a conclusively missing same-boot local controller', async () => {
    const root = await project((value) =>
      lease(value, 2_147_483_647, currentBootId()),
    );
    const result = await reconcileProjectRuns(root);
    expect(result.runs[0]).toMatchObject({
      status: 'orphaned',
      reason: 'process_gone',
    });
    expect(result.state.runs[0]?.status).toBe('orphaned');
  });

  it('does not trust a reused pid from another boot', async () => {
    const root = await project((value) =>
      lease(value, process.pid, `${hostname()}:different-boot`),
    );
    const result = await reconcileProjectRuns(root);
    expect(result.runs[0]).toMatchObject({
      status: 'needs_attention',
      reason: 'different_boot',
    });
    expect(result.state.runs[0]?.status).toBe('running');
  });

  it('never releases an unverifiable worktree merely because its heartbeat is old', async () => {
    const root = await project((value) =>
      lease(value, undefined, currentBootId()),
    );
    const result = await reconcileProjectRuns(root);
    expect(result.runs[0]).toMatchObject({
      status: 'needs_attention',
      reason: 'unverifiable',
    });
    expect(result.state.runs).toHaveLength(1);
  });
});
