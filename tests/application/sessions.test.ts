import { mkdir } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentAdapter, ProcessResult } from '../../src/agents/adapter.js';
import {
  markControllerOrphaned,
  recoverOrphanedRun,
  RunAlreadyStartedError,
  SessionManager,
} from '../../src/application/sessions.js';
import type {
  ProcessEvent,
  ProcessHandle,
  ProcessHost,
  ProcessListener,
  ProcessStartRequest,
  Unsubscribe,
} from '../../src/process/process-host.js';
import { relayPath } from '../../src/safety/path-policy.js';
import type { RelayState } from '../../src/state/schema.js';
import { readState, writeState } from '../../src/state/store.js';
import { createRepository, removeRepository } from '../helpers.js';

const roots: string[] = [];
const NOW = '2026-01-01T00:00:00.000Z';

const adapter: AgentAdapter = {
  id: 'codex',
  displayName: 'Codex',
  executable: 'codex',
  async detectInstallation() {
    return { status: 'ready' };
  },
  async detectAuthentication() {
    return { status: 'unknown' };
  },
  async getVersion() {
    return 'test';
  },
  async getModels() {
    return [];
  },
  async getEffortLevels() {
    return [];
  },
  async buildInteractiveCommand() {
    return { executable: 'codex', args: ['test prompt'] };
  },
  async classifyExit(result) {
    return {
      reason: result.exitCode === 0 ? 'completed' : 'unknown_failure',
      confidence: result.exitCode === 0 ? 'high' : 'low',
    };
  },
};

interface FakeProcess {
  listeners: Set<ProcessListener>;
}

class FakeProcessHost implements ProcessHost {
  readonly starts: ProcessStartRequest[] = [];
  readonly writes: Array<{ handleId: string; data: Uint8Array }> = [];
  readonly resizes: Array<{
    handleId: string;
    columns: number;
    rows: number;
  }> = [];
  readonly interrupts: string[] = [];
  readonly stops: string[] = [];
  failStart = false;
  private nextId = 1;
  private readonly processes = new Map<string, FakeProcess>();

  async start(request: ProcessStartRequest): Promise<ProcessHandle> {
    if (this.failStart) throw new Error('fake start failure');
    const id = `handle-${this.nextId++}`;
    this.starts.push(request);
    this.processes.set(id, { listeners: new Set() });
    return { id };
  }

  async write(handleId: string, data: Uint8Array): Promise<void> {
    this.writes.push({ handleId, data });
  }

  async resize(handleId: string, columns: number, rows: number): Promise<void> {
    this.resizes.push({ handleId, columns, rows });
  }

  async interrupt(handleId: string): Promise<void> {
    this.interrupts.push(handleId);
  }

  async stop(handleId: string): Promise<void> {
    this.stops.push(handleId);
  }

  subscribe(handleId: string, listener: ProcessListener): Unsubscribe {
    const process = this.processes.get(handleId);
    if (!process) throw new Error(`Unknown fake handle ${handleId}.`);
    process.listeners.add(listener);
    return () => process.listeners.delete(listener);
  }

  publish(handleId: string, event: ProcessEvent): void {
    const process = this.processes.get(handleId);
    if (!process) throw new Error(`Unknown fake handle ${handleId}.`);
    for (const listener of [...process.listeners]) listener(event);
  }

  exit(handleId: string, result: ProcessResult): void {
    this.publish(handleId, { type: 'exit', result });
  }
}

function initialState(root: string): RelayState {
  return {
    schemaVersion: 3,
    revision: 0,
    recentOperations: [],
    runs: [],
    sessionId: 'session-1',
    projectRoot: root,
    task: {
      title: 'Session manager',
      originalRequest: 'Session manager',
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
  };
}

async function project(): Promise<{ root: string; state: RelayState }> {
  const root = await createRepository();
  roots.push(root);
  await mkdir(relayPath(root), { recursive: true });
  const state = initialState(root);
  await writeState(root, state);
  return { root, state };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeRepository));
});

const success: ProcessResult = {
  exitCode: 0,
  signal: null,
  stdout: '',
  stderr: '',
};

