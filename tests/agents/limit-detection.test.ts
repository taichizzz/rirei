import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  AgentAdapter,
  ProcessResult,
  ProviderUsageSnapshot,
} from '../../src/agents/adapter.js';
import { getAgent } from '../../src/agents/registry.js';
import {
  detectLimitEvidence,
  type LimitEvidence,
} from '../../src/agents/limit-detection.js';
import {
  finalizeTerminalRun,
  fallbackTerminalClassification,
  SessionManager,
} from '../../src/application/sessions.js';
import { createRepository, removeRepository } from '../helpers.js';
import {
  LATEST_STATE_SCHEMA,
  type RelayState,
} from '../../src/state/schema.js';
import { readState, writeState } from '../../src/state/store.js';
import type { ProcessHost } from '../../src/process/process-host.js';
import { PLAN_USAGE_STALE_MS } from '../../src/agents/usage-collectors.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const directories: string[] = [];

afterEach(async () => {
  for (const dir of directories) {
    await removeRepository(dir);
  }
  directories.length = 0;
});

function mockAdapter(
  id: 'claude' | 'codex' = 'claude',
  readUsageFn?: () => Promise<ProviderUsageSnapshot[]>,
): AgentAdapter {
  const base = getAgent(id);
  const adapter = Object.create(base) as AgentAdapter;
  adapter.detectInstallation = async () => ({ status: 'ready' });
  if (readUsageFn) {
    adapter.readUsage = readUsageFn;
  }
  return adapter;
}

class FakeProcessHost implements ProcessHost {
  private listeners: Map<string, ProcessListener[]> = new Map();
  private exits: Map<string, ProcessResult> = new Map();

  constructor(
    private exitCode: number | null = 1,
    private autoExit: boolean = true,
  ) {}

  async start(): Promise<{ id: string }> {
    const handleId = 'handle-1';
    if (this.autoExit) {
      setTimeout(() => {
        const result: ProcessResult = {
          exitCode: this.exitCode,
          signal: null,
          observations: [],
        };
        this.exits.set(handleId, result);
        const list = this.listeners.get(handleId) ?? [];
        for (const listener of list) {
          listener({
            type: 'exit',
            result,
          });
        }
      }, 5);
    }
    return { id: handleId };
  }

  async write(): Promise<void> {}
  async resize(): Promise<void> {}
  async interrupt(): Promise<void> {}
  async stop(): Promise<void> {}
  subscribe(handleId: string, listener: ProcessListener): () => void {
    const list = this.listeners.get(handleId) ?? [];
    list.push(listener);
    this.listeners.set(handleId, list);

    const exited = this.exits.get(handleId);
    if (exited) {
      queueMicrotask(() => {
        listener({ type: 'exit', result: exited });
      });
    }

    return () => {
      const current = this.listeners.get(handleId) ?? [];
      this.listeners.set(
        handleId,
        current.filter((l) => l !== listener),
      );
    };
  }
}

