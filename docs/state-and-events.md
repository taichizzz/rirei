# State and events

Relay's structured memory is `.relay/state.json`, validated by the Zod schema in
`src/state/schema.ts`. An atomic, bounded activity snapshot in Rirei's application-support
directory provides sanitized session status for external UIs.

## `RelayState` schema

```ts
interface RelayState {
  schemaVersion: 3;
  revision: number;
  recentOperations: OperationRecord[];
  sessionId: string; // crypto.randomUUID()
  projectRoot: string;

  task: {
    title: string; // first line of the original request
    originalRequest: string;
    requirements: string[];
    constraints: string[];
    status: 'active' | 'blocked' | 'completed' | 'cancelled';
    createdAt: string; // ISO 8601
    updatedAt: string;
  };

  git: {
    startingCommit: string; // "unborn" if the repo had no HEAD at start
    currentCommit?: string;
    startingBranch: string;
    currentBranch?: string;
    dirtyAtStart: boolean;
  };

  runs: RunLease[]; // authoritative active provider ownership
  currentAgent?: string; // compatibility mirror of the first active lease
  currentRunId?: string;
  agentHistory: AgentRunRecord[];
  decisions: DecisionRecord[];
  completedWork: WorkItem[];
  remainingWork: WorkItem[];
  tests: TestResult[];
  checkpoints: CheckpointRecord[];
  blockers: BlockerRecord[];
}
```

### Record shapes

```ts
type WorkItem = { description: string; updatedAt: string };
type DecisionRecord = {
  summary: string;
  rationale?: string;
  createdAt: string;
};
type TestResult = {
  command: string;
  status: 'passed' | 'failed' | 'skipped';
  exitCode: number | null;
  durationMs: number;
  summary?: string;
  createdAt: string;
};
type CheckpointRecord = { id: string; createdAt: string; path: string };
type BlockerRecord = { description: string; createdAt: string };
type AgentRunRecord = {
  id?: string; // stable ID on new records; optional on migrated legacy records
  agent: string;
  model?: string; // explicit session override; absent means provider default
  effort?: string; // explicit session override; absent means provider default
  startedAt: string;
  endedAt?: string;
  exitCode?: number | null;
  exitReason?: string;
  launchMode?: 'new' | 'resume' | 'fork';
  providerSessionId?: string;
  terminalId?: string;
  workspaceId?: string;
  branchLabel?: string;
  role?: 'implement' | 'review' | 'verify' | 'investigate';
};
```

`RunLease` records one active provider's run, controller, provider, selected worktree, launch
mode, timestamps, and status. The authoritative concurrency invariant is at most one writing
lease per working tree. Several agents may run concurrently only when they own different
worktrees.

Agent runs are appended in launch order and form the durable source for Rirei's session
timeline. `model` and `effort` record only overrides Relay actually passed to the provider.
Their absence means **Auto** (the provider chose its default); it does not claim which model
the provider ultimately resolved. Both fields are optional so existing schema-version-1
state files and older run records continue to validate without migration.

Every field is validated on read. Timestamps are ISO-8601 strings; `datetime()` validation
means a malformed timestamp is rejected.

When an agent exits, Relay re-reads the newest state and updates only the matching run ID.
This preserves checkpoints, tests, and task-status changes written while the agent was active.

## Which fields are populated today

- **Set automatically:** `revision`, `recentOperations`, `sessionId`, `projectRoot`,
  `task.title/originalRequest/status/createdAt/updatedAt`, the full `git` baseline, `runs`,
  compatibility mirrors, `agentHistory`, `tests`
  (via `finish --run-tests`), and `checkpoints`.
- **Present but not yet populated by any command:** `task.requirements`, `task.constraints`,
  `decisions`, `completedWork`, `remainingWork`, and `blockers`. They are initialized to
  empty arrays and are surfaced by `status` (as counts) and by the handoff. Populating them
  is where structured progress-tracking will plug in; until then they stay empty unless
  state is edited directly.

## Atomic writes

`writeState()` (`src/state/store.ts`) never writes `state.json` in place:

1. Acquire the repository-scoped writer lock.
2. Validate the expected revision and optional idempotency operation ID.
3. Validate the resulting state and increment its revision.
4. Write to a temporary file `.state.json.<uuid>.tmp` inside `.relay/` (`0600`).
5. `rename()` the temp file over `state.json`.

Because `rename` is atomic on the same filesystem, an interrupted process leaves either the
old complete file or the new complete file — never a truncated one. This is the property the
lifecycle test suite exercises.

`readState()` reads and Zod-parses the file; a corrupted or hand-broken `state.json` fails
loudly rather than loading partial data.

## The activity feed

Relay writes one atomically replaced, cross-project activity snapshot to
`~/Library/Application Support/Rirei/activity.json` on macOS. `RIREI_DATA_HOME` overrides the
directory for tests and controlled deployments.

```json
{
  "schemaVersion": 1,
  "instanceId": "...",
  "updatedAt": "2026-07-12T00:00:00.000Z",
  "sessions": []
}
```

The validated `sessions` array aggregates active terminal-owned runs from registered projects
and retains completed, cancelled, or failed terminal sessions for 30 seconds. Statuses and
messages use a fixed Rirei vocabulary. Session counts and every public string are bounded.

The public snapshot never contains prompts, commands, responses, transcripts, terminal output,
diffs, credentials, provider session IDs, models, effort settings, worktree paths, or project
paths. Optional `activity.privacyMode` in `.relay/config.json` replaces project, task, and branch
labels with generic values.

Publication uses a separate global writer lock, mode `0700` parent directory, mode `0600`
files, and unique temporary-file replacement. It is a derivative projection: an activity I/O
failure cannot roll back or invalidate authoritative Relay state.

## Migrations and recovery

- If `state.json` is corrupted, each checkpoint directory has its own `metadata.json` snapshot.
- Ordered migrations upgrade v1 to v2 (revision/idempotency) and v2 to v3 (explicit run leases).
- The pre-migration state is backed up under `.relay/backups/` before the upgraded state is
  written.
- A state file newer than this build supports is rejected with an upgrade message rather than
  opened or downgraded.
- Persistent state versions, activity schema versions, and JSON frontend contracts are separate
  version namespaces.
