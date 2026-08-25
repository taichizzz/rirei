import { Command } from 'commander';
import { discoverRepository } from '../git/repository.js';
import type {
  RunAttentionKind,
  RunLifecycleStatus,
  RunLeaseStatus,
} from '../state/schema.js';
import { updateState } from '../state/store.js';

const terminalStatuses = new Set([
  'starting',
  'running',
  'waiting',
  'stopping',
  'completed',
  'failed',
  'cancelled',
  'orphaned',
]);
const lifecycleStates = new Set<RunLifecycleStatus>([
  'starting',
  'working',
  'needs_permission',
  'waiting_for_input',
  'stopping',
  'completed',
  'failed',
  'cancelled',
  'orphaned',
]);
const attentionKinds = new Set<RunAttentionKind>([
  'permission',
  'input',
  'unknown',
]);
const activeLifecycleStates = new Set<RunLifecycleStatus>([
  'starting',
  'working',
  'needs_permission',
  'waiting_for_input',
]);

function lifecycleFor(
  status: string,
  attentionKind: RunAttentionKind | undefined,
): RunLifecycleStatus {
  if (status === 'running') return 'working';
  if (status === 'waiting')
    return attentionKind === 'permission'
      ? 'needs_permission'
      : 'waiting_for_input';
  return status as RunLifecycleStatus;
}

function leaseStatusFor(status: string): RunLeaseStatus | undefined {
  return ['starting', 'running', 'waiting', 'stopping', 'orphaned'].includes(
    status,
  )
    ? (status as RunLeaseStatus)
    : undefined;
}