describe('SessionManager', () => {
  it('acquires a lease and finalizes a provider exit exactly once', async () => {
    const { root, state } = await project();
    const host = new FakeProcessHost();
    const manager = new SessionManager(host);
    const run = await manager.startRun({
      projectRoot: root,
      state,
      adapter,
      prompt: 'Test',
      selection: { operationId: 'run-once', terminalId: 'terminal-1' },
    });

    expect((await readState(root)).runs[0]).toMatchObject({
      runId: run.runId,
      terminalId: 'terminal-1',
      branchLabel: 'main',
      role: 'implement',
    });
    host.exit(run.handleId!, success);
    host.exit(run.handleId!, success);
    const completed = await run.completion;

    expect(completed.result.exitCode).toBe(0);
    const persisted = await readState(root);
    expect(persisted.runs).toEqual([]);
    expect(persisted.agentHistory).toHaveLength(1);
    expect(persisted.agentHistory[0]).toMatchObject({
      id: run.runId,
      terminalId: 'terminal-1',
      branchLabel: 'main',
      role: 'implement',
      exitReason: 'completed',
      exitCode: 0,
    });
  });

  it('allows concurrent providers only in different worktrees', async () => {
    const { root, state } = await project();
    const host = new FakeProcessHost();
    const manager = new SessionManager(host);
    const [first, second] = await Promise.all([
      manager.startRun({
        projectRoot: root,
        state,
        adapter,
        prompt: 'First',
        selection: {
          operationId: 'first',
          workspace: { id: 'ws-1', worktreePath: '/worktrees/ws-1' },
        },
      }),
      manager.startRun({
        projectRoot: root,
        state,
        adapter,
        prompt: 'Second',
        selection: {
          operationId: 'second',
          workspace: { id: 'ws-2', worktreePath: '/worktrees/ws-2' },
        },
      }),
    ]);
    expect((await readState(root)).runs).toHaveLength(2);

    await expect(
      manager.startRun({
        projectRoot: root,
        state: await readState(root),
        adapter,
        prompt: 'Conflict',
        selection: {
          operationId: 'conflict',
          workspace: { id: 'ws-1', worktreePath: '/worktrees/ws-1' },
        },
      }),
    ).rejects.toThrow(/already running in this working tree/);

    host.exit(first.handleId!, success);
    host.exit(second.handleId!, success);
    await Promise.all([first.completion, second.completion]);
  });

  it('uses caller operation IDs to prevent duplicate process starts', async () => {
    const { root, state } = await project();
    const host = new FakeProcessHost();
    const manager = new SessionManager(host);
    const request = {
      projectRoot: root,
      state,
      adapter,
      prompt: 'Once',
      selection: { operationId: 'stable-operation' },
    };
    const first = await manager.startRun(request);

    await expect(
      manager.startRun({ ...request, state: await readState(root) }),
    ).rejects.toBeInstanceOf(RunAlreadyStartedError);
    expect(host.starts).toHaveLength(1);

    host.exit(first.handleId!, success);
    await first.completion;
    const retry = await manager.startRun({
      ...request,
      state: await readState(root),
    });
    expect(retry.handleId).toBeNull();
    await expect(retry.completion).resolves.toMatchObject({
      runId: first.runId,
      result: { exitCode: 0 },
    });
    expect(host.starts).toHaveLength(1);
  });

  it('releases the lease when the process host cannot start', async () => {
    const { root, state } = await project();
    const host = new FakeProcessHost();
    host.failStart = true;
    const manager = new SessionManager(host);

    await expect(
      manager.startRun({
        projectRoot: root,
        state,
        adapter,
        prompt: 'Fail',
        selection: { operationId: 'start-failure' },
      }),
    ).rejects.toThrow('fake start failure');
    const persisted = await readState(root);
    expect(persisted.runs).toEqual([]);
    expect(persisted.agentHistory[0]).toMatchObject({
      exitCode: 127,
      exitReason: 'unknown_failure',
    });
  });

  it('routes process controls through the host by run ID', async () => {
    const { root, state } = await project();
    const host = new FakeProcessHost();
    const manager = new SessionManager(host);
    const run = await manager.startRun({
      projectRoot: root,
      state,
      adapter,
      prompt: 'Control',
      selection: { operationId: 'controls' },
    });

    await manager.write(run.runId, new Uint8Array([65]));
    await manager.resize(run.runId, 100, 40);
    await manager.interrupt(run.runId);
    await manager.stop(run.runId);
    expect(host.writes[0]?.handleId).toBe(run.handleId);
    expect(host.resizes[0]).toMatchObject({ columns: 100, rows: 40 });
    expect(host.interrupts).toEqual([run.handleId]);
    expect(host.stops).toEqual([run.handleId]);

    host.exit(run.handleId!, success);
    await run.completion;
  });

  it('keeps crashed-controller worktrees claimed until recorded recovery', async () => {
    const { root, state } = await project();
    const host = new FakeProcessHost();
    const manager = new SessionManager(host);
    const run = await manager.startRun({
      projectRoot: root,
      state,
      adapter,
      prompt: 'Orphan',
      controllerId: 'desktop:test-controller',
      selection: {
        operationId: 'orphan',
        workspace: { id: 'ws-orphan', worktreePath: '/worktrees/orphan' },
      },
    });

    await expect(
      recoverOrphanedRun({
        projectRoot: root,
        runId: run.runId,
        requestedBy: 'test-user',
        reason: 'unsafe while controlled',
      }),
    ).rejects.toThrow(/not orphaned/);

    const orphaned = await markControllerOrphaned(
      root,
      'desktop:test-controller',
    );
    expect(orphaned.runs[0]).toMatchObject({
      runId: run.runId,
      status: 'orphaned',
    });
    await expect(
      manager.startRun({
        projectRoot: root,
        state: orphaned,
        adapter,
        prompt: 'Unsafe duplicate',
        selection: {
          operationId: 'orphan-conflict',
          workspace: { id: 'ws-orphan', worktreePath: '/worktrees/orphan' },
        },
      }),
    ).rejects.toThrow(/already running in this working tree/);

    const recovered = await recoverOrphanedRun({
      projectRoot: root,
      runId: run.runId,
      requestedBy: 'test-user',
      reason: 'confirmed fake host stopped',
    });
    expect(recovered.runs).toEqual([]);
    expect(recovered.agentHistory[0]).toMatchObject({
      id: run.runId,
      exitReason: 'interrupted',
      endedAt: expect.any(String),
    });

    host.exit(run.handleId!, success);
    await run.completion;
    expect((await readState(root)).agentHistory[0]).toMatchObject({
      id: run.runId,
      exitReason: 'interrupted',
      exitCode: null,
    });
  });
});
