import { createHash, randomUUID } from 'node:crypto';
import type {
  AgentAdapter,
  ExitClassification,
  ProcessResult,
  ProviderObservation,
  ResumeTargetKind,
} from '../agents/adapter.js';
import { interruptedExitClassification } from '../agents/adapter.js';
import { buildControllerIdentity, controllerIdFor } from './controller.js';
import { prepareProviderUsage } from '../plan-usage.js';
import type { ProcessHost } from '../process/process-host.js';
import { appendEvent } from '../state/events.js';
import { appendTerminalJournal } from '../state/journal.js';
import {
  acquireLease,
  markLeaseOrphaned,
  releaseLease,
} from '../state/leases.js';
import type {
  ControllerIdentity,
  OrphanBid,
  RelayState,
  RunLease,
} from '../state/schema.js';
import { ORPHAN_BID_LIMIT } from '../state/schema.js';
import { updateState } from '../state/store.js';
import type { WorkspaceRole } from '../worktrees/schema.js';

export interface RunSelection {
  model?: string;
  effort?: string;
  launchMode?: 'new' | 'resume' | 'fork';
  resumeTargetKind?: ResumeTargetKind;
  resumeTargetValue?: string;
  workspace?: {
    id: string;
    worktreePath: string;
    branchLabel?: string;
    role?: WorkspaceRole;
  };
  terminalId?: string;
  operationId?: string;
}

export interface StartRunRequest {
  projectRoot: string;
  state: RelayState;
  adapter: AgentAdapter;
  prompt: string;
  selection?: RunSelection;
  /** Structured identity of the process that will own the provider process. */
  controller?: ControllerIdentity;
  /** Bounded provider signals observed during the run, fed to exit classification. */
  observations?: ProviderObservation[];
}

export interface CompletedRun {
  runId: string;
  result: ProcessResult;
  state: RelayState;
}

export interface ManagedRun {
  runId: string;
  operationId: string;
  lease: RunLease | null;
  handleId: string | null;
  completion: Promise<CompletedRun>;
}

export class RunAlreadyStartedError extends Error {
  constructor(runId: string, operationId: string) {
    super(
      `Run operation ${operationId} already started as ${runId}; refusing to launch a duplicate provider process.`,
    );
    this.name = 'RunAlreadyStartedError';
  }
}

interface ActiveSession {
  handleId: string;
  completion: Promise<CompletedRun>;
}

function validateOperationId(value: string): string {
  if (
    value.length < 1 ||
    value.length > 200 ||
    value.includes('\0') ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(value)
  )
    throw new Error(
      'Run operation IDs must use 1-200 letters, numbers, dots, underscores, colons, or dashes.',
    );
  return value;
}