describe('detectLimitEvidence unit tests', () => {
  const startedAt = '2026-09-16T12:00:00.000Z';
  const endedAt = '2026-09-16T12:05:00.000Z';
  const futureReset = '2026-09-16T14:30:00.000Z';

  it('returns null if adapter does not implement readUsage', async () => {
    const adapter = mockAdapter('claude');
    delete (adapter as Partial<AgentAdapter>).readUsage;
    const evidence = await detectLimitEvidence(
      adapter,
      { projectRoot: '/tmp' },
      { startedAt, endedAt, exitCode: 1 },
    );
    expect(evidence).toBeNull();
  });

  it('exhausted + non-zero exit + fresh sample -> usage_limit, medium, retryAt set', async () => {
    const adapter = mockAdapter('claude', async () => [
      {
        adapterId: 'claude',
        status: 'available',
        capturedAt: '2026-09-16T12:04:00.000Z',
        source: 'Claude Code status line',
        metrics: [
          {
            id: 'fiveHour',
            kind: 'quota',
            unit: 'percent',
            used: 100,
            remaining: 0,
            resetsAt: futureReset,
            window: { label: '5-hour', durationSeconds: 5 * 3600 },
            status: 'available',
            statusReason: 'live',
          },
        ],
      },
    ]);

    const evidence = await detectLimitEvidence(
      adapter,
      { projectRoot: '/tmp' },
      { startedAt, endedAt, exitCode: 1 },
    );

    expect(evidence).toEqual({
      observation: {
        kind: 'usage_limit',
        detail: 'quota_exhausted',
        confidence: 'medium',
      },
      retryAt: futureReset,
      confidence: 'medium',
      source: 'usage_sample',
    });
  });

  it('loads and detects from fixture file correctly', async () => {
    const fixturePath = path.resolve(
      __dirname,
      '../fixtures/provider-usage/claude-exhausted.json',
    );
    const fixtureRaw = JSON.parse(await readFile(fixturePath, 'utf8'));

    const adapter = mockAdapter('claude', async () => [
      {
        adapterId: 'claude',
        status: 'available',
        capturedAt: fixtureRaw.capturedAt,
        source: 'Claude Code status line',
        metrics: [
          {
            id: 'fiveHour',
            kind: 'quota',
            unit: 'percent',
            used: fixtureRaw.windows.five_hour.usedPercentage,
            remaining: 100 - fixtureRaw.windows.five_hour.usedPercentage,
            resetsAt: new Date(
              fixtureRaw.windows.five_hour.resetsAt * 1000,
            ).toISOString(),
            window: { label: '5-hour', durationSeconds: 5 * 3600 },
            status: 'available',
            statusReason: 'live',
          },
        ],
      },
    ]);

    const evidence = await detectLimitEvidence(
      adapter,
      { projectRoot: '/tmp' },
      {
        startedAt: '2026-09-16T11:55:00.000Z',
        endedAt: '2026-09-16T12:05:00.000Z',
        exitCode: 1,
      },
    );

    expect(evidence?.observation.kind).toBe('usage_limit');
    expect(evidence?.confidence).toBe('medium');
    expect(evidence?.retryAt).toBe(
      new Date(fixtureRaw.windows.five_hour.resetsAt * 1000).toISOString(),
    );
  });

  it('exhausted + zero exit -> null (clean exit is never a limit)', async () => {
    const adapter = mockAdapter('claude', async () => [
      {
        adapterId: 'claude',
        status: 'available',
        capturedAt: '2026-09-16T12:04:00.000Z',
        source: 'Claude Code status line',
        metrics: [
          {
            id: 'fiveHour',
            kind: 'quota',
            unit: 'percent',
            used: 100,
            remaining: 0,
            resetsAt: futureReset,
            window: { label: '5-hour', durationSeconds: 5 * 3600 },
            status: 'available',
            statusReason: 'live',
          },
        ],
      },
    ]);

    const evidence = await detectLimitEvidence(
      adapter,
      { projectRoot: '/tmp' },
      { startedAt, endedAt, exitCode: 0 },
    );

    expect(evidence).toBeNull();
  });

  it('exhausted + stale sample -> null', async () => {
    const adapter = mockAdapter('claude', async () => [
      {
        adapterId: 'claude',
        status: 'stale',
        capturedAt: '2026-09-16T12:04:00.000Z',
        source: 'Claude Code status line',
        metrics: [
          {
            id: 'fiveHour',
            kind: 'quota',
            unit: 'percent',
            used: 100,
            remaining: 0,
            resetsAt: futureReset,
            window: { label: '5-hour', durationSeconds: 5 * 3600 },
            status: 'available',
            statusReason: 'live',
          },
        ],
      },
    ]);

    const evidence = await detectLimitEvidence(
      adapter,
      { projectRoot: '/tmp' },
      { startedAt, endedAt, exitCode: 1 },
    );

    expect(evidence).toBeNull();
  });

  it('sample captured before run start -> null', async () => {
    const adapter = mockAdapter('claude', async () => [
      {
        adapterId: 'claude',
        status: 'available',
        capturedAt: '2026-09-16T11:59:00.000Z',
        source: 'Claude Code status line',
        metrics: [
          {
            id: 'fiveHour',
            kind: 'quota',
            unit: 'percent',
            used: 100,
            remaining: 0,
            resetsAt: futureReset,
            window: { label: '5-hour', durationSeconds: 5 * 3600 },
            status: 'available',
            statusReason: 'live',
          },
        ],
      },
    ]);

    const evidence = await detectLimitEvidence(
      adapter,
      { projectRoot: '/tmp' },
      { startedAt, endedAt, exitCode: 1 },
    );

    expect(evidence).toBeNull();
  });

  it('sample captured too long before run end -> null', async () => {
    const adapter = mockAdapter('claude', async () => [
      {
        adapterId: 'claude',
        status: 'available',
        capturedAt: '2026-09-16T12:00:00.000Z',
        source: 'Claude Code status line',
        metrics: [
          {
            id: 'fiveHour',
            kind: 'quota',
            unit: 'percent',
            used: 100,
            remaining: 0,
            resetsAt: futureReset,
            window: { label: '5-hour', durationSeconds: 5 * 3600 },
            status: 'available',
            statusReason: 'live',
          },
        ],
      },
    ]);

    const evidence = await detectLimitEvidence(
      adapter,
      { projectRoot: '/tmp' },
      {
        startedAt: '2026-09-16T12:00:00.000Z',
        endedAt: new Date(
          Date.parse('2026-09-16T12:00:00.000Z') + PLAN_USAGE_STALE_MS + 5000,
        ).toISOString(),
        exitCode: 1,
      },
    );

    expect(evidence).toBeNull();
  });

  it('short window exhausted -> rate_limit, not usage_limit', async () => {
    const adapter = mockAdapter('claude', async () => [
      {
        adapterId: 'claude',
        status: 'available',
        capturedAt: '2026-09-16T12:04:00.000Z',
        source: 'Claude Code status line',
        metrics: [
          {
            id: 'shortWindow',
            kind: 'quota',
            unit: 'percent',
            used: 100,
            remaining: 0,
            resetsAt: futureReset,
            window: { label: '1-minute', durationSeconds: 60 },
            status: 'available',
            statusReason: 'live',
          },
        ],
      },
    ]);

    const evidence = await detectLimitEvidence(
      adapter,
      { projectRoot: '/tmp' },
      { startedAt, endedAt, exitCode: 1 },
    );

    expect(evidence).toEqual({
      observation: {
        kind: 'rate_limit',
        detail: 'rate_limited',
        confidence: 'medium',
      },
      retryAt: futureReset,
      confidence: 'medium',
      source: 'usage_sample',
    });
  });

  it('collector throws -> null (never throws)', async () => {
    const adapter = mockAdapter('claude', async () => {
      throw new Error('Malformed usage file');
    });

    const evidence = await detectLimitEvidence(
      adapter,
      { projectRoot: '/tmp' },
      { startedAt, endedAt, exitCode: 1 },
    );

    expect(evidence).toBeNull();
  });

  it('quota remaining <= 1 percent counts as exhausted', async () => {
    const adapter = mockAdapter('claude', async () => [
      {
        adapterId: 'claude',
        status: 'available',
        capturedAt: '2026-09-16T12:04:00.000Z',
        source: 'Claude Code status line',
        metrics: [
          {
            id: 'fiveHour',
            kind: 'quota',
            unit: 'percent',
            used: 99.5,
            remaining: 0.5,
            resetsAt: futureReset,
            window: { label: '5-hour', durationSeconds: 5 * 3600 },
            status: 'available',
            statusReason: 'live',
          },
        ],
      },
    ]);

    const evidence = await detectLimitEvidence(
      adapter,
      { projectRoot: '/tmp' },
      { startedAt, endedAt, exitCode: 1 },
    );

    expect(evidence).not.toBeNull();
    expect(evidence?.observation.kind).toBe('usage_limit');
  });
});

