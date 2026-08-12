import { describe, expect, it } from 'vitest';
import { LATEST_STATE_SCHEMA } from '../../src/state/schema.js';
import { migrateState, readSchemaVersion } from '../../src/state/migrations.js';

function legacyV1(): Record<string, unknown> {
  const now = '2026-01-01T00:00:00.000Z';
  return {
    schemaVersion: 1,
    sessionId: 'session',
    projectRoot: '/tmp/project',
    task: {
      title: 'Task',
      originalRequest: 'Task',
      requirements: [],
      constraints: [],
      status: 'active',
      createdAt: now,
      updatedAt: now,
    },
    git: { startingCommit: 'abc', startingBranch: 'main', dirtyAtStart: false },
    agentHistory: [{ agent: 'claude', startedAt: now }],
    decisions: [],
    completedWork: [],
    remainingWork: [],
    tests: [],
    checkpoints: [],
    blockers: [],
  };
}

describe('state migrations', () => {
  it('upgrades a v1 payload to the latest schema additively', () => {
    const migrated = migrateState(legacyV1());
    expect(migrated.schemaVersion).toBe(LATEST_STATE_SCHEMA);
    expect(migrated.revision).toBe(0);
    expect(migrated.recentOperations).toEqual([]);
    expect(migrated.notes).toEqual([]);
    expect(migrated.runs[0]).toMatchObject({
      agent: 'claude',
      status: 'orphaned',
    });
    expect(migrated.agentHistory[0]).toMatchObject({
      id: migrated.runs[0]?.runId,
      agent: 'claude',
      startedAt: '2026-01-01T00:00:00.000Z',
    });
  });

  it('round-trips already-current state unchanged', () => {
    const first = migrateState(legacyV1());
    const second = migrateState(first);
    expect(second).toEqual(first);
  });

  it('adds an empty note log without inventing provenance for v3 records', () => {
    const current = migrateState(legacyV1());
    const legacyV3 = {
      ...current,
      schemaVersion: 3,
      decisions: [
        {
          summary: 'Keep the old decision',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    } as Record<string, unknown>;
    delete legacyV3.notes;
    const migrated = migrateState(legacyV3);
    expect(migrated.notes).toEqual([]);
    expect(migrated.decisions).toHaveLength(1);
  });

  it('converts an in-flight v2 run into an orphaned lease', () => {
    // Ownership is unknown after an upgrade, so the run must not claim to be
    // running: "unknown remains unknown".
    const migrated = migrateState({
      ...legacyV1(),
      schemaVersion: 2,
      revision: 4,
      recentOperations: [],
      currentAgent: 'claude',
      currentRunId: 'run-9',
      agentHistory: [
        { id: 'run-9', agent: 'claude', startedAt: '2026-01-01T00:00:00.000Z' },
      ],
    });
    expect(migrated.schemaVersion).toBe(LATEST_STATE_SCHEMA);
    expect(migrated.runs).toHaveLength(1);
    expect(migrated.runs[0]).toMatchObject({
      runId: 'run-9',
      agent: 'claude',
      status: 'orphaned',
      controllerId: 'migrated',
    });
    expect(migrated.revision).toBe(4);
  });

  it('migrates a v2 state with no in-flight run to an empty lease list', () => {
    const legacy = legacyV1();
    legacy.agentHistory = [
      {
        agent: 'claude',
        startedAt: '2026-01-01T00:00:00.000Z',
        endedAt: '2026-01-01T00:01:00.000Z',
        exitCode: 0,
        exitReason: 'completed',
      },
    ];
    const migrated = migrateState({
      ...legacy,
      schemaVersion: 2,
      revision: 1,
      recentOperations: [],
    });
    expect(migrated.runs).toEqual([]);
  });

  it('closes unfinished history when the legacy task is already completed', () => {
    const legacy = legacyV1();
    legacy.task = {
      ...(legacy.task as Record<string, unknown>),
      status: 'completed',
      updatedAt: '2026-01-02T00:00:00.000Z',
    };
    const migrated = migrateState(legacy);
    expect(migrated.runs).toEqual([]);
    expect(migrated.currentAgent).toBeUndefined();
    expect(migrated.agentHistory[0]).toMatchObject({
      endedAt: '2026-01-02T00:00:00.000Z',
      exitCode: null,
      exitReason: 'interrupted',
    });
  });

  it('assigns one stable ID to a legacy in-flight run and its history', () => {
    const legacy = {
      ...legacyV1(),
      schemaVersion: 2,
      revision: 2,
      recentOperations: [],
      currentAgent: 'claude',
    };
    const first = migrateState(legacy);
    const second = migrateState(legacy);
    expect(first.runs[0]?.runId).toBe(first.agentHistory[0]?.id);
    expect(second.runs[0]?.runId).toBe(first.runs[0]?.runId);
    expect(second.runs[0]?.lastSeenAt).toBe(first.runs[0]?.lastSeenAt);
  });

  it('rejects a schema version newer than this build supports', () => {
    const future = { ...legacyV1(), schemaVersion: LATEST_STATE_SCHEMA + 1 };
    expect(() => migrateState(future)).toThrow(/newer than this build/);
  });

  it('rejects payloads without a valid schemaVersion', () => {
    expect(() => readSchemaVersion({})).toThrow(/valid schemaVersion/);
    expect(() => readSchemaVersion(null)).toThrow(/JSON object/);
    expect(() => readSchemaVersion([])).toThrow(/JSON object/);
  });
});
