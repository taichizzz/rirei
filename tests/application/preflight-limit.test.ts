import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentAdapter,
  ProviderUsageSnapshot,
} from '../../src/agents/adapter.js';
import {
  checkPreflightLimit,
  detectLimitEvidence,
  isQuotaExhausted,
  type PreflightLimitWarning,
} from '../../src/agents/limit-detection.js';
import { SessionManager } from '../../src/application/sessions.js';
import type {
  ProcessEvent,
  ProcessHandle,
  ProcessHost,
  ProcessListener,
  ProcessStartRequest,
  Unsubscribe,
} from '../../src/process/process-host.js';
import {
  LATEST_STATE_SCHEMA,
  type RelayState,
} from '../../src/state/schema.js';
import { readState, writeState } from '../../src/state/store.js';
import { createRepository, removeRepository } from '../helpers.js';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const roots: string[] = [];

class FakeProcessHost implements ProcessHost {
  starts: ProcessStartRequest[] = [];
  private readonly listeners = new Map<string, Set<ProcessListener>>();

  async start(request: ProcessStartRequest): Promise<ProcessHandle> {
    this.starts.push(request);
    const id = `proc-${this.starts.length}`;
    this.listeners.set(id, new Set());
    return { id };
  }

  async stop(handleId: string): Promise<void> {
    this.emit(handleId, {
      type: 'exit',
      result: {
        exitCode: 0,
        signal: null,
        terminationIntent: 'user_stop',
        observations: [],
        stdout: '',
        stderr: '',
      },
    });
  }

  async interrupt(handleId: string): Promise<void> {
    this.emit(handleId, {
      type: 'exit',
      result: {
        exitCode: 0,
        signal: null,
        terminationIntent: 'user_interrupt',
        observations: [],
        stdout: '',
        stderr: '',
      },
    });
  }

  async write(): Promise<void> {}
  async resize(): Promise<void> {}

  subscribe(handleId: string, listener: ProcessListener): Unsubscribe {
    const set = this.listeners.get(handleId) ?? new Set();
    set.add(listener);
    this.listeners.set(handleId, set);
    return () => set.delete(listener);
  }

  emit(handleId: string, event: ProcessEvent): void {
    const set = this.listeners.get(handleId);
    if (!set) return;
    for (const listener of [...set]) {
      listener(event);
    }
  }

  exit(handleId: string, exitCode = 0): void {
    this.emit(handleId, {
      type: 'exit',
      result: {
        exitCode,
        signal: null,
        terminationIntent: 'none',
        observations: [],
        stdout: '',
        stderr: '',
      },
    });
  }
}

async function setupProject(): Promise<{ root: string; state: RelayState }> {
  const root = await createRepository();
  roots.push(root);
  await mkdir(path.join(root, '.relay'), { recursive: true });
  const now = new Date().toISOString();
  const state: RelayState = {
    schemaVersion: LATEST_STATE_SCHEMA,
    revision: 0,
    recentOperations: [],
    sessionId: 'session-preflight',
    projectRoot: root,
    task: {
      title: 'Preflight task',
      originalRequest: 'Preflight task',
      requirements: [],
      constraints: [],
      status: 'active',
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
  return { root, state };
}

function makeAdapter(
  id: 'claude' | 'codex' | 'gemini',
  displayName: string,
  readUsage?: () => Promise<ProviderUsageSnapshot[]>,
): AgentAdapter {
  return {
    id,
    displayName,
    executable: id,
    capabilities: {
      interactive: true,
      headless: false,
      modelDiscovery: false,
      modelVariants: false,
      authenticationDiscovery: false,
      usageCollection: Boolean(readUsage),
      structuredEvents: false,
      messageDelivery: {
        inbox: true,
        nextSafeTurn: false,
        wake: false,
        source: 'relay_inbox',
      },
    },
    async detectInstallation() {
      return { status: 'ready' };
    },
    async detectAuthentication() {
      return {
        status: 'authenticated',
        checkedAt: new Date().toISOString(),
        source: 'test',
        confidence: 'high',
      };
    },
    async buildInteractiveCommand() {
      return { executable: id, args: [] };
    },
    async classifyExit(result) {
      return {
        reason: result.exitCode === 0 ? 'completed' : 'unknown_failure',
        confidence: 'high',
        source: 'fallback',
      };
    },
    ...(readUsage ? { readUsage } : {}),
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) await removeRepository(root);
  }
});

