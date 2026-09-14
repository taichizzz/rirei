import { Command } from 'commander';
import {
  AGENT_EXIT_REASONS,
  EXIT_CLASSIFICATION_SOURCES,
  type ExitClassification,
} from '../agents/adapter.js';
import { finalizeTerminalRun } from '../application/sessions.js';
import { discoverRepository } from '../git/repository.js';
import type {
  RunAttentionKind,
  RunLifecycleStatus,
  RunLeaseStatus,
} from '../state/schema.js';
import { readState, updateState } from '../state/store.js';

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
const BRIDGE_WORKER_PROTOCOL_VERSION = 1;
const BRIDGE_WORKER_MAX_FRAME_BYTES = 128 * 1024;

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

export interface BridgeObservationInput {
  status?: string;
  lifecycleState?: string;
  attentionKind?: string;
  activeRuntimeSeconds?: string | number;
  runtimeSequence?: string | number;
  daemonId?: string;
  daemonPid?: string | number;
  daemonBootId?: string;
  exitCode?: string | number | null;
  exitReason?: string;
  exitConfidence?: string;
  exitSource?: string;
  providerCode?: string;
  retryAt?: string;
  daemon?: {
    instanceId?: string;
    pid?: number;
    bootId?: string;
  };
  providerResult?: ExitClassification;
}