function runIdFor(sessionId: string, operationId: string): string {
  const hex = createHash('sha256')
    .update(`${sessionId}\0${operationId}`)
    .digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function resultObservations(
  observations: ProviderObservation[] | undefined,
): ProviderObservation[] {
  return (observations ?? []).slice(0, 16).map((observation) => ({
    kind: observation.kind,
    ...(observation.detail ? { detail: observation.detail } : {}),
  }));
}

function resultFromHistory(
  run: RelayState['agentHistory'][number],
): ProcessResult {
  return {
    exitCode: run.exitCode ?? null,
    signal: null,
    terminationIntent: 'none',
    observations: [],
    stdout: '',
    stderr: '',
  };
}

/** Owns provider processes and durable run leases independently of any frontend. */
export class SessionManager {
  private readonly active = new Map<string, ActiveSession>();

  constructor(private readonly host: ProcessHost) {}

  async startRun(request: StartRunRequest): Promise<ManagedRun> {
    const selection = request.selection ?? {};
    const operationId = validateOperationId(
      selection.operationId ?? randomUUID(),
    );
    const runId = runIdFor(request.state.sessionId, operationId);
    const prepared = await this.prepareRun(request, runId, operationId);
    if (prepared.completed) {
      return {
        runId,
        operationId,
        lease: null,
        handleId: null,
        completion: Promise.resolve(prepared.completed),
      };
    }
    if (!prepared.inserted)
      throw new RunAlreadyStartedError(runId, operationId);

    await appendEvent(request.projectRoot, 'agent_started', prepared.event);
    if (selection.terminalId)
      await appendTerminalJournal(request.projectRoot, {
        at: new Date().toISOString(),
        terminalId: selection.terminalId,
        event: 'attached',
        detail: `agent ${request.adapter.id} started`,
      });

    let handleId: string;
    try {
      handleId = (
        await this.host.start({
          command: prepared.command,
          cwd: prepared.lease.worktreePath,
        })
      ).id;
    } catch (error) {
      const result: ProcessResult = {
        exitCode: null,
        signal: null,
        spawnErrorCode:
          typeof (error as NodeJS.ErrnoException).code === 'string'
            ? (error as NodeJS.ErrnoException).code
            : undefined,
        terminationIntent: 'none',
        observations: [],
        stdout: '',
        stderr: '',
      };
      await this.finalize(request, prepared.run, runId, operationId, result);
      throw error;
    }

    let settle: (value: CompletedRun) => void = () => undefined;
    let reject: (reason: unknown) => void = () => undefined;
    const completion = new Promise<CompletedRun>((resolve, rejectPromise) => {
      settle = resolve;
      reject = rejectPromise;
    });
    let finalized = false;
    let unsubscribe: () => void = () => undefined;
    unsubscribe = this.host.subscribe(handleId, (event) => {
      if (event.type !== 'exit' || finalized) return;
      finalized = true;
      unsubscribe();
      void this.finalize(
        request,
        prepared.run,
        runId,
        operationId,
        event.result,
      ).then(settle, reject);
    });
    this.active.set(runId, { handleId, completion });
    void completion.then(
      () => this.active.delete(runId),
      () => this.active.delete(runId),
    );
    return {
      runId,
      operationId,
      lease: prepared.lease,
      handleId,
      completion,
    };
  }

  async write(runId: string, data: Uint8Array): Promise<void> {
    await this.host.write(this.requireActive(runId).handleId, data);
  }

  async resize(runId: string, columns: number, rows: number): Promise<void> {
    await this.host.resize(this.requireActive(runId).handleId, columns, rows);
  }

  async interrupt(runId: string): Promise<void> {
    await this.host.interrupt(this.requireActive(runId).handleId);
  }

  async stop(runId: string): Promise<void> {
    await this.host.stop(this.requireActive(runId).handleId);
  }

  private requireActive(runId: string): ActiveSession {
    const active = this.active.get(runId);
    if (!active)
      throw new Error(`Run ${runId} is not owned by this session manager.`);
    return active;
  }

  private async prepareRun(
    request: StartRunRequest,
    runId: string,
    operationId: string,
  ) {
    const selection = request.selection ?? {};
    const installation = await request.adapter.detectInstallation();
    if (installation.status !== 'ready')
      throw new Error(
        `${request.adapter.displayName} CLI is not installed or executable on PATH.`,
      );
    const launchMode = selection.launchMode ?? 'new';
    if (launchMode !== 'new' && !selection.resumeTargetKind)
      throw new Error('Resume launches require a target.');
    if (
      launchMode !== 'new' &&
      (!request.adapter.resumeCapabilities ||
        !request.adapter.buildResumeCommand)
    )
      throw new Error(
        `${request.adapter.displayName} does not support session resume.`,
      );
    if (
      launchMode !== 'new' &&
      selection.resumeTargetKind &&
      !request.adapter.resumeCapabilities!.targets.includes(
        selection.resumeTargetKind,
      )
    )
      throw new Error(
        `${request.adapter.displayName} does not support ${selection.resumeTargetKind} session resume.`,
      );
    if (selection.resumeTargetKind === 'id' && !selection.resumeTargetValue)
      throw new Error('Exact resume requires a provider session ID.');

    const workingDirectory =
      selection.workspace?.worktreePath ?? request.projectRoot;
    const parentRun =
      launchMode !== 'new' && selection.resumeTargetKind === 'id'
        ? request.state.agentHistory.findLast(
            (run) =>
              run.agent === request.adapter.id &&
              run.providerSessionId === selection.resumeTargetValue,
          )
        : undefined;
    const providerSessionId =
      launchMode === 'new' &&
      request.adapter.resumeCapabilities?.exposesNewSessionId
        ? randomUUID()
        : launchMode === 'resume' && selection.resumeTargetKind === 'id'
          ? selection.resumeTargetValue
          : launchMode === 'resume'
            ? parentRun?.providerSessionId
            : undefined;
    const providerSettingsPath = await prepareProviderUsage(
      request.projectRoot,
      request.adapter.id,
    );
    const commandContext = {
      projectRoot: request.projectRoot,
      prompt: request.prompt,
      providerSettingsPath,
      providerSessionId,
      model: selection.model,
      effort: selection.effort,
    };
    const command =
      launchMode === 'new'
        ? await request.adapter.buildInteractiveCommand(commandContext)
        : await request.adapter.buildResumeCommand!({
            ...commandContext,
            resumeTargetKind: selection.resumeTargetKind!,
            resumeTargetValue: selection.resumeTargetValue,
            fork: launchMode === 'fork',
          });
    const startedAt = new Date().toISOString();
    const run = {
      id: runId,
      agent: request.adapter.id,
      model: selection.model,
      effort: selection.effort,
      startedAt,
      launchMode,
      providerSessionId,
      resumeTargetKind: selection.resumeTargetKind,
      resumeTargetValue: selection.resumeTargetValue,
      parentRunId: parentRun?.id,
      terminalId: selection.terminalId,
      workspaceId: selection.workspace?.id,
      branchLabel:
        selection.workspace?.branchLabel ??
        request.state.git.currentBranch ??
        request.state.git.startingBranch,
      role: selection.workspace?.role ?? ('implement' as const),
      lifecycleStatus: 'working' as const,
      activeRuntimeSeconds: 0,
      runtimeSequence: 0,
      providerObservations:
        resultObservations(request.observations).length > 0
          ? resultObservations(request.observations)
          : undefined,
    };
    const controller = buildControllerIdentity({
      terminalId: selection.terminalId,
      identity: request.controller,
    });
    const lease: RunLease = {
      runId,
      terminalId: selection.terminalId,
      workspaceId: selection.workspace?.id,
      branchLabel:
        selection.workspace?.branchLabel ??
        request.state.git.currentBranch ??
        request.state.git.startingBranch,
      role: selection.workspace?.role ?? 'implement',
      worktreePath: workingDirectory,
      projectRoot: request.projectRoot,
      agent: request.adapter.id,
      model: selection.model,
      effort: selection.effort,
      launchMode,
      providerSessionId,
      controller,
      controllerId: controllerIdFor(controller),
      lifecycleStatus: 'working',
      activeRuntimeSeconds: 0,
      runtimeSequence: 0,
      startedAt,
      lastSeenAt: startedAt,
      status: 'running',
    };
    let inserted = false;
    const persisted = await updateState(
      request.projectRoot,
      (current) => {
        if (current.sessionId !== request.state.sessionId)
          throw new Error(
            'The Relay task changed while the provider launch was being prepared. Run the command again.',
          );
        if (
          current.task.status !== 'active' &&
          current.task.status !== 'blocked'
        )
          throw new Error(`Relay task is ${current.task.status}.`);
        if (current.agentHistory.some((item) => item.id === runId))
          return current;
        inserted = true;
        return acquireLease(
          { ...current, agentHistory: [...current.agentHistory, run] },
          lease,
        );
      },
      {
        opId: `launch:${operationId}`,
      },
    );
    if (!inserted) {
      const existing = persisted.agentHistory.find((item) => item.id === runId);
      if (existing?.endedAt)
        return {
          inserted: false,
          completed: {
            runId,
            result: resultFromHistory(existing),
            state: persisted,
          } satisfies CompletedRun,
        };
    }
    return {
      inserted,
      completed: undefined,
      command,
      event: {
        operationId,
        runId,
        agent: request.adapter.id,
        model: selection.model ?? null,
        effort: selection.effort ?? null,
        launchMode,
        providerSessionId: providerSessionId ?? null,
        resumeTargetKind: selection.resumeTargetKind ?? null,
        resumeTargetValue: selection.resumeTargetValue ?? null,
        parentRunId: parentRun?.id ?? null,
      },
      lease,
      run,
    };
  }

  private async finalize(
    request: StartRunRequest,
    run: RelayState['agentHistory'][number],
    runId: string,
    operationId: string,
    result: ProcessResult,
  ): Promise<CompletedRun> {
    let classification: ExitClassification = {
      reason: 'unknown_failure',
      confidence: 'low',
      source: 'fallback',
    };
    try {
      classification = await request.adapter.classifyExit({
        ...result,
        observations: resultObservations([
          ...result.observations,
          ...(request.observations ?? []),
        ]),
      });
    } catch {
      // Lease finalization must not depend on optional provider classification.
    }
    const completedRun = {
      ...run,
      endedAt: new Date().toISOString(),
      exitCode: result.exitCode,
      exitReason: classification.reason,
      exitClassification: classification,
      lifecycleStatus:
        classification.reason === 'completed'
          ? ('completed' as const)
          : ['user_cancelled', 'interrupted'].includes(classification.reason)
            ? ('cancelled' as const)
            : ('failed' as const),
      attentionKind: undefined,
    };
    let merged = false;
    let state: RelayState;
    try {
      state = await this.retryStateMutation(() => {
        merged = false;
        return updateState(
          request.projectRoot,
          (current) => {
            if (current.sessionId !== request.state.sessionId) return current;
            const existing = current.agentHistory.find(
              (item) => item.id === runId,
            );
            if (existing?.endedAt) return releaseLease(current, runId);
            merged = true;
            const agentHistory = existing
              ? current.agentHistory.map((item) =>
                  item.id === runId
                    ? {
                        ...item,
                        ...completedRun,
                        activeRuntimeSeconds: Math.max(
                          item.activeRuntimeSeconds ?? 0,
                          completedRun.activeRuntimeSeconds ?? 0,
                        ),
                        runtimeSequence: Math.max(
                          item.runtimeSequence ?? 0,
                          completedRun.runtimeSequence ?? 0,
                        ),
                      }
                    : item,
                )
              : [...current.agentHistory, completedRun];
            return releaseLease({ ...current, agentHistory }, runId);
          },
          { opId: `finalize:${operationId}` },
        );
      });
    } catch (error) {
      // If final result publication remains unavailable, preserve an explicit
      // uncertain claim rather than silently leaving a lease marked running.
      await this.retryStateMutation(() =>
        updateState(
          request.projectRoot,
          (current) => markLeaseOrphaned(current, runId),
          { opId: `orphan-finalize:${operationId}` },
        ),
      ).catch(() => undefined);
      throw error;
    }
    await appendEvent(request.projectRoot, 'agent_ended', {
      operationId,
      runId,
      sessionId: request.state.sessionId,
      agent: request.adapter.id,
      exitCode: result.exitCode,
      reason: classification.reason,
      stateMerge:
        state.sessionId !== request.state.sessionId
          ? 'skipped_newer_task'
          : merged
            ? 'merged'
            : 'skipped_already_finalized',
    }).catch(() => undefined);
    if (run.terminalId)
      await appendTerminalJournal(request.projectRoot, {
        at: new Date().toISOString(),
        terminalId: run.terminalId,
        event: 'exit',
        detail: `agent ${request.adapter.id} ${classification.reason}`,
      }).catch(() => undefined);
    return { runId, result, state };
  }

  private async retryStateMutation<T>(operation: () => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        if (attempt < 2)
          await new Promise((resolve) =>
            setTimeout(resolve, 50 * (attempt + 1)),
          );
      }
    }
    throw lastError;
  }
}

