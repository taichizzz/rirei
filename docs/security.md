# Security and safety boundaries

Rirei is a same-user local orchestration tool. It constrains its control-plane requests and
generated data, but it is **not an operating-system sandbox for a provider, shell, or repository**.
This page describes the security boundaries in the current source, including the experimental
continuity feature in the alpha.5.5 CLI.

## Authority model

| Surface                                             | Authority                                                       | Limitation                                                                                    |
| --------------------------------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Installed provider CLI                              | Own account, model execution, billing, permissions              | Rirei does not validate every installed binary or isolate its filesystem access               |
| Task state and writer lock                          | Primary worktree's cooperative task/run state                   | A same-user process can still edit files outside the CLI contracts                            |
| Daemon reconnect capability                         | Authenticated local terminal-control client                     | Private descriptor possession is not a provider-account credential or multiuser sandbox       |
| Terminal lifecycle capability                       | One terminal's working/wait state reports                       | Cannot submit permission decisions or use another terminal's lifecycle channel                |
| Message capability                                  | Current task/run/terminal actor through supported messaging CLI | Removing process markers does not create an OS isolation boundary from the same-user operator |
| Capture grant (prototype)                           | Task/run/provider/workspace/session and current consent epoch   | Does not prove every provider event was delivered or authenticate human authorship            |
| Source/receipt hash or retrieval cursor (prototype) | Content/continuation consistency                                | Not authenticated origin, a secret permission token, or hermetic verification                 |

For implementation detail, see [architecture decisions](architecture-decisions.md),
[runtime protocols](runtime-protocols.md), and [continuity architecture](continuity-architecture.md).

## Provider authentication and permissions

Each official CLI owns its authentication, billing, limits, model availability, and permission
UI. Rirei does not read/copy provider credential files, extract OAuth tokens, reuse one provider's
subscription as another provider's API key, or bypass quotas. A new provider launch is explicit;
an exit/usage-limit handoff suggestion does not automatically switch providers.

Authentication discovery uses bounded official status commands where supported. Claude can
report authenticated through CLI JSON, Codex through its status output, and OpenCode can report
configured provider scopes. “Configured” does not establish remote token validity; unavailable
evidence remains unknown/unsupported/error. The older blanket statement that authentication
always returns unknown is not the current adapter contract. See [agents](agents.md).

Passive lifecycle supervisors use separate ephemeral local capabilities: daemon terminal tokens,
Codex's loopback WebSocket token, and OpenCode's loopback server password. They are not provider
account tokens and are not put in task/activity/history projections. They report waits only.
The [external permission-decision channel](approval-protocol.md) remains inactive: no transport
listener or provider permission-reply path is activated by the validated protocol/store code.

## Git operations and workspace ownership

There are two kinds of intentional metadata/workspace mutation:

1. `init` and stateful compatibility setup add one `/.relay/` line to the repository-local
   `info/exclude`, preserving its existing content. This never edits tracked `.gitignore`.
2. Explicit workspace creation previews and runs `git worktree add -b` for an additive managed
   branch/worktree, then registers it under the task's repository authority.

Inspection commands query Git; cleanup inspection prints commands instead of removing anything.
Rirei product commands do not commit, push, merge, reset, rebase, clean, force-checkout, discard
changes, or automatically delete worktrees/branches. Partial workspace creation is reported,
not silently rolled back through deletion. Test/benchmark fixtures create temporary repositories
and commits as a separate evaluator behavior.

“Read-only Git inspection” describes the logical operation, not a universal promise that Git
never refreshes its own internal stat/index cache. The stronger prototype scanner explicitly
suppresses optional Git locks and ignores inherited repository-routing variables. Legacy snapshot
and checkpoint fingerprints keep their older, weaker interpretation.

One managed writing lease per worktree is a scheduling rule. Other shells/editors can change
the files, worktree separation does not isolate credentials/processes, and workspace roles are
not OS access controls. Age alone never establishes authoritative state-lock/controller death;
reconciliation uses the qualified local evidence described in [runtime protocols](runtime-protocols.md).

## Path checks and local files

`relayPath()` lexically confines project-owned record paths to `.relay/`, rejecting `..` escapes.
It does **not** canonicalize the complete filesystem namespace or itself reject symlinks. Context,
Threads, message capabilities, checkpoint readers, daemon descriptors and source readers perform
additional path/file-type/no-follow checks appropriate to their contracts. Do not generalize one
reader's checks to every read/write helper.

