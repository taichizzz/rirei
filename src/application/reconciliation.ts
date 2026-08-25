import { hostname } from 'node:os';
import { currentBootId } from './controller.js';
import { appendEvent } from '../state/events.js';
import { markLeaseOrphaned } from '../state/leases.js';
import { readTerminalJournal } from '../state/journal.js';
import type { RelayState } from '../state/schema.js';
import { updateState } from '../state/store.js';

export type ReconciliationStatus = 'live' | 'needs_attention' | 'orphaned';

export interface ReconciledRun {
  runId: string;
  agent: string;
  terminalId?: string;
  workspaceId?: string;
  providerSessionId?: string;
  journalStatus?: string;
  lastSeenAt: string;
  status: ReconciliationStatus;
  reason:
    | 'daemon_inventory'
    | 'terminal_missing'
    | 'process_alive'
    | 'process_gone'
    | 'different_boot'
    | 'unverifiable';
}

export interface DaemonInventoryEvidence {
  instanceId: string;
  pid: number;
  bootId: string;
  /** A complete global inventory, including an intentionally empty set. */
  terminalIds: ReadonlySet<string>;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export async function reconcileProjectRuns(
  projectRoot: string,
  daemonInventory?: DaemonInventoryEvidence,
): Promise<{
  state: RelayState;
  runs: ReconciledRun[];
}> {
  const results: ReconciledRun[] = [];
  const orphaned: ReconciledRun[] = [];
  const bootId = currentBootId();
  const host = hostname();
  const journal = await readTerminalJournal(projectRoot);
  const state = await updateState(projectRoot, (current) => {
    let next = current;
    for (const lease of current.runs) {
      const controller = lease.controller;
      const history = current.agentHistory.find(
        (run) => run.id === lease.runId,
      );
      const journalEntry = journal.entries.findLast(
        (entry) => entry.terminalId === lease.terminalId,
      );
      const metadata = {
        providerSessionId: history?.providerSessionId,
        journalStatus: journalEntry?.expectedStatus,
      };
      const controllerHost = controller.bootId.split(':', 1)[0];
      let result: ReconciledRun;
      if (lease.terminalId && daemonInventory) {
        if (daemonInventory.terminalIds.has(lease.terminalId)) {
          const daemonController = {
            kind: 'daemon' as const,
            instanceId: daemonInventory.instanceId,
            pid: daemonInventory.pid,
            bootId: daemonInventory.bootId,
          };
          next = {
            ...next,
            runs: next.runs.map((item) =>
              item.runId === lease.runId
                ? {
                    ...item,
                    controller: daemonController,
                    controllerId: `daemon:${daemonController.bootId}:${daemonController.instanceId}`,
                    lastSeenAt: new Date().toISOString(),
                  }
                : item,
            ),
          };
          result = {
            runId: lease.runId,
            agent: lease.agent,
            terminalId: lease.terminalId,
            workspaceId: lease.workspaceId,
            lastSeenAt: lease.lastSeenAt,
            ...metadata,
            status: 'live',
            reason: 'daemon_inventory',
          };
        } else {
          next = markLeaseOrphaned(next, lease.runId);
          result = {
            runId: lease.runId,
            agent: lease.agent,
            terminalId: lease.terminalId,
            workspaceId: lease.workspaceId,
            lastSeenAt: lease.lastSeenAt,
            ...metadata,
            status: 'orphaned',
            reason: 'terminal_missing',
          };
          orphaned.push(result);
        }
      } else if (controllerHost !== host || controller.bootId !== bootId) {
        result = {
          runId: lease.runId,
          agent: lease.agent,
          terminalId: lease.terminalId,
          workspaceId: lease.workspaceId,
          lastSeenAt: lease.lastSeenAt,
          ...metadata,
          status: 'needs_attention',
          reason: 'different_boot',
        };
      } else if (!controller.pid) {
        result = {
          runId: lease.runId,
          agent: lease.agent,
          terminalId: lease.terminalId,
          workspaceId: lease.workspaceId,
          lastSeenAt: lease.lastSeenAt,
          ...metadata,
          status: 'needs_attention',
          reason: 'unverifiable',
        };
      } else if (processIsAlive(controller.pid)) {
        result = {
          runId: lease.runId,
          agent: lease.agent,
          terminalId: lease.terminalId,
          workspaceId: lease.workspaceId,
          lastSeenAt: lease.lastSeenAt,
          ...metadata,
          status: 'live',
          reason: 'process_alive',
        };
      } else {
        next = markLeaseOrphaned(next, lease.runId);
        result = {
          runId: lease.runId,
          agent: lease.agent,
          terminalId: lease.terminalId,
          workspaceId: lease.workspaceId,
          lastSeenAt: lease.lastSeenAt,
          ...metadata,
          status: 'orphaned',
          reason: 'process_gone',
        };
        orphaned.push(result);
      }
      results.push(result);
    }
    return next;
  });
  for (const run of orphaned)
    await appendEvent(projectRoot, 'agent_orphaned', {
      runId: run.runId,
      reason:
        run.reason === 'terminal_missing'
          ? 'daemon_terminal_missing'
          : 'controller_process_gone',
    });
  return { state, runs: results };
}