export async function executeBridgeObservation(
  projectRoot: string,
  terminalId: string,
  options: BridgeObservationInput,
): Promise<void> {
  const terminalStatus = options.status;
  if (!terminalStatus || !terminalStatuses.has(terminalStatus))
    throw new Error('Invalid terminal lifecycle status.');
  if (
    options.attentionKind &&
    !attentionKinds.has(options.attentionKind as RunAttentionKind)
  )
    throw new Error('Invalid terminal attention kind.');
  const attentionKind = options.attentionKind as RunAttentionKind | undefined;
  const lifecycleStatus = options.lifecycleState
    ? (options.lifecycleState as RunLifecycleStatus)
    : lifecycleFor(terminalStatus, attentionKind);
  if (!lifecycleStates.has(lifecycleStatus))
    throw new Error('Invalid normalized lifecycle state.');
  if (lifecycleStatus !== lifecycleFor(terminalStatus, attentionKind))
    throw new Error('Terminal and normalized lifecycle states disagree.');
  const activeRuntimeSeconds =
    options.activeRuntimeSeconds !== undefined
      ? Number(options.activeRuntimeSeconds)
      : undefined;
  if (
    activeRuntimeSeconds !== undefined &&
    (!Number.isFinite(activeRuntimeSeconds) || activeRuntimeSeconds < 0)
  )
    throw new Error('Invalid active runtime.');
  const runtimeSequence =
    options.runtimeSequence !== undefined
      ? Number(options.runtimeSequence)
      : undefined;
  if (
    runtimeSequence !== undefined &&
    (!Number.isSafeInteger(runtimeSequence) || runtimeSequence < 0)
  )
    throw new Error('Invalid runtime sequence.');

  const daemonId = options.daemonId ?? options.daemon?.instanceId;
  const daemonPidRaw = options.daemonPid ?? options.daemon?.pid;
  const daemonBootId = options.daemonBootId ?? options.daemon?.bootId;

  const daemonFields = [daemonId, daemonPidRaw, daemonBootId];
  if (daemonFields.some(Boolean) && !daemonFields.every(Boolean))
    throw new Error('Daemon identity is incomplete.');
  const daemonPid =
    daemonPidRaw !== undefined
      ? typeof daemonPidRaw === 'number'
        ? daemonPidRaw
        : Number.parseInt(String(daemonPidRaw), 10)
      : undefined;
  if (
    daemonPid !== undefined &&
    (!Number.isInteger(daemonPid) || daemonPid <= 0)
  )
    throw new Error('Invalid daemon identity.');
  const controller = daemonId
    ? {
        kind: 'daemon' as const,
        instanceId: daemonId,
        pid: daemonPid!,
        bootId: daemonBootId!,
      }
    : undefined;
  if (['completed', 'failed', 'cancelled'].includes(terminalStatus)) {
    const rawExitCode = options.exitCode;
    const exitCode =
      rawExitCode === undefined || rawExitCode === null
        ? null
        : typeof rawExitCode === 'number'
          ? rawExitCode
          : Number.parseInt(String(rawExitCode), 10);
    if (
      rawExitCode !== undefined &&
      rawExitCode !== null &&
      (!Number.isInteger(exitCode) ||
        (typeof rawExitCode === 'string' && String(exitCode) !== rawExitCode))
    )
      throw new Error('Invalid terminal exit code.');

    const pr = options.providerResult;
    const exitReason = options.exitReason ?? pr?.reason;
    const exitConfidence = options.exitConfidence ?? pr?.confidence;
    const exitSource = options.exitSource ?? pr?.source;
    const providerCode = options.providerCode ?? pr?.providerCode;
    const retryAt = options.retryAt ?? pr?.retryAt;

    const classificationFields = [exitReason, exitConfidence, exitSource];
    if (
      classificationFields.some(Boolean) &&
      !classificationFields.every(Boolean)
    )
      throw new Error('Exit classification is incomplete.');
    let classification: ExitClassification | undefined;
    if (classificationFields.every(Boolean)) {
      if (
        !AGENT_EXIT_REASONS.includes(
          exitReason as (typeof AGENT_EXIT_REASONS)[number],
        ) ||
        !['low', 'medium', 'high'].includes(exitConfidence!) ||
        !EXIT_CLASSIFICATION_SOURCES.includes(
          exitSource as (typeof EXIT_CLASSIFICATION_SOURCES)[number],
        )
      )
        throw new Error('Invalid exit classification values.');
      classification = {
        reason: exitReason as (typeof AGENT_EXIT_REASONS)[number],
        confidence: exitConfidence as 'low' | 'medium' | 'high',
        source: exitSource as (typeof EXIT_CLASSIFICATION_SOURCES)[number],
        ...(providerCode ? { providerCode } : {}),
        ...(retryAt ? { retryAt } : {}),
      };
    }
    await finalizeTerminalRun({
      projectRoot,
      terminalId,
      status: terminalStatus as 'completed' | 'failed' | 'cancelled',
      exitCode,
      classification,
      activeRuntimeSeconds,
      runtimeSequence,
    });
    return;
  }
  let updated = false;
  const now = new Date().toISOString();
  await updateState(projectRoot, (current) => {
    if (
      !current.runs.some((lease) => lease.terminalId === terminalId) &&
      !current.agentHistory.some((run) => run.terminalId === terminalId)
    )
      throw new Error('The terminal-owned run is not ready yet.');
    const runs = current.runs.map((lease) => {
      if (lease.terminalId !== terminalId) return lease;
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
      if (run.terminalId !== terminalId) return run;
      updated = true;
      const sequence = runtimeSequence ?? (run.runtimeSequence ?? 0) + 1;
      if (sequence < (run.runtimeSequence ?? 0)) return run;
      if (run.endedAt && activeLifecycleStates.has(lifecycleStatus)) return run;
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
  if (!updated) throw new Error('The terminal-owned run is not ready yet.');
}

export async function executeBridgeRegistration(
  projectRoot: string,
  terminalId: string,
  options: {
    instanceId?: string;
    pid?: string | number;
    protocolVersion?: string | number;
  },
): Promise<void> {
  if (!options.instanceId || !options.pid || !options.protocolVersion)
    throw new Error('Bridge identity is incomplete.');
  const instanceId = options.instanceId;
  const pid =
    typeof options.pid === 'number'
      ? options.pid
      : Number.parseInt(String(options.pid), 10);
  const protocolVersion =
    typeof options.protocolVersion === 'number'
      ? options.protocolVersion
      : Number.parseInt(String(options.protocolVersion), 10);
  if (!Number.isInteger(pid) || pid <= 0 || protocolVersion !== 1)
    throw new Error('Invalid bridge identity.');
  const state = await readState(projectRoot);
  if (!state.runs.some((lease) => lease.terminalId === terminalId))
    throw new Error('The terminal-owned run is not ready yet.');
  let registered = false;
  await updateState(projectRoot, (current) => {
    if (!current.runs.some((lease) => lease.terminalId === terminalId))
      throw new Error('The terminal-owned run is not ready yet.');
    return {
      ...current,
      runs: current.runs.map((lease) =>
        lease.terminalId === terminalId
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
    };
  });
  if (!registered) throw new Error('The terminal-owned run is not ready yet.');
}

interface BridgeWorkerRequest {
  v?: number;
  id?: string;
  type?: string;
  project?: string;
  terminalId: string;
  observation?: Record<string, unknown>;
  [key: string]: unknown;
}

export async function runBridgeWorker(): Promise<void> {
  const handleLine = async (line: string): Promise<void> => {
    if (!line.trim()) return;
    let req: BridgeWorkerRequest | undefined;
    try {
      req = JSON.parse(line) as BridgeWorkerRequest;
      if (
        !req ||
        req.v !== BRIDGE_WORKER_PROTOCOL_VERSION ||
        typeof req.id !== 'string' ||
        req.id.length < 1 ||
        req.id.length > 64 ||
        !['register', 'update'].includes(req.type ?? '') ||
        typeof req.project !== 'string' ||
        req.project.length < 1 ||
        req.project.length > 4096 ||
        typeof req.terminalId !== 'string' ||
        req.terminalId.length < 1 ||
        req.terminalId.length > 160
      )
        throw new Error('Invalid bridge worker request.');
      const projectRoot = await discoverRepository(req.project);
      if (!projectRoot)
        throw new Error('Relay must be run inside a Git repository.');
      if (req.type === 'register') {
        await executeBridgeRegistration(
          projectRoot,
          req.terminalId,
          req as unknown as Parameters<typeof executeBridgeRegistration>[2],
        );
      } else if (req.type === 'update') {
        if (
          !req.observation ||
          typeof req.observation !== 'object' ||
          Array.isArray(req.observation)
        )
          throw new Error('Invalid bridge worker observation.');
        await executeBridgeObservation(
          projectRoot,
          req.terminalId,
          (req.observation ?? req) as unknown as Parameters<
            typeof executeBridgeObservation
          >[2],
        );
      }
      process.stdout.write(
        JSON.stringify({
          v: BRIDGE_WORKER_PROTOCOL_VERSION,
          id: req.id,
          ok: true,
        }) + '\n',
      );
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      process.stdout.write(
        JSON.stringify({
          v: BRIDGE_WORKER_PROTOCOL_VERSION,
          id: req?.id,
          ok: false,
          error: errorMessage,
        }) + '\n',
      );
    }
  };

  let parts: Buffer[] = [];
  let frameBytes = 0;
  for await (const value of process.stdin) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(0x0a, offset);
      const end = newline === -1 ? chunk.length : newline;
      const length = end - offset;
      if (frameBytes + length > BRIDGE_WORKER_MAX_FRAME_BYTES) {
        process.stdin.destroy();
        throw new Error('Bridge worker request exceeds the size limit.');
      }
      if (length > 0) {
        parts.push(Buffer.from(chunk.subarray(offset, end)));
        frameBytes += length;
      }
      if (newline === -1) break;
      const line = Buffer.concat(parts, frameBytes).toString('utf8');
      parts = [];
      frameBytes = 0;
      await handleLine(line);
      offset = newline + 1;
    }
  }
  if (frameBytes > 0)
    await handleLine(Buffer.concat(parts, frameBytes).toString('utf8'));
}

export function bridgeCommand(): Command {
  return new Command('bridge')
    .description('Register bridge identity for an active terminal-owned run')
    .option('--terminal-id <id>')
    .option(
      '--worker',
      'run persistent bridge worker reading newline-delimited JSON from stdin',
    )
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
    .option('--exit-code <code>')
    .option('--exit-reason <reason>')
    .option('--exit-confidence <confidence>')
    .option('--exit-source <source>')
    .option('--provider-code <code>')
    .option('--retry-at <timestamp>')
    .action(
      async (options: {
        terminalId?: string;
        worker?: boolean;
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
        exitCode?: string;
        exitReason?: string;
        exitConfidence?: string;
        exitSource?: string;
        providerCode?: string;
        retryAt?: string;
      }) => {
        if (options.worker) {
          await runBridgeWorker();
          return;
        }

        if (!options.terminalId) {
          throw new Error('Terminal ID is required.');
        }

        const projectRoot = await discoverRepository(process.cwd());
        if (!projectRoot)
          throw new Error('Relay must be run inside a Git repository.');

        if (options.status) {
          await executeBridgeObservation(
            projectRoot,
            options.terminalId,
            options,
          );
          return;
        }

        await executeBridgeRegistration(
          projectRoot,
          options.terminalId,
          options,
        );
      },
    );
}
