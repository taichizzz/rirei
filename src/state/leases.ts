import path from 'node:path';
import type { RelayState, RunLease } from './schema.js';

/** Statuses that still hold a claim on a worktree. */
const ACTIVE_STATUSES = new Set<RunLease['status']>([
  'starting',
  'running',
  'waiting',
  'stopping',
  'orphaned',
]);

export function isActiveLease(lease: RunLease): boolean {
  return ACTIVE_STATUSES.has(lease.status);
}

export function activeLeases(state: RelayState): RunLease[] {
  return state.runs.filter(isActiveLease);
}

function sameWorktree(a: string, b: string): boolean {
  return path.resolve(a) === path.resolve(b);
}

/** The active lease currently claiming `worktreePath`, if any. */
export function leaseForWorktree(
  state: RelayState,
  worktreePath: string,
): RunLease | undefined {
  return activeLeases(state).find((lease) =>
    sameWorktree(lease.worktreePath, worktreePath),
  );
}

/** The active lease claiming a given workspace, if any. */
export function leaseForWorkspace(
  state: RelayState,
  workspaceId: string,
): RunLease | undefined {
  return activeLeases(state).find((lease) => lease.workspaceId === workspaceId);
}

/**
 * Recompute the derived `currentAgent`/`currentRunId` mirrors from the lease
 * array. Existing frontends still read these; `runs` is authoritative.
 */
function withDerivedFields(state: RelayState): RelayState {
  const first = activeLeases(state)[0];
  return {
    ...state,
    currentAgent: first?.agent,
    currentRunId: first?.runId,
  };
}

/**
 * Claim a worktree for a run. Enforces the core concurrency invariant: at most
 * one writing run per worktree. Several runs may exist for one repository only
 * when their worktrees differ.
 *
 * Call inside `updateState` so the check and the write share the writer lock.
 */
export function acquireLease(state: RelayState, lease: RunLease): RelayState {
  const existing = leaseForWorktree(state, lease.worktreePath);
  if (existing && existing.runId !== lease.runId)
    throw new Error(
      `${existing.agent} is already running in this working tree ` +
        `(run ${existing.runId}). Create a separate workspace to run agents concurrently.`,
    );
  if (state.runs.some((item) => item.runId === lease.runId))
    // Idempotent: re-acquiring the same run is a no-op, not a duplicate.
    return withDerivedFields(state);
  return withDerivedFields({ ...state, runs: [...state.runs, lease] });
}

/**
 * Release a run's claim. Idempotent, so a duplicate exit callback cannot
 * double-finalize.
 */
export function releaseLease(state: RelayState, runId: string): RelayState {
  return withDerivedFields({
    ...state,
    runs: state.runs.filter((lease) => lease.runId !== runId),
  });
}

/**
 * Mark a lease's owner as gone without claiming the provider process ended.
 * A frontend crash makes ownership uncertain — it is not proof of exit.
 */
export function markLeaseOrphaned(
  state: RelayState,
  runId: string,
): RelayState {
  return withDerivedFields({
    ...state,
    runs: state.runs.map((lease) =>
      lease.runId === runId
        ? {
            ...lease,
            status: 'orphaned' as const,
            lastSeenAt: new Date().toISOString(),
          }
        : lease,
    ),
  });
}

export function touchLease(state: RelayState, runId: string): RelayState {
  return withDerivedFields({
    ...state,
    runs: state.runs.map((lease) =>
      lease.runId === runId
        ? { ...lease, lastSeenAt: new Date().toISOString() }
        : lease,
    ),
  });
}
