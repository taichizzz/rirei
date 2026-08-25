import { createHash } from 'node:crypto';
import { hostname, uptime } from 'node:os';
import { AGENT_EXIT_REASONS } from '../agents/adapter.js';
import {
  LATEST_STATE_SCHEMA,
  relayStateSchema,
  type ControllerIdentity,
  type RelayState,
} from './schema.js';

/** Derive a structured controller identity from a legacy `controllerId` string. */
export function deriveControllerIdentity(
  controllerId: string | undefined,
  startedAt?: string,
): ControllerIdentity {
  void startedAt;
  const value = typeof controllerId === 'string' ? controllerId : 'migrated';
  const [kind, ...rest] = value.split(':');
  const instanceId = rest.join(':') || 'migrated';
  const parsedPid = Number.parseInt(instanceId, 10);
  return {
    kind:
      kind === 'desktop' || kind === 'terminal' || kind === 'daemon'
        ? kind === 'terminal'
          ? 'desktop'
          : kind
        : 'cli',
    instanceId,
    ...(Number.isInteger(parsedPid) && parsedPid > 0 ? { pid: parsedPid } : {}),
    bootId: `${hostname()}:${Math.round((Date.now() - uptime() * 1000) / 60_000)}`,
  };
}

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
  // v3 -> v4: add the canonical, provenance-aware handoff note log. Legacy
  // arrays remain intact because their authorship and Git anchors are unknown.
  (state) => ({
    ...state,
    schemaVersion: 4,
    notes: [],
  }),
  // v4 -> v5: persist a durable, structured exit classification for closed runs
  // so recovery and UI can distinguish a verified outcome from a best-effort
  // guess. The legacy `exitReason` string is retained alongside it.
  (state) => {
    const history = Array.isArray(state.agentHistory) ? state.agentHistory : [];
    return {
      ...state,
      schemaVersion: 5,
      agentHistory: history.map((entry) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry))
          return entry;
        const record = entry as Record<string, unknown>;
        if (!record.endedAt) return entry;
        const exitCode =
          typeof record.exitCode === 'number' ? record.exitCode : null;
        const exitReason =
          typeof record.exitReason === 'string' ? record.exitReason : undefined;
        const reason =
          exitReason &&
          (AGENT_EXIT_REASONS as readonly string[]).includes(exitReason)
            ? exitReason
            : exitCode === 0
              ? 'completed'
              : 'unknown_failure';
        const providerCode =
          exitCode !== null
            ? String(exitCode)
            : reason === 'completed'
              ? '0'
              : undefined;
        const existing =
          record.exitClassification &&
          typeof record.exitClassification === 'object' &&
          !Array.isArray(record.exitClassification)
            ? (record.exitClassification as Record<string, unknown>)
            : undefined;
        const existingReason =
          typeof existing?.reason === 'string' &&
          (AGENT_EXIT_REASONS as readonly string[]).includes(existing.reason)
            ? existing.reason
            : undefined;
        const normalizedReason = existingReason ?? reason;
        return {
          ...record,
          exitReason: normalizedReason,
          exitClassification: existing ?? {
            reason: normalizedReason,
            confidence:
              normalizedReason === 'completed' && exitCode === 0
                ? 'high'
                : 'medium',
            source: 'fallback',
            ...(providerCode ? { providerCode } : {}),
          },
        };
      }),
    };
  },
  // v5 -> v6: persist a structured, host-qualified controller identity on each
  // lease alongside the legacy `controllerId` string. Pids are meaningless on
  // their own: the same pid can be reused after a reboot or exist on another
  // machine. The object carries host and pid so ownership is collision-proof.
  (state) => {
    const runs = Array.isArray(state.runs) ? state.runs : [];
    return {
      ...state,
      schemaVersion: 6,
      runs: runs.map((lease) => {
        if (!lease || typeof lease !== 'object' || Array.isArray(lease))
          return lease;
        const record = lease as Record<string, unknown>;
        if (record.controller) return lease;
        return {
          ...record,
          controller: deriveControllerIdentity(
            record.controllerId as string | undefined,
            record.startedAt as string | undefined,
          ),
        };
      }),
    };
  },
  // v6 -> v7: boot-qualify controller identity and persist lifecycle evidence.
  (state) => {
    const runs = Array.isArray(state.runs) ? state.runs : [];
    return {
      ...state,
      schemaVersion: 7,
      runs: runs.map((lease) => {
        if (!lease || typeof lease !== 'object' || Array.isArray(lease))
          return lease;
        const record = lease as Record<string, unknown>;
        const old = record.controller as Record<string, unknown> | undefined;
        const controller = old?.instanceId
          ? old
          : old?.id
            ? {
                kind: old.kind === 'terminal' ? 'desktop' : old.kind,
                instanceId: old.id,
                ...(typeof old.pid === 'number' ? { pid: old.pid } : {}),
                bootId: `${String(old.host ?? hostname())}:${Math.round((Date.now() - uptime() * 1000) / 60_000)}`,
              }
            : deriveControllerIdentity(
                record.controllerId as string | undefined,
                record.startedAt as string | undefined,
              );
        return {
          ...record,
          controller,
          controllerId: `${String(controller.kind)}:${String(controller.bootId)}:${String(controller.instanceId)}`,
          lifecycleStatus:
            typeof record.lifecycleStatus === 'string'
              ? record.lifecycleStatus
              : 'running',
        };
      }),
    };
  },
  // v7 -> v8: make lifecycle and runtime explicit daemon observations. Legacy
  // timestamps cannot distinguish active work from permission waits, so the
  // migration starts the authoritative runtime at zero rather than guessing.
  (state) => {
    const runs = Array.isArray(state.runs) ? state.runs : [];
    return {
      ...state,
      schemaVersion: 8,
      runs: runs.map((lease) => {
        if (!lease || typeof lease !== 'object' || Array.isArray(lease))
          return lease;
        const record = lease as Record<string, unknown>;
        const status = record.status;
        const lifecycleStatus =
          status === 'starting'
            ? 'starting'
            : status === 'running'
              ? 'working'
              : status === 'waiting'
                ? 'waiting_for_input'
                : status === 'stopping'
                  ? 'stopping'
                  : 'orphaned';
        return {
          ...record,
          lifecycleStatus,
          ...(status === 'waiting' ? { attentionKind: 'unknown' } : {}),
          activeRuntimeSeconds: 0,
          runtimeSequence: 0,
        };
      }),
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