export function bridgeCommand(): Command {
  return new Command('bridge')
    .description('Register bridge identity for an active terminal-owned run')
    .requiredOption('--terminal-id <id>')
    .option('--instance-id <id>')
    .option('--pid <pid>')
    .option('--protocol-version <version>')
    .option('--status <status>')
    .option('--lifecycle-state <state>')
    .option('--attention-kind <kind>')
    .option('--active-runtime-seconds <seconds>')
    .option('--runtime-sequence <sequence>')
    .option('--daemon-id <id>')
    .option('--daemon-pid <pid>')
    .option('--daemon-boot-id <id>')
    .action(
      async (options: {
        terminalId: string;
        instanceId?: string;
        pid?: string;
        protocolVersion?: string;
        status?: string;
        lifecycleState?: string;
        attentionKind?: string;
        activeRuntimeSeconds?: string;
        runtimeSequence?: string;
        daemonId?: string;
        daemonPid?: string;
        daemonBootId?: string;
      }) => {
        const projectRoot = await discoverRepository(process.cwd());
        if (!projectRoot)
          throw new Error('Relay must be run inside a Git repository.');
        if (options.status) {
          const terminalStatus = options.status;
          if (!terminalStatuses.has(terminalStatus))
            throw new Error('Invalid terminal lifecycle status.');
          if (
            options.attentionKind &&
            !attentionKinds.has(options.attentionKind as RunAttentionKind)
          )
            throw new Error('Invalid terminal attention kind.');
          const attentionKind = options.attentionKind as
            RunAttentionKind | undefined;
          const lifecycleStatus = options.lifecycleState
            ? (options.lifecycleState as RunLifecycleStatus)
            : lifecycleFor(terminalStatus, attentionKind);
          if (!lifecycleStates.has(lifecycleStatus))
            throw new Error('Invalid normalized lifecycle state.');
          if (lifecycleStatus !== lifecycleFor(terminalStatus, attentionKind))
            throw new Error(
              'Terminal and normalized lifecycle states disagree.',
            );
          const activeRuntimeSeconds = options.activeRuntimeSeconds
            ? Number(options.activeRuntimeSeconds)
            : undefined;
          if (
            activeRuntimeSeconds !== undefined &&
            (!Number.isFinite(activeRuntimeSeconds) || activeRuntimeSeconds < 0)
          )
            throw new Error('Invalid active runtime.');
          const runtimeSequence = options.runtimeSequence
            ? Number(options.runtimeSequence)
            : undefined;
          if (
            runtimeSequence !== undefined &&
            (!Number.isSafeInteger(runtimeSequence) || runtimeSequence < 0)
          )
            throw new Error('Invalid runtime sequence.');
          const daemonFields = [
            options.daemonId,
            options.daemonPid,
            options.daemonBootId,
          ];
          if (daemonFields.some(Boolean) && !daemonFields.every(Boolean))
            throw new Error('Daemon identity is incomplete.');
          const daemonPid = options.daemonPid
            ? Number.parseInt(options.daemonPid, 10)
            : undefined;
          if (
            daemonPid !== undefined &&
            (!Number.isInteger(daemonPid) || daemonPid <= 0)
          )
            throw new Error('Invalid daemon identity.');
          const controller = options.daemonId
            ? {
                kind: 'daemon' as const,
                instanceId: options.daemonId,
                pid: daemonPid!,
                bootId: options.daemonBootId!,
              }
            : undefined;
          let updated = false;
          const now = new Date().toISOString();
          await updateState(projectRoot, (current) => {
            const runs = current.runs.map((lease) => {
              if (lease.terminalId !== options.terminalId) return lease;
              updated = true;
              const sequence = runtimeSequence ?? lease.runtimeSequence + 1;
              if (sequence < lease.runtimeSequence) return lease;
              if (
                ['stopping', 'orphaned'].includes(lease.status) &&
                activeLifecycleStates.has(lifecycleStatus)
              )
                return lease;
              return {
                ...lease,
                ...(leaseStatusFor(terminalStatus)
                  ? { status: leaseStatusFor(terminalStatus)! }
                  : {}),
                lifecycleStatus,
                ...(lifecycleStatus === 'needs_permission' ||
                lifecycleStatus === 'waiting_for_input'
                  ? { attentionKind: attentionKind ?? 'unknown' }
                  : { attentionKind: undefined }),
                activeRuntimeSeconds: Math.max(
                  lease.activeRuntimeSeconds,
                  activeRuntimeSeconds ?? lease.activeRuntimeSeconds,
                ),
                runtimeSequence: sequence,
                ...(controller
                  ? {
                      controller,
                      controllerId: `daemon:${controller.bootId}:${controller.instanceId}`,
                    }
                  : {}),
                lastSeenAt: now,
              };
            });
            const agentHistory = current.agentHistory.map((run) => {
              if (run.terminalId !== options.terminalId) return run;
              updated = true;
              const sequence =
                runtimeSequence ?? (run.runtimeSequence ?? 0) + 1;
              if (sequence < (run.runtimeSequence ?? 0)) return run;
              if (run.endedAt && activeLifecycleStates.has(lifecycleStatus))
                return run;
              return {
                ...run,
                lifecycleStatus,
                ...(lifecycleStatus === 'needs_permission' ||
                lifecycleStatus === 'waiting_for_input'
                  ? { attentionKind: attentionKind ?? 'unknown' }
                  : { attentionKind: undefined }),
                activeRuntimeSeconds: Math.max(
                  run.activeRuntimeSeconds ?? 0,
                  activeRuntimeSeconds ?? run.activeRuntimeSeconds ?? 0,
                ),
                runtimeSequence: sequence,
              };
            });
            return { ...current, runs, agentHistory };
          });
          if (!updated)
            throw new Error('The terminal-owned run is not ready yet.');
          return;
        }
        if (!options.instanceId || !options.pid || !options.protocolVersion)
          throw new Error('Bridge identity is incomplete.');
        const instanceId = options.instanceId;
        const pid = Number.parseInt(options.pid, 10);
        const protocolVersion = Number.parseInt(options.protocolVersion, 10);
        if (!Number.isInteger(pid) || pid <= 0 || protocolVersion !== 1)
          throw new Error('Invalid bridge identity.');
        let registered = false;
        await updateState(projectRoot, (current) => ({
          ...current,
          runs: current.runs.map((lease) =>
            lease.terminalId === options.terminalId
              ? ((registered = true),
                {
                  ...lease,
                  bridgeIdentity: {
                    instanceId,
                    pid,
                    protocolVersion: 1 as const,
                  },
                })
              : lease,
          ),
        }));
        if (!registered)
          throw new Error('The terminal-owned run is not ready yet.');
      },
    );
}
