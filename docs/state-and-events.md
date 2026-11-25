# State and events

Relay's structured memory is `.relay/state.json`, validated by the Zod schema in
`src/state/schema.ts`. An atomic, bounded activity snapshot in Rirei's application-support
directory provides sanitized session status for external UIs.

## `RelayState` schema

```ts
interface RelayState {
  schemaVersion: 8;
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
  verificationReceipts?: VerificationReceipt[]; // at most 64
  checkpoints: CheckpointRecord[];
  blockers: BlockerRecord[];
  notes: HandoffNote[];
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
  verificationReceiptId?: string; // linked host-command observation
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
  exitReason?: AgentExitReason; // validated mirror of exitClassification.reason
  exitClassification?: {
    reason: AgentExitReason;
    confidence: 'low' | 'medium' | 'high';
    source:
      | 'user_intent'
      | 'spawn'
      | 'provider_event'
      | 'provider_exit_code'
      | 'signal'
      | 'fallback';
    providerCode?: string;
    retryAt?: string;
  };
  providerObservations?: Array<{
    kind:
      | 'provider_error'
      | 'rate_limit'
      | 'usage_limit'
      | 'authentication'
      | 'network';
    detail?: SanitizedProviderCode;
  }>;
  launchMode?: 'new' | 'resume' | 'fork';
  providerSessionId?: string;
  terminalId?: string;
  workspaceId?: string;
  branchLabel?: string;
  role?: 'implement' | 'review' | 'verify' | 'investigate';
  lifecycleStatus?: RunLifecycleStatus;
  attentionKind?: 'permission' | 'input' | 'unknown';
  activeRuntimeSeconds?: number;
  runtimeSequence?: number;
};

type HandoffNote = {
  id: string;
  type: 'done' | 'next' | 'decision' | 'rejected' | 'blocker' | 'question';
  text: string;
  reason?: string;
  createdAt: string;
  resolvedAt?: string;
  provenance: {
    source: 'user' | 'agent';
    agent?: string;
    recordedBy: 'relay-cli';
  };
  git: { commit: string; branch: string; fingerprint: string };
};
```

`RunLease` records one active provider's run, controller, provider, selected worktree, launch
mode, timestamps, and status. The authoritative concurrency invariant is at most one writing
lease per working tree. Several agents may run concurrently only when they own different
worktrees.

Every schema-v8 lease also carries a normalized `lifecycleStatus`, optional `attentionKind`,
daemon-owned `activeRuntimeSeconds`, and monotonic `runtimeSequence`. Runtime advances only
while the terminal is starting or the provider is working. Permission and input waits freeze
the clock. An update with an older sequence is ignored, and runtime never decreases.

The lease carries the **structured personality identity** (`controller`) of the process that
owns the provider run, alongside the canonical string `controllerId`
(`${kind}:${bootId}:${instanceId}`):

```ts
type ControllerIdentity = {
  kind: 'cli' | 'desktop' | 'daemon';
  instanceId: string; // uuid, or the terminalId for desktop-owned runs
  pid?: number;
  bootId: string; // host-qualified boot identity
};
type OrphanBid = {
  controllerId: string;
  priority: number; // non-negative
  at: string; // ISO 8601
};
```

A pid alone is meaningless — the same pid can be reused after a reboot or exist on another
machine — so the boot-qualified instance identity is the ownership key. When a run is orphaned,
controllers that want to claim it submit a deterministic **orphan bid** (`submitOrphanBid`,
bounded to the 8 newest bids). The winner is the highest priority, then the earliest
timestamp, then the lexicographically smallest id, so any number of contenders converge on the
same owner without a coordinator. The CLI claims orphaned runs with priority 1 before invoking
recovery.

Agent runs are appended in launch order and form the durable source for Rirei's session
timeline. `model` and `effort` record only overrides Relay actually passed to the provider.
Their absence means **Auto** (the provider chose its default); it does not claim which model
the provider ultimately resolved. Both fields are optional so existing schema-version-1
state files and older run records continue to validate without migration.

Closed runs persist a structured `exitClassification` (reason, confidence, evidence source,
provider code) in addition to the legacy `exitReason` string so recovery and UI can tell a
verified outcome from a best-effort guess. Recovered or task-closed runs are classified as
`interrupted` at medium confidence from a fallback source.

Every field is validated on read. Timestamps are ISO-8601 strings; `datetime()` validation
means a malformed timestamp is rejected.

