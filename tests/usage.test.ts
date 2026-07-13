import { describe, expect, it } from 'vitest';
import { summarizeUsage } from '../src/usage.js';
import type { RelayState } from '../src/state/schema.js';

function baseState(overrides: Partial<RelayState> = {}): RelayState {
  const now = '2026-07-12T00:00:00.000Z';
  return {
    schemaVersion: 1,
    sessionId: 'session-1',
    projectRoot: '/tmp/repo',
    task: {
      title: 'Add OAuth',
      originalRequest: 'Add OAuth',
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
    agentHistory: [],
    decisions: [],
    completedWork: [],
    remainingWork: [],
    tests: [],
    checkpoints: [],
    blockers: [],
    ...overrides,
  };
}

describe('summarizeUsage', () => {
  it('reports every registered agent, including ones never run', () => {
    const summary = summarizeUsage(baseState());
    const ids = summary.agents.map((agent) => agent.id);
    expect(ids).toContain('claude');
    expect(ids).toContain('codex');
    expect(ids).toContain('gemini');
    expect(ids).toContain('antigravity');
    expect(summary.agents.every((agent) => agent.runs === 0)).toBe(true);
  });

  it('counts runs, sums durations, and reads the last exit reason', () => {
    const summary = summarizeUsage(
      baseState({
        agentHistory: [
          {
            agent: 'codex',
            startedAt: '2026-07-12T00:00:00.000Z',
            endedAt: '2026-07-12T00:05:00.000Z',
            exitReason: 'completed',
          },
          {
            agent: 'codex',
            startedAt: '2026-07-12T01:00:00.000Z',
            endedAt: '2026-07-12T01:10:00.000Z',
            exitReason: 'user_cancelled',
          },
        ],
      }),
    );
    const codex = summary.agents.find((agent) => agent.id === 'codex');
    expect(codex).toMatchObject({
      runs: 2,
      totalMs: 15 * 60 * 1000,
      lastReason: 'user_cancelled',
      activeNow: false,
    });
  });

  it('marks the current agent active and a not-yet-ended run as running', () => {
    const summary = summarizeUsage(
      baseState({
        currentAgent: 'claude',
        agentHistory: [
          { agent: 'claude', startedAt: '2026-07-12T02:00:00.000Z' },
        ],
      }),
    );
    const claude = summary.agents.find((agent) => agent.id === 'claude');
    expect(claude?.activeNow).toBe(true);
    expect(claude?.lastReason).toBe('running');
    expect(claude?.totalMs).toBe(0);
  });

  it('clips observed activity into rolling five-hour and seven-day windows', () => {
    const summary = summarizeUsage(
      baseState({
        agentHistory: [
          {
            agent: 'codex',
            startedAt: '2026-07-11T20:00:00.000Z',
            endedAt: '2026-07-11T22:00:00.000Z',
          },
          {
            agent: 'codex',
            startedAt: '2026-07-05T23:00:00.000Z',
            endedAt: '2026-07-06T01:00:00.000Z',
          },
          {
            agent: 'claude',
            startedAt: '2026-07-11T23:30:00.000Z',
          },
        ],
        currentAgent: 'claude',
      }),
      new Date('2026-07-12T00:00:00.000Z'),
    );
    const codex = summary.agents.find((agent) => agent.id === 'codex');
    const claude = summary.agents.find((agent) => agent.id === 'claude');
    expect(codex?.fiveHours).toEqual({ runs: 1, totalMs: 2 * 60 * 60 * 1000 });
    expect(codex?.week).toEqual({ runs: 2, totalMs: 4 * 60 * 60 * 1000 });
    expect(claude?.fiveHours).toEqual({ runs: 1, totalMs: 30 * 60 * 1000 });
    expect(summary.fiveHours).toEqual({ runs: 2, totalMs: 150 * 60 * 1000 });
  });
});