Global activity, terminal descriptors/journals, managed worktrees, quota samples, analytics, and
benchmarks live outside the project `.relay/` namespace. Their own resolvers/validators apply.
Platform application support, legacy worktree roots, and Electron userData are not yet fully
unified. [Architecture](architecture.md#authorities-storage-and-derived-views) documents actual roots.

Generated directories/files request private modes such as `0700`/`0600` on POSIX. POSIX mode bits
are not a Windows ACL model. Descriptor readers have platform-specific checks. No documentation
claim should turn restrictive creation modes into protection from a malicious same-user process.

State publication uses a validated temporary file and same-filesystem rename. `updateState`/
`replaceState` acquire the authoritative writer lock; the lower-level `writeState` does not.
This is atomic publication, not a universal power-loss durability guarantee. Threads/context
journals and benchmark writers have separate explicit fsync contracts. See [state](state-and-events.md).

## Subprocesses and frontend control

Provider/Git commands use explicit executable/argument arrays instead of interpolating task text
into a generic shell command. Windows wrapper support and argument newline folding are documented
platform transformations. Installed providers and Git retain their normal configured behavior;
argument arrays do not make untrusted executables or repository hooks safe.

Two shell uses are intentional: an ordinary interactive shell tab and `finish --run-tests`'s
operator-configured `tests.command`. Neither is a claim that arbitrary historical tool commands
can be rerun automatically. Provider stdin/stdout is inherited or PTY-hosted; raw terminal bytes
remain in the daemon's ephemeral bounded ring, not a default durable transcript.

Electron uses `contextIsolation`, disabled Node integration and a sandboxed renderer. Preload
exposes named methods; main validates requests and owning renderer/project/terminal relationships.
Writing/resizing requires terminal control, while observing output and explicit takeover have
separate contracts. Only exact terminal-UUID deep links are accepted; paths/commands/queries are
not deep-link execution inputs. See the full [IPC inventory](runtime-protocols.md#9-complete-electron-preload-surface).

## Stored content and redaction

| Store/view                           | Contents and handling                                                                                                                                                                            |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Task records/notes                   | Operator/caller text can contain sensitive material; selected unresolved notes can enter an approved provider prompt                                                                             |
| Checkpoint patch                     | Real local tracked diff, bounded but not redacted by a checkpoint-output pass                                                                                                                    |
| Public activity                      | Bounded sanitized status and optional project/task/branch labels; excludes full command/prompt/source payload fields, paths, terminal output, provider session IDs, model/effort and credentials |
| Private terminal journals            | Project/controller/run lifecycle metadata, including project paths needed for restart discovery; no terminal transcript                                                                          |
| Threads                              | Recognized secrets rejected unless explicit redaction is requested; rendered control/bidi content is escaped and framed as user-level data                                                       |
| Continuity journal (prototype)       | Allowlisted visible fields, recognized-secret redaction, explicit capture truncation and known gaps                                                                                              |
| Inspection (prototype)               | Bounded display excerpts may be redacted/truncated; hashes still identify the observed source version                                                                                            |
| Exact file windows (prototype)       | Sensitive paths/refused source kinds fail; recognized-secret content is withheld rather than silently altered                                                                                    |
| Verification environment (prototype) | Documented conventional values/presence only; withheld values are not hashed as secret values                                                                                                    |
| Private live benchmark traces        | Explicit experiment artifacts with allowlist/redaction and strict retained-trace validity; review before any publication                                                                         |

`src/safety/redaction.ts` **exists and is used** by messaging/continuity. The missing feature is
a redaction pass over legacy checkpoint patches, not a missing redaction module everywhere.
Recognized-pattern redaction and sensitive-filename detection are finite heuristics, not guarantees
that arbitrary task text, ordinary tracked files, diffs, logs, or user-selected artifacts contain
no secrets. Treat private records according to what they actually contain.

Public task labels derive from the task title and can repeat the first line of a task. The
absence of a full prompt field is not a guarantee of zero task-derived text; `activity.privacyMode`
selects generic public labels.

## Token analytics and quota isolation

Provider plan telemetry and token analytics are different paths. Claude's session-only status-line
collector writes sanitized quota values; Codex quota reading uses local numeric rate-limit
records. Unknown/expired data stays explicitly stale/unknown. These observations do not become
an API key, a monetary bill, or model-token telemetry when that source does not expose it.

Numeric quota projection can read bounded chunks of mixed-content provider log files before
selecting supported rate-limit records. Retaining only numeric fields is not a claim that every
raw byte read by the parser was already telemetry-only. This path is separate from continuity's
opt-in hook journal and does not reconstruct provider conversations for handoff.

Machine-wide token analytics requires its own explicit opt-in. Rirei invokes a pinned native
`ccusage` from its own installation, never a binary planted in the opened repository, using:

- offline/no-cost flags, empty-config override, closed stdin and neutral cwd;
- per-agent timeout/output bounds;
- strict numeric normalization, path/username sanitization and privacy assertions before storage;
- timezone-bound cache, per-agent refresh serialization, and last-good snapshot retention.

Rirei requests and retains numeric reports rather than prompts/completions. The external scanner
necessarily has access to provider log files; this architecture does not prove those files are
never parsed in its process memory or that offline flags are OS-enforced network isolation.
No architecture audit here scans private provider logs or credentials to establish that claim.
Background quota polling remains separate and does not automatically invoke token-history scans.

## Experimental continuity disclosure

Task capture consent is independent of analytics. Disable revokes grants and excludes retained
history from automatic handoffs. Clear removes the current task's generated capture artifacts;
task receipts and other authoritative task data are preserved. Explicit operator lookup of
retained evidence after disable follows the existing same-user operator contract.

Submitted text and historical tool/assistant output have different roles. Path-display suppression
does not authorize or enforce filesystem isolation. A source hash, matching snapshot, receipt,
or cursor establishes only its declared observation relationship. Current environment/ignored
input gaps are explicit, no CLI creates trusted automatic test reuse, and tests are never
silently skipped. [Continuity architecture](continuity-architecture.md) describes the complete flow.

## Publication boundary

Keep generated `.relay/`, daemon descriptors, global private journals/caches, live workspaces,
and private benchmark artifacts out of ordinary source publication. `.relay/` was tracked in
early history; deleting it in a later tree does not erase earlier commits. Release review and
any history rewrite remain owner actions described in [publication](publication.md).

The package allowlist/private-path checks are useful release checks, not proof that all possible
secrets are absent. Source publication, npm publication, desktop signing/notarization, and native
provider/platform acceptance have separate evidence requirements.