When an agent exits, Relay re-reads the newest state and updates only the matching run ID.
This preserves checkpoints, tests, and task-status changes written while the agent was active.

## Verification receipts (M2)

`verificationReceipts` is an optional schema-v8 field. Each schema-v1 `VerificationReceipt`
binds task/receipt IDs, a bounded redacted command, working directory, configured-test scope,
pending/completed/interrupted status, observed exit/times/duration, start/end covered-input
and partial environment identities, `output: not-captured`, and a canonical integrity hash.
`src/context/verification-schema.ts` defines the exact validated shape.

`finish --run-tests` persists the pending receipt before launch, then links the observed result
from `tests[].verificationReceiptId`. At most 64 receipts are retained; older nonpending
receipts are pruned first. Pending receipts are never silently discarded. Legacy migrations
leave missing receipt metadata absent, so old results remain historical. Hashes detect
content changes without authenticating authorship.

Read current freshness with `relay context verification`, or include one complete retained
receipt using `--receipt <id>`. Matching file boundaries do not qualify installed dependencies,
external services, ignored/generated inputs, or the full environment. The current CLI never
automatically skips tests. See [M2 milestone notes](handoff-efficiency-m2.md).

## Which fields are populated today

- **Set automatically:** `revision`, `recentOperations`, `sessionId`, `projectRoot`,
  `task.title/originalRequest/status/createdAt/updatedAt`, the full `git` baseline, `runs`,
  compatibility mirrors, `agentHistory`, `tests`
  (via `finish --run-tests`), `checkpoints`, and notes submitted through `relay note`.
  The CLI also populates optional `verificationReceipts` and links
  each host-command observation from its `TestResult`.
- **Present but not yet populated by any command:** `task.requirements`, `task.constraints`,
  `decisions`, `completedWork`, `remainingWork`, and `blockers`. They are initialized to
  empty arrays and are surfaced by `status` (as counts) and by the handoff. Populating them
  is where structured progress-tracking will plug in; until then they stay empty unless
  state is edited directly.

## Atomic writes

`updateState()`/`replaceState()` (`src/state/store.ts`) are the locked application mutation paths:

1. Acquire the repository-scoped writer lock.
2. Validate the expected revision and optional idempotency operation ID.
3. Validate the resulting state and increment its revision.
4. Write to a temporary file `.state.json.<uuid>.tmp` inside `.relay/` (`0600`).
5. `rename()` the temp file over `state.json`.

Because `rename` is atomic on the same filesystem, an interrupted process leaves either the
old complete file or the new complete file rather than intentionally publishing a half-written
JSON body. This is atomic visibility, not a power-loss durability guarantee: this state writer
does not explicitly fsync file/directory. The lower-level `writeState()` validates and publishes
but does not itself acquire a lock, enforce an expected revision, or increment revision; callers
that mutate authoritative state must use the locked services.

Threads/context journal and benchmark writes have separate explicit fsync contracts. Checkpoint
files, archive creation, current-state publication and global activity are not one multi-file
transaction. A failure can leave an unreferenced artifact or a stale derived view. See
[ADR-004–005](architecture-decisions.md) and the [audit](architecture-audit.md).

`readState()` reads and Zod-parses the file; a corrupted or hand-broken `state.json` fails
loudly rather than loading partial data.

## The activity feed

Relay writes one atomically replaced, cross-project activity snapshot to
`~/Library/Application Support/Rirei/activity.json` on macOS. `RIREI_DATA_HOME` overrides the
directory for tests and controlled deployments.

```json
{
  "schemaVersion": 3,
  "instanceId": "...",
  "updatedAt": "2026-07-12T00:00:00.000Z",
  "sessions": []
}
```

The validated `sessions` array aggregates active terminal-owned runs from registered projects
and retains completed, cancelled, or failed terminal sessions for 30 seconds. Statuses and
messages use a fixed Rirei vocabulary. Session counts and every public string are bounded.
Schema v2 added `activeRuntimeSeconds`. Schema v3 adds the normalized `lifecycleState` and
optional `attentionKind` (`permission`, `input`, or `unknown`). Runtime comes directly from the
terminal daemon rather than being reconstructed from timestamps, so notch consumers do not
guess whether an agent was working or waiting.