export async function markControllerOrphaned(
  projectRoot: string,
  controllerId: string,
): Promise<RelayState> {
  const orphanedRunIds: string[] = [];
  const state = await updateState(projectRoot, (current) => {
    let next = current;
    for (const lease of current.runs) {
      if (lease.controllerId !== controllerId || lease.status === 'orphaned')
        continue;
      orphanedRunIds.push(lease.runId);
      next = markLeaseOrphaned(next, lease.runId);
    }
    return next;
  });
  for (const runId of orphanedRunIds) {
    await appendEvent(projectRoot, 'agent_orphaned', {
      runId,
      controllerId,
      reason: 'controller_disconnected',
    });
    const terminalId = state.runs.find(
      (lease) => lease.runId === runId,
    )?.terminalId;
    if (terminalId)
      await appendTerminalJournal(projectRoot, {
        at: new Date().toISOString(),
        terminalId,
        event: 'closed',
        detail: 'controller disconnected',
      }).catch(() => undefined);
  }
  return state;
}

export async function recoverOrphanedRun(request: {
  projectRoot: string;
  runId: string;
  requestedBy: string;
  reason: string;
}): Promise<RelayState> {
  if (!request.requestedBy.trim() || !request.reason.trim())
    throw new Error('Orphan recovery requires a requester and reason.');
  const endedAt = new Date().toISOString();
  const state = await updateState(request.projectRoot, (current) => {
    const lease = current.runs.find((item) => item.runId === request.runId);
    if (!lease) throw new Error(`No run lease ${request.runId} exists.`);
    if (lease.status !== 'orphaned')
      throw new Error(
        `Run ${request.runId} is ${lease.status}, not orphaned; stop its controller instead.`,
      );
    const agentHistory = current.agentHistory.map((run) =>
      run.id === request.runId && !run.endedAt
        ? {
            ...run,
            endedAt,
            exitCode: null,
            exitReason: 'interrupted' as const,
            exitClassification: interruptedExitClassification(),
          }
        : run,
    );
    return releaseLease(
      {
        ...current,
        agentHistory,
        task: { ...current.task, updatedAt: endedAt },
      },
      request.runId,
    );
  });
  await appendEvent(request.projectRoot, 'agent_recovered', {
    runId: request.runId,
    requestedBy: request.requestedBy,
    reason: request.reason,
  });
  const terminalId = state.agentHistory.find(
    (run) => run.id === request.runId,
  )?.terminalId;
  if (terminalId)
    await appendTerminalJournal(request.projectRoot, {
      at: endedAt,
      terminalId,
      event: 'recovered',
      detail: request.reason,
    }).catch(() => undefined);
  return state;
}