describe('Phase 3: Pre-flight limit warning', () => {
  describe('Shared exhaustion predicate (isQuotaExhausted)', () => {
    it('exhausted when remaining === 0', () => {
      expect(
        isQuotaExhausted({
          id: 'q',
          kind: 'quota',
          remaining: 0,
        }),
      ).toBe(true);
    });

    it('exhausted when used >= limit', () => {
      expect(
        isQuotaExhausted({
          id: 'q',
          kind: 'quota',
          used: 100,
          limit: 100,
        }),
      ).toBe(true);
      expect(
        isQuotaExhausted({
          id: 'q',
          kind: 'quota',
          used: 105,
          limit: 100,
        }),
      ).toBe(true);
      expect(
        isQuotaExhausted({
          id: 'q',
          kind: 'quota',
          used: 99,
          limit: 100,
        }),
      ).toBe(false);
    });

    it('exhausted when unit is percent and remaining <= 1', () => {
      expect(
        isQuotaExhausted({
          id: 'q',
          kind: 'quota',
          unit: 'percent',
          remaining: 1,
        }),
      ).toBe(true);
      expect(
        isQuotaExhausted({
          id: 'q',
          kind: 'quota',
          unit: 'percent',
          remaining: 0,
        }),
      ).toBe(true);
      expect(
        isQuotaExhausted({
          id: 'q',
          kind: 'quota',
          unit: 'percent',
          remaining: 2,
        }),
      ).toBe(false);
    });

    it('exhausted when unit is percent and used >= 99', () => {
      expect(
        isQuotaExhausted({
          id: 'q',
          kind: 'quota',
          unit: 'percent',
          used: 99,
        }),
      ).toBe(true);
      expect(
        isQuotaExhausted({
          id: 'q',
          kind: 'quota',
          unit: 'percent',
          used: 100,
        }),
      ).toBe(true);
      expect(
        isQuotaExhausted({
          id: 'q',
          kind: 'quota',
          unit: 'percent',
          used: 98,
        }),
      ).toBe(false);
    });

    it('returns false for stale metrics or non-quota metrics', () => {
      expect(
        isQuotaExhausted({
          id: 'q',
          kind: 'quota',
          remaining: 0,
          status: 'stale',
        }),
      ).toBe(false);
      expect(
        isQuotaExhausted({
          id: 'm',
          kind: 'metric',
          remaining: 0,
        }),
      ).toBe(false);
    });

    it('is used by both detectLimitEvidence and checkPreflightLimit', async () => {
      const futureReset = new Date(Date.now() + 3600 * 1000).toISOString();
      const snapshot: ProviderUsageSnapshot = {
        adapterId: 'claude',
        status: 'available',
        capturedAt: new Date().toISOString(),
        metrics: [
          {
            id: 'fiveHour',
            kind: 'quota',
            unit: 'percent',
            used: 100,
            remaining: 0,
            resetsAt: futureReset,
            window: { label: '5-hour', durationSeconds: 5 * 3600 },
          },
        ],
      };
      const testAdapter = makeAdapter('claude', 'Claude', async () => [
        snapshot,
      ]);

      // Assert pre-flight identifies exhaustion
      const preflight = await checkPreflightLimit(testAdapter, {
        projectRoot: '/test',
      });
      expect(preflight).not.toBeNull();
      expect(preflight?.adapterId).toBe('claude');

      // Assert detection identifies exhaustion with the same metric definition
      const now = new Date();
      const startedAt = new Date(now.getTime() - 60000).toISOString();
      const endedAt = now.toISOString();
      const detection = await detectLimitEvidence(
        testAdapter,
        { projectRoot: '/test' },
        {
          startedAt,
          endedAt,
          exitCode: 1,
        },
      );
      expect(detection).not.toBeNull();
      expect(detection?.observation.kind).toBe('usage_limit');
    });
  });

  describe('prepareRun integration', () => {
    it('adapter without readUsage -> no warning, no error, launch proceeds', async () => {
      const { root, state } = await setupProject();
      const noUsageAdapter = makeAdapter('gemini', 'Gemini');
      const host = new FakeProcessHost();
      const manager = new SessionManager(host);

      let warningSurfaced = false;
      const run = await manager.startRun({
        projectRoot: root,
        state,
        adapter: noUsageAdapter,
        prompt: 'Work',
        selection: {
          onPreflightWarning: () => {
            warningSurfaced = true;
          },
        },
      });

      expect(run.warning).toBeUndefined();
      expect(warningSurfaced).toBe(false);
      expect(host.starts).toHaveLength(1);
    });

    it('exhausted + fresh sample -> warning surfaced, launch still proceeds', async () => {
      const { root, state } = await setupProject();
      const futureReset = new Date(Date.now() + 7200 * 1000).toISOString();
      const claudeAdapter = makeAdapter('claude', 'Claude', async () => [
        {
          adapterId: 'claude',
          status: 'available',
          capturedAt: new Date().toISOString(),
          metrics: [
            {
              id: 'fiveHour',
              kind: 'quota',
              unit: 'percent',
              used: 100,
              remaining: 0,
              resetsAt: futureReset,
              window: { label: '5-hour', durationSeconds: 5 * 3600 },
            },
          ],
        },
      ]);

      const host = new FakeProcessHost();
      const manager = new SessionManager(host);

      const stderrSpy = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);
      let capturedWarning: PreflightLimitWarning | null = null;

      const run = await manager.startRun({
        projectRoot: root,
        state,
        adapter: claudeAdapter,
        prompt: 'Work',
        selection: {
          interactive: false,
          onPreflightWarning: (w) => {
            capturedWarning = w;
          },
        },
      });

      expect(run.warning).toBeDefined();
      expect(capturedWarning).toBeDefined();
      expect(capturedWarning.message).toContain('Claude reports 0% remaining');
      // Warning was surfaced to stderr
      expect(stderrSpy).toHaveBeenCalled();
      // Launch still proceeded!
      expect(host.starts).toHaveLength(1);
    });

    it('exhausted + stale sample -> no warning, launch proceeds', async () => {
      const { root, state } = await setupProject();
      const pastCapture = new Date(Date.now() - 30 * 60 * 1000).toISOString(); // 30 mins ago (> 15 mins)
      const claudeAdapter = makeAdapter('claude', 'Claude', async () => [
        {
          adapterId: 'claude',
          status: 'available',
          capturedAt: pastCapture,
          metrics: [
            {
              id: 'fiveHour',
              kind: 'quota',
              unit: 'percent',
              used: 100,
              remaining: 0,
            },
          ],
        },
      ]);

      const host = new FakeProcessHost();
      const manager = new SessionManager(host);

      let warningSurfaced = false;
      const run = await manager.startRun({
        projectRoot: root,
        state,
        adapter: claudeAdapter,
        prompt: 'Work',
        selection: {
          interactive: false,
          onPreflightWarning: () => {
            warningSurfaced = true;
          },
        },
      });

      expect(run.warning).toBeUndefined();
      expect(warningSurfaced).toBe(false);
      expect(host.starts).toHaveLength(1);
    });

    it('--fail-on-exhausted + exhausted -> launch refused', async () => {
      const { root, state } = await setupProject();
      const claudeAdapter = makeAdapter('claude', 'Claude', async () => [
        {
          adapterId: 'claude',
          status: 'available',
          capturedAt: new Date().toISOString(),
          metrics: [
            {
              id: 'fiveHour',
              kind: 'quota',
              unit: 'percent',
              used: 100,
              remaining: 0,
            },
          ],
        },
      ]);

      const host = new FakeProcessHost();
      const manager = new SessionManager(host);

      await expect(
        manager.startRun({
          projectRoot: root,
          state,
          adapter: claudeAdapter,
          prompt: 'Work',
          selection: {
            failOnExhausted: true,
          },
        }),
      ).rejects.toThrow(/Launch refused \(--fail-on-exhausted\)/);

      expect(host.starts).toHaveLength(0);
    });

    it('interactive confirmation proceeds when confirmed and cancels when rejected', async () => {
      const { root, state } = await setupProject();
      const futureReset = new Date(Date.now() + 3600 * 1000).toISOString();
      const claudeAdapter = makeAdapter('claude', 'Claude', async () => [
        {
          adapterId: 'claude',
          status: 'available',
          capturedAt: new Date().toISOString(),
          metrics: [
            {
              id: 'fiveHour',
              kind: 'quota',
              unit: 'percent',
              used: 100,
              remaining: 0,
              resetsAt: futureReset,
            },
          ],
        },
      ]);

      const host = new FakeProcessHost();
      const manager = new SessionManager(host);

      // Branch 1: confirmed -> proceeds
      let confirmPromptReceived = '';
      const run = await manager.startRun({
        projectRoot: root,
        state,
        adapter: claudeAdapter,
        prompt: 'Work',
        selection: {
          interactive: true,
          confirmExhausted: async (msg) => {
            confirmPromptReceived = msg;
            return true;
          },
        },
      });

      expect(run.warning).toBeDefined();
      expect(confirmPromptReceived).toMatch(
        /Claude reports 0% remaining.*Continue\?/,
      );
      expect(host.starts).toHaveLength(1);

      // Branch 2: declined -> launch cancelled
      await expect(
        manager.startRun({
          projectRoot: root,
          state: await readState(root),
          adapter: claudeAdapter,
          prompt: 'Work',
          selection: {
            interactive: true,
            confirmExhausted: async () => false,
          },
        }),
      ).rejects.toThrow(/Launch cancelled/);
    });
  });
});