The public schema excludes full prompt/command/response/transcript/terminal-output/diff payload
fields, credentials, provider session IDs, models/effort and filesystem paths. It does permit
bounded sanitized project/task/branch labels. The task label derives from the task title, so it
can overlap the first line of a submitted task; this is not a guarantee of zero task-derived text.
Optional `activity.privacyMode` replaces those labels with generic values.

Publication uses a separate global writer lock, mode `0700` parent directory, mode `0600`
files, and unique temporary-file replacement. It is a derivative projection: an activity I/O
failure cannot roll back or invalidate authoritative Relay state.

## Migrations and recovery

- If `state.json` is corrupted, each checkpoint directory has its own `metadata.json` snapshot.
- Ordered migrations upgrade v1 to v2 (revision/idempotency), v2 to v3 (explicit run leases),
  v3 to v4 (provenance-aware handoff notes), v4 to v5 (durable structured exit
  classification), v5 to v6 (structured controller identities), v6 to v7
  (boot-qualified controller and bridge lifecycle evidence), and v7 to v8
  (normalized lifecycle, attention kind, and authoritative runtime). Legacy arrays remain
  intact; migration does not invent authorship or Git anchors for them. The v4 to v5
  migration derives a best-effort `exitClassification` from the existing
  `exitReason`/`exitCode` fields and marks it fallback-sourced. The v5 to v6 migration
  derives `controller` from the existing `controllerId` string. The v6 to v7 migration adds
  an instance ID, boot identity, canonical owner key, and lifecycle status. Because old
  timestamps cannot distinguish work from permission waits, v7 to v8 initializes runtime at
  zero instead of inventing elapsed work.
- The pre-migration state is backed up under `.relay/backups/` before the upgraded state is
  written.
- A state file newer than this build supports is rejected with an upgrade message rather than
  opened or downgraded.
- Persistent state versions, activity schema versions, and JSON frontend contracts are separate
  version namespaces.

## Controller heartbeat and orphaning

Terminal-owning hosts (and the CLI's managed runs) prove they are alive by stamping the
`lastSeenAt` of every lease they own on a heartbeat interval (5 s). Time expiry alone never
orphans or releases a worktree. `relay reconcile` compares same-boot local controller evidence.
When Electron supplies a complete daemon inventory, listed terminal leases are adopted by that
daemon and absent terminal leases are conclusively orphaned, including when the inventory is
empty. Otherwise, a lease is orphaned only when its recorded PID is conclusively gone;
different-boot, remote, or otherwise unverifiable leases remain blocked as `needs_attention`. On graceful
shutdown a controller can call `orphanOwned()` so its
leases become `orphaned` (`reason: 'controller_disconnected'`) instead of silently `running`.
This is what lets a different controller pick up a run whose owner crashed without a
coordinator. A stale stamp is only a loss of recent heartbeat evidence; it is not proof of death.
With complete inventory, same-host prior-boot evidence can also qualify terminal finalization.
Without it, host/boot ambiguity remains `needs_attention`. The precise matrix is in
[runtime recovery evidence](runtime-protocols.md#8-recovery-evidence).

## Terminal journal

Terminal lifecycle events are appended to a bounded, durable project-keyed journal under
Rirei's application-support directory (`src/state/journal.ts`,
`desktop/terminal-journal.mjs`):

```json
{
  "schemaVersion": 1,
  "entries": [
    {
      "at": "…",
      "terminalId": "terminal-1",
      "event": "created",
      "projectRoot": "/path/to/project",
      "controllerInstanceId": "controller-1",
      "createdAt": "…",
      "lastActivityAt": "…",
      "expectedStatus": "starting",
      "detail": "claude"
    }
  ]
}
```

At desktop startup, Rirei scans at most 512 bounded journal files and reconciles the 64 most
recent valid projects. Each recovered path must match the hash in its journal filename; damaged,
oversized, symlinked, or mismatched journals are ignored.

Events are `created | attached | status | resized | interrupted | stopped | closed | exit |
recovered`. The journal keeps the 500 newest entries, is written atomically (0600, temp-file
rename). It stores **private project/controller metadata including `projectRoot` paths**, but no
terminal transcript, prompt payload, or provider credentials. It lets a restarted frontend find
projects to reconcile without trusting renderer state; it is not the sanitized public activity file.

Terminal-journal locking is a separate age-reclaimed mechanism; the authoritative state lock's
dead-owner policy must not be generalized to it. `appendEvent()` is also separate: it ignores
legacy event names/payloads and republishes activity from current validated state, rather than
persisting an `events.jsonl` event-sourcing log.
