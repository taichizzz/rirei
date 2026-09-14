import { markLeaseOrphaned } from '../state/leases.js';
import { appendEvent } from '../state/events.js';
import type { RelayState, RunLease } from '../state/schema.js';
import { readState, updateState } from '../state/store.js';
import { syncActivity } from '../state/activity.js';

export interface HeartbeatOptions {
  /** How often a live owner refreshes its leases' `lastSeenAt`. */
  intervalMs?: number;
  /** A lease is stale once untouched for this long. */
  staleAfterMs?: number;
}

const DEFAULT_INTERVAL_MS = 5_000;

function ownerMatches(lease: RunLease, controllerId: string): boolean {
  return lease.controllerId === controllerId;
}

function now(): string {
  return new Date().toISOString();
}

/** Shared mutation that refreshes `lastSeenAt` on leases owned by a controller. */
export function touchControllerLeases(
  state: RelayState,
  controllerId: string,
): RelayState {
  let changed = false;
  const lastSeenAt = now();
  const runs = state.runs.map((lease) => {
    if (
      !ownerMatches(lease, controllerId) ||
      lease.status === 'orphaned' ||
      lease.status === 'stopping'
    )
      return lease;
    changed = true;
    return { ...lease, lastSeenAt };
  });
  return changed ? { ...state, runs } : state;
}

/**
 * A live process attests to its runs by periodically stamping `lastSeenAt`.
 * If that stamp goes stale, the controller can no longer prove it owns the
 * provider process, so the lease is a candidate for orphaning.
 */
export class ControllerHeartbeat {
  private timer: NodeJS.Timeout | null = null;
  private readonly intervalMs: number;

  constructor(
    private readonly projectRoot: string,
    private readonly controllerId: string,
    options: HeartbeatOptions = {},
  ) {
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    void options.staleAfterMs;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick().catch(() => undefined);
    }, this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Periodic heartbeat handler: avoids state revisions when there are no active
   * owned leases, publishes activity snapshot, and stops after daemon adoption.
   */
  async tick(): Promise<void> {
    try {
      const current = await readState(this.projectRoot);
      const hasActiveOwned = current.runs.some(
        (lease) =>
          ownerMatches(lease, this.controllerId) &&
          lease.status !== 'orphaned' &&
          lease.status !== 'stopping',
      );
      const daemonAdopted = current.runs.some(
        (lease) =>
          lease.controller?.kind === 'daemon' ||
          lease.controllerId?.startsWith('daemon:'),
      );
      if (daemonAdopted && !hasActiveOwned) {
        this.stop();
      }
      if (!hasActiveOwned) {
        await syncActivity(this.projectRoot, current).catch(() => undefined);
        return;
      }
    } catch {
      // If state cannot be read, fall through to beat
    }
    await this.beat(true);
  }

  /** Stamp owned leases now. Staleness alone never proves another owner died. */
  async beat(skipUnchanged = false): Promise<void> {
    await updateState(
      this.projectRoot,
      (current) => touchControllerLeases(current, this.controllerId),
      { opId: undefined, skipUnchanged },
    );
  }

  /**
   * Explicitly orphan every lease this controller owns. Used on graceful
   * shutdown so ownership becomes `orphaned` instead of silently `running`.
   */
  async orphanOwned(): Promise<void> {
    const orphanedRunIds: string[] = [];
    await updateState(
      this.projectRoot,
      (current) => {
        let next = current;
        for (const lease of current.runs) {
          if (
            ownerMatches(lease, this.controllerId) &&
            lease.status !== 'orphaned'
          ) {
            orphanedRunIds.push(lease.runId);
            next = markLeaseOrphaned(next, lease.runId);
          }
        }
        return next;
      },
      { opId: undefined, skipUnchanged: true },
    );
    for (const runId of orphanedRunIds)
      await appendEvent(this.projectRoot, 'agent_orphaned', {
        runId,
        controllerId: this.controllerId,
        reason: 'controller_disconnected',
      });
  }
}

/** Stamp the leases of a controller that calls in from the CLI. */
export async function touchOwnedLeases(
  projectRoot: string,
  controllerId: string,
): Promise<RelayState> {
  return updateState(
    projectRoot,
    (current) => touchControllerLeases(current, controllerId),
    { opId: undefined },
  );
}
