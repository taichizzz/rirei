import { describe, expect, it } from 'vitest';
import {
  acquireLease,
  activeLeases,
  leaseForWorkspace,
  leaseForWorktree,
  markLeaseOrphaned,
  releaseLease,
} from '../../src/state/leases.js';
import type { RelayState, RunLease } from '../../src/state/schema.js';

const NOW = '2026-01-01T00:00:00.000Z';

function state(): RelayState {
  return {
    schemaVersion: 4,
    revision: 0,
    recentOperations: [],
    runs: [],
    sessionId: 'session',
    projectRoot: '/repo',
    task: {
      title: 'Task',
      originalRequest: 'Task',
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

function lease(overrides: Partial<RunLease> = {}): RunLease {
  return {
    runId: 'run-1',
    worktreePath: '/repo',
    projectRoot: '/repo',
    agent: 'claude',
    launchMode: 'new',
    controllerId: 'cli:1',
    startedAt: NOW,
    lastSeenAt: NOW,
    status: 'running',
    ...overrides,
  };
}

describe('run leases', () => {
  it('claims a worktree and mirrors the derived compatibility fields', () => {
    const next = acquireLease(state(), lease({ agent: 'codex' }));
    expect(next.runs).toHaveLength(1);
    expect(next.currentAgent).toBe('codex');
    expect(next.currentRunId).toBe('run-1');
  });

  it('rejects a second writing run in the same worktree', () => {
    const first = acquireLease(state(), lease());
    expect(() =>
      acquireLease(first, lease({ runId: 'run-2', agent: 'codex' })),
    ).toThrow(/already running in this working tree/);
  });

  it('treats equivalent worktree paths as the same working tree', () => {
    const first = acquireLease(state(), lease({ worktreePath: '/repo' }));
    expect(() =>
      acquireLease(first, lease({ runId: 'run-2', worktreePath: '/repo/./' })),
    ).toThrow(/already running/);
  });

  it('allows concurrent runs when their worktrees differ', () => {
    const first = acquireLease(state(), lease());
    const second = acquireLease(
      first,
      lease({
        runId: 'run-2',
        agent: 'codex',
        worktreePath: '/worktrees/ws-2',
        workspaceId: 'ws-2',
      }),
    );
    expect(activeLeases(second)).toHaveLength(2);
    // The derived mirror points at the first active lease.
    expect(second.currentRunId).toBe('run-1');
  });

  it('is idempotent when the same run re-acquires its lease', () => {
    const first = acquireLease(state(), lease());
    const again = acquireLease(first, lease());
    expect(again.runs).toHaveLength(1);
  });

  it('releases a lease idempotently', () => {
    const first = acquireLease(state(), lease());
    const released = releaseLease(first, 'run-1');
    expect(released.runs).toHaveLength(0);
    expect(released.currentAgent).toBeUndefined();
    expect(releaseLease(released, 'run-1').runs).toHaveLength(0);
  });

  it('frees the worktree for a new run once released', () => {
    const first = acquireLease(state(), lease());
    const released = releaseLease(first, 'run-1');
    const reused = acquireLease(released, lease({ runId: 'run-2' }));
    expect(reused.runs).toHaveLength(1);
    expect(reused.currentRunId).toBe('run-2');
  });

  it('keeps an orphaned worktree claimed until explicit recovery', () => {
    const first = acquireLease(state(), lease());
    const orphaned = markLeaseOrphaned(first, 'run-1');
    // The lease record survives for inspection...
    expect(orphaned.runs).toHaveLength(1);
    expect(orphaned.runs[0]!.status).toBe('orphaned');
    // Unknown process ownership must block another writer and cleanup.
    expect(activeLeases(orphaned)).toHaveLength(1);
    expect(leaseForWorktree(orphaned, '/repo')?.runId).toBe('run-1');
    expect(() => acquireLease(orphaned, lease({ runId: 'run-2' }))).toThrow(
      /already running/,
    );
  });

  it('finds the lease owning a workspace', () => {
    const next = acquireLease(
      state(),
      lease({ workspaceId: 'ws-1', worktreePath: '/worktrees/ws-1' }),
    );
    expect(leaseForWorkspace(next, 'ws-1')?.runId).toBe('run-1');
    expect(leaseForWorkspace(next, 'ws-missing')).toBeUndefined();
  });
});