export interface OrphanBidRequest {
  projectRoot: string;
  runId: string;
  /** Canonical controllerId string, e.g. `cli:<uuid>`. */
  controllerId: string;
  priority: number;
}

export interface OrphanBidResult {
  won: boolean;
  winnerControllerId: string;
  bids: OrphanBid[];
  state: RelayState;
}

function compareBids(left: OrphanBid, right: OrphanBid): number {
  if (left.priority !== right.priority) return right.priority - left.priority;
  if (left.at !== right.at) return left.at.localeCompare(right.at);
  return left.controllerId.localeCompare(right.controllerId);
}

/**
 * Deterministic takeover protocol for orphaned runs. A controller that wants
 * to claim an orphaned run records a bid; the winner is the highest priority,
 * then the earliest bid, then the smallest controller id, so any number of
 * contenders converge on the same owner without a coordinator.
 */
export async function submitOrphanBid(
  request: OrphanBidRequest,
): Promise<OrphanBidResult> {
  const bid: OrphanBid = {
    controllerId: request.controllerId,
    priority: request.priority,
    at: new Date().toISOString(),
  };
  const state = await updateState(request.projectRoot, (current) => {
    const lease = current.runs.find((item) => item.runId === request.runId);
    if (!lease) throw new Error(`No run lease ${request.runId} exists.`);
    if (lease.status !== 'orphaned')
      throw new Error(
        `Run ${request.runId} is ${lease.status}, not orphaned; stop its controller instead.`,
      );
    const bids = [...(lease.bids ?? []), bid].slice(-ORPHAN_BID_LIMIT);
    return {
      ...current,
      runs: current.runs.map((item) =>
        item.runId === request.runId ? { ...item, bids } : item,
      ),
    };
  });
  const lease = state.runs.find((item) => item.runId === request.runId);
  const bids = lease?.bids ?? [];
  const winner = bids.reduce<OrphanBid | undefined>(
    (best, candidate) =>
      best === undefined || compareBids(candidate, best) < 0 ? candidate : best,
    undefined,
  );
  const winnerControllerId = winner?.controllerId ?? request.controllerId;
  return {
    won: winnerControllerId === request.controllerId,
    winnerControllerId,
    bids,
    state,
  };
}
