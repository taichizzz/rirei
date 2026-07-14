# State and events

Relay's structured memory is `.relay/state.json`, validated by the Zod schema in
`src/state/schema.ts`. A parallel append-only log, `.relay/events.jsonl`, records what
happened and when.

## `RelayState` schema

```ts
interface RelayState {
  schemaVersion: 1;
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

  currentAgent?: string; // set while an agent is running, cleared after
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
  id?: string; // stable ID on new records; optional for schema-v1 compatibility
  agent: string;
  model?: string; // explicit session override; absent means provider default
  effort?: string; // explicit session override; absent means provider default
  startedAt: string;
  endedAt?: string;
  exitCode?: number | null;
  exitReason?: string;
};
```

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

- **Set automatically:** `sessionId`, `projectRoot`, `task.title/originalRequest/status/
createdAt/updatedAt`, the full `git` baseline, `currentAgent`, `agentHistory`, `tests`
  (via `finish --run-tests`), and `checkpoints`.
- **Present but not yet populated by any command:** `task.requirements`, `task.constraints`,
  `decisions`, `completedWork`, `remainingWork`, and `blockers`. They are initialized to
  empty arrays and are surfaced by `status` (as counts) and by the handoff. Populating them
  is where structured progress-tracking will plug in; until then they stay empty unless
  state is edited directly.

## Atomic writes

`writeState()` (`src/state/store.ts`) never writes `state.json` in place:

1. Validate the state against the schema.
2. Write to a temporary file `.state.json.<uuid>.tmp` inside `.relay/` (`0600`).
3. `rename()` the temp file over `state.json`.

Because `rename` is atomic on the same filesystem, an interrupted process leaves either the
old complete file or the new complete file — never a truncated one. This is the property the
lifecycle test suite exercises.

`readState()` reads and Zod-parses the file; a corrupted or hand-broken `state.json` fails
loudly rather than loading partial data.

## The event log

`appendEvent(root, type, data)` (`src/state/events.ts`) appends one JSON object per line to
`.relay/events.jsonl`:

```json
{
  "type": "task_started",
  "at": "2026-07-12T00:00:00.000Z",
  "data": { "sessionId": "…", "task": "…", "dirtyAtStart": false }
}
```

Event types emitted today:

| Event                | Emitted by                                                          |
| -------------------- | ------------------------------------------------------------------- |
| `task_started`       | `relay start`                                                       |
| `checkpoint_created` | `createCheckpoint` (via `checkpoint`, `switch`, `finish`)           |
| `agent_started`      | `launchAgent`, with run ID, agent, and model/effort overrides       |
| `agent_ended`        | `launchAgent`, with run ID, agent, exit code, and classified reason |
| `task_completed`     | `relay finish`                                                      |

The log is append-only and intended for debugging, auditability, and reconstructing what
happened. It is safe to git-ignore.

`agent_started` writes `model: null` and `effort: null` when Auto was selected. Both the
start and end events share the run ID stored on `AgentRunRecord`, allowing event consumers to
correlate the pair even when the same provider is launched repeatedly.

## Recovery notes

- If `state.json` is corrupted, the event log preserves the sequence of task/agent/checkpoint
  events, and each checkpoint directory has its own `metadata.json` snapshot.
- There is no automatic migration layer yet; `schemaVersion` is fixed at `1`. Treat manual
  edits carefully and re-run a command to confirm the file still validates.
