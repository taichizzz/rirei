import { createHash } from 'node:crypto';
import {
  LATEST_STATE_SCHEMA,
  relayStateSchema,
  type RelayState,
} from './schema.js';

/**
 * Ordered, in-memory migrations for persisted Relay state. Each step upgrades a
 * single schema version to the next; `migrateState` walks them in order until
 * the payload reaches {@link LATEST_STATE_SCHEMA}, then validates the result.
 *
 * Persistent schema versions are deliberately independent from any JSON API
 * version: bumping one must never silently bump the other.
 */

type RawState = Record<string, unknown>;

const migrations: Array<(state: RawState) => RawState> = [
  // v1 -> v2: introduce the monotonic revision counter and the idempotency
  // ledger that the writer lock relies on. Both are additive.
  (state) => ({
    ...state,
    schemaVersion: 2,
    revision: 0,
    recentOperations: [],
  }),
  // v2 -> v3: introduce explicit run leases. An in-flight scalar run becomes an
  // `orphaned` lease rather than a `running` one: the process that owned it is
  // gone, and Relay does not claim to know whether the provider still runs.
  (state) => {
    const runId = state.currentRunId;
    const agent = state.currentAgent;
    const history = Array.isArray(state.agentHistory) ? state.agentHistory : [];
    const task = state.task as Record<string, unknown> | undefined;
    const closed = task?.status === 'completed' || task?.status === 'cancelled';
    const closedAt =
      (task?.updatedAt as string | undefined) ?? new Date().toISOString();
    if (closed) {
      return {
        ...state,
        schemaVersion: 3,
        runs: [],
        currentAgent: undefined,
        currentRunId: undefined,
        agentHistory: history.map((entry: Record<string, unknown>) =>
          entry.endedAt
            ? entry
            : {
                ...entry,
                endedAt: closedAt,
                exitCode: null,
                exitReason: 'interrupted',
              },
        ),
      };
    }
    let sourceIndex = history.findIndex(
      (run: Record<string, unknown>) =>
        (runId && run.id === runId) || (!runId && agent && run.agent === agent),
    );
    if (sourceIndex < 0)
      sourceIndex = history.findLastIndex(
        (run: Record<string, unknown>) => !run.endedAt,
      );
    const source = history[sourceIndex] as Record<string, unknown> | undefined;
    const now = new Date().toISOString();
    const stableTime =
      (source?.startedAt as string | undefined) ??
      ((state.task as Record<string, unknown> | undefined)?.updatedAt as
        string | undefined) ??
      now;
    const stableMigratedRunId = `migrated-${createHash('sha256')
      .update(
        `${String(state.sessionId)}\0${String(agent ?? source?.agent)}\0${String(source?.startedAt)}`,
      )
      .digest('hex')
      .slice(0, 24)}`;
    const resolvedRunId =
      (runId as string | undefined) ??
      (source?.id as string | undefined) ??
      stableMigratedRunId;
    const resolvedAgent =
      (agent as string | undefined) ??
      (source?.agent as string | undefined) ??
      'unknown';
    const hasUnfinishedRun = Boolean(
      runId || agent || (source && !source.endedAt),
    );
    const runs = hasUnfinishedRun
      ? [
          {
            runId: resolvedRunId,
            worktreePath: state.projectRoot,
            projectRoot: state.projectRoot,
            agent: resolvedAgent,
            model: source?.model,
            effort: source?.effort,
            launchMode: (source?.launchMode as string) ?? 'new',
            providerSessionId: source?.providerSessionId,
            controllerId: 'migrated',
            startedAt: stableTime,
            lastSeenAt: stableTime,
            status: 'orphaned',
          },
        ]
      : [];
    const agentHistory = history.map((entry, index) =>
      index === sourceIndex && !entry.id
        ? { ...entry, id: resolvedRunId }
        : entry,
    );
    return {
      ...state,
      schemaVersion: 3,
      runs,
      agentHistory,
      currentAgent: hasUnfinishedRun ? resolvedAgent : undefined,
      currentRunId: hasUnfinishedRun ? resolvedRunId : undefined,
    };
  },
];

export function readSchemaVersion(raw: unknown): number {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    throw new Error('Relay state must be a JSON object.');
  const version = (raw as RawState).schemaVersion;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1)
    throw new Error('Relay state is missing a valid schemaVersion.');
  return version;
}

export function migrateState(raw: unknown): RelayState {
  const version = readSchemaVersion(raw);
  if (version > LATEST_STATE_SCHEMA)
    throw new Error(
      `Relay state schema v${version} is newer than this build supports ` +
        `(v${LATEST_STATE_SCHEMA}). Upgrade Relay to open this project.`,
    );
  let migrated = raw as RawState;
  for (let from = version; from < LATEST_STATE_SCHEMA; from += 1) {
    const step = migrations[from - 1];
    if (!step)
      throw new Error(
        `No Relay migration is registered from schema v${from}. Upgrade Relay.`,
      );
    migrated = step(migrated);
  }
  return relayStateSchema.parse(migrated);
}