describe('finalize paths integration', () => {
  const futureReset = '2026-09-16T14:30:00.000Z';

  async function setupRepoWithTask() {
    const root = await createRepository();
    directories.push(root);
    await mkdir(path.join(root, '.relay'), { recursive: true });
    const now = '2026-09-16T12:00:00.000Z';
    const state: RelayState = {
      schemaVersion: LATEST_STATE_SCHEMA,
      revision: 0,
      recentOperations: [],
      sessionId: 'session-test',
      projectRoot: root,
      task: {
        title: 'Test task',
        originalRequest: 'Test task',
        requirements: [],
        constraints: [],
        status: 'active' as const,
        createdAt: now,
        updatedAt: now,
      },
      git: {
        startingCommit: 'abc',
        startingBranch: 'main',
        dirtyAtStart: false,
      },
      runs: [],
      agentHistory: [],
      decisions: [],
      completedWork: [],
      remainingWork: [],
      tests: [],
      checkpoints: [],
      blockers: [],
      notes: [],
    };
    await writeState(root, state);
    return root;
  }

  it('Path A: exhausted + non-zero exit + fresh sample -> usage_limit, medium, retryAt set', async () => {
    const root = await setupRepoWithTask();
    const state = await readState(root);
    const adapter = mockAdapter('claude', async () => [
      {
        adapterId: 'claude',
        status: 'available',
        capturedAt: new Date().toISOString(),
        source: 'Claude Code status line',
        metrics: [
          {
            id: 'fiveHour',
            kind: 'quota',
            unit: 'percent',
            used: 100,
            remaining: 0,
            resetsAt: futureReset,
            window: { label: '5-hour', durationSeconds: 5 * 3600 },
            status: 'available',
            statusReason: 'live',
          },
        ],
      },
    ]);

    const host = new FakeProcessHost(1);
    const manager = new SessionManager(host);
    const managed = await manager.startRun({
      projectRoot: root,
      state,
      adapter,
      prompt: 'Do work',
    });

    const completed = await managed.completion;
    expect(completed.state.agentHistory.at(-1)?.exitClassification).toEqual({
      reason: 'usage_limit',
      confidence: 'medium',
      source: 'provider_event',
      providerCode: 'quota_exhausted',
      retryAt: futureReset,
    });
  });

  it('Path A: exhausted + zero exit -> completed', async () => {
    const root = await setupRepoWithTask();
    const state = await readState(root);
    const adapter = mockAdapter('claude', async () => [
      {
        adapterId: 'claude',
        status: 'available',
        capturedAt: new Date().toISOString(),
        source: 'Claude Code status line',
        metrics: [
          {
            id: 'fiveHour',
            kind: 'quota',
            unit: 'percent',
            used: 100,
            remaining: 0,
            resetsAt: futureReset,
            window: { label: '5-hour', durationSeconds: 5 * 3600 },
            status: 'available',
            statusReason: 'live',
          },
        ],
      },
    ]);

    const host = new FakeProcessHost(0);
    const manager = new SessionManager(host);
    const managed = await manager.startRun({
      projectRoot: root,
      state,
      adapter,
      prompt: 'Do work',
    });

    const completed = await managed.completion;
    expect(completed.state.agentHistory.at(-1)?.exitClassification).toEqual({
      reason: 'completed',
      confidence: 'high',
      source: 'provider_exit_code',
      providerCode: '0',
    });
  });

  it('Path A: collector throws -> unknown_failure, lease still released, no escape', async () => {
    const root = await setupRepoWithTask();
    const state = await readState(root);
    const adapter = mockAdapter('claude', async () => {
      throw new Error('Fatal collector error');
    });

    const host = new FakeProcessHost(1);
    const manager = new SessionManager(host);
    const managed = await manager.startRun({
      projectRoot: root,
      state,
      adapter,
      prompt: 'Do work',
    });

    const completed = await managed.completion;
    expect(
      completed.state.agentHistory.at(-1)?.exitClassification?.reason,
    ).toBe('unknown_failure');
    expect(completed.state.runs).toHaveLength(0); // lease released!
  });

  it('Path B: fallbackTerminalClassification produces usage_limit when limitEvidence provided', () => {
    const evidence: LimitEvidence = {
      observation: {
        kind: 'usage_limit',
        detail: 'quota_exhausted',
        confidence: 'medium',
      },
      retryAt: futureReset,
      confidence: 'medium',
      source: 'usage_sample',
    };

    const classification = fallbackTerminalClassification(
      'failed',
      1,
      evidence,
    );
    expect(classification).toEqual({
      reason: 'usage_limit',
      confidence: 'medium',
      source: 'provider_event',
      providerCode: 'quota_exhausted',
      retryAt: futureReset,
    });
  });

  it('Path B: fallbackTerminalClassification keeps completed and cancelled untouched', () => {
    const evidence: LimitEvidence = {
      observation: {
        kind: 'usage_limit',
        detail: 'quota_exhausted',
        confidence: 'medium',
      },
      retryAt: futureReset,
      confidence: 'medium',
      source: 'usage_sample',
    };

    expect(
      fallbackTerminalClassification('completed', 0, evidence).reason,
    ).toBe('completed');
    expect(
      fallbackTerminalClassification('cancelled', null, evidence).reason,
    ).toBe('user_cancelled');
  });

  it('Path B: finalizeTerminalRun detects limit and assigns retryAt', async () => {
    const root = await setupRepoWithTask();
    const state = await readState(root);
    const host = new FakeProcessHost(1, false);
    const manager = new SessionManager(host);
    const adapter = mockAdapter('claude');
    await manager.startRun({
      projectRoot: root,
      state,
      adapter,
      prompt: 'Do work',
      selection: { terminalId: 'term-path-b', operationId: 'op-path-b' },
    });

    const resetTime = new Date(Date.now() + 7200 * 1000).toISOString();
    const claudeAgent = getAgent('claude');
    const originalReadUsage = claudeAgent.readUsage;
    claudeAgent.readUsage = async () => [
      {
        adapterId: 'claude',
        status: 'available',
        capturedAt: new Date().toISOString(),
        source: 'Claude Code status line',
        metrics: [
          {
            id: 'fiveHour',
            kind: 'quota',
            unit: 'percent',
            used: 100,
            remaining: 0,
            resetsAt: resetTime,
            window: { label: '5-hour', durationSeconds: 5 * 3600 },
            status: 'available',
            statusReason: 'live',
          },
        ],
      },
    ];

    try {
      await finalizeTerminalRun({
        projectRoot: root,
        terminalId: 'term-path-b',
        status: 'failed',
        exitCode: 1,
        activeRuntimeSeconds: 5,
        runtimeSequence: 1,
      });

      const persisted = await readState(root);
      const run = persisted.agentHistory.at(-1);
      expect(run?.exitClassification?.reason).toBe('usage_limit');
      expect(run?.exitClassification?.confidence).toBe('medium');
      expect(run?.exitClassification?.retryAt).toBe(resetTime);
    } finally {
      claudeAgent.readUsage = originalReadUsage;
    }
  });

  it('Both finalize paths produce identical classification for identical inputs', async () => {
    const evidence: LimitEvidence = {
      observation: {
        kind: 'usage_limit',
        detail: 'quota_exhausted',
        confidence: 'medium',
      },
      retryAt: futureReset,
      confidence: 'medium',
      source: 'usage_sample',
    };

    // Path A via adapter.classifyExit
    const adapter = getAgent('claude');
    const pathAClassification = await adapter.classifyExit({
      exitCode: 1,
      signal: null,
      terminationIntent: 'none',
      observations: [evidence.observation],
      stdout: '',
      stderr: '',
    });
    if (evidence.retryAt) {
      pathAClassification.retryAt = evidence.retryAt;
    }

    // Path B via fallbackTerminalClassification
    const pathBClassification = fallbackTerminalClassification(
      'failed',
      1,
      evidence,
    );

    expect(pathAClassification).toEqual(pathBClassification);
    expect(pathAClassification).toEqual({
      reason: 'usage_limit',
      confidence: 'medium',
      source: 'provider_event',
      providerCode: 'quota_exhausted',
      retryAt: futureReset,
    });
  });
});
