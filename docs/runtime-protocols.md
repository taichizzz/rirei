# Runtime processes, protocols, and frontend contracts

This document describes the current implementation, not a promise that every desktop/provider
combination has native acceptance. It provides the mechanical detail behind ADR-002 and
ADR-008–024 in the [decision record](architecture-decisions.md).

## 1. Processes and ownership

```text
Electron renderer                         Ink dashboard / relay attach
  isolated DOM, xterm                      raw terminal passthrough
        | preload IPC                               |
Electron main                              TypeScript daemon client
        | authenticated daemon client               |
        +---------------------+---------------------+
                              |
                    detached terminal daemon
                    PTY ring, control, lifecycle
                              |
                    native node-pty / parent guard
                              |
                    relay run/switch/resume controller
                    task lease + ProcessHost
                              |
                    installed official provider CLI
```

The controller's provider uses inherited I/O inside that PTY. Native provider TUI rendering is
not parsed into a transcript or replaced by a plain output pane. A shell tab instead launches
the selected login shell without a task lease/initialization requirement. Capacity and daemon
claims still apply to its terminal; neither claims nor leases block arbitrary external edits.

The ESM daemon uses `desktop/terminal-host.mjs`. A typed factory also exists under
`src/terminal/`; both use `node-pty`. `desktop/terminal-manager.mjs` retains an independently
tested in-memory helper but is not the PTY owner used by the current Electron main process.

## 2. Discovery and storage roots

CLI/TUI discovery uses `src/platform/daemon-manager.ts`: a descriptor under the platform runtime
root and an endpoint derived from that root's hash. POSIX sockets live in a short private temporary
directory; Windows uses a named pipe. The descriptor basename remains `terminal-daemon-v1.json`
while the current wire protocol is **2**; descriptor and wire versions are different namespaces.

On POSIX, descriptor checks require a regular non-symlink file with matching owner where known
and no group/other permission bits. Windows file checks do not pretend POSIX mode bits are ACLs.
A live endpoint with an invalid/incompatible descriptor is an error, not permission to remove
it. Stale cleanup only occurs after liveness checks. `locateDaemon` never starts one;
`ensureDaemon` can explicitly spawn a detached CLI daemon.

Electron's `daemonRuntimePaths()` separately uses `app.getPath('userData')` and a POSIX-style
temporary endpoint. It must not be described as automatically identical to the CLI resolver on
every platform. Provider executable search also differs: Electron augments common user/Homebrew
paths; the CLI follows its launch environment. See the [audit's compatibility debt](architecture-audit.md#remaining-implementation-and-qualification-gaps).

**Sources:** `src/platform/terminal-endpoint.ts`, `daemon-manager.ts`, `desktop/main.mjs`,
`desktop/terminal-daemon-client.mjs`. These discovery checks are local process/file evidence,
not remote authentication or an OS sandbox.

## 3. Daemon framing and authentication

Transport is newline-delimited UTF-8 JSON over a local socket/pipe. `DaemonFrameDecoder` retains
partial bytes, decodes complete lines with fatal UTF-8, rejects unsupported `v`, and limits both
a complete line and an unterminated buffered tail to **128 KiB**. Terminal byte payloads use
base64 so ANSI/control content cannot become JSON protocol framing.

Conceptual request/response shapes (tokens and IDs below are placeholders):

```json
{"v":2,"type":"hello","token":"<private reconnect capability>"}
{"v":2,"type":"request","id":"1","op":"attach","body":{"terminalId":"<uuid>","cursor":0}}
{"v":2,"type":"response","id":"1","ok":true,"body":{"data":"<base64>","startCursor":0,"endCursor":64,"nextCursor":64}}
```

A new daemon generates a random 256-bit reconnect capability and writes a private descriptor.
An unauthenticated connection has **2 seconds** to send the correct hello. A provider lifecycle
hook instead sends `lifecycle_hello` with its terminal UUID and separate per-terminal token.
That connection receives only `set_lifecycle` and cannot request another terminal/operation.

Normal request IDs correlate pending responses; the client has a default **10-second request
timeout**. Connection failure rejects pending requests, and reconnect refreshes descriptor,
inventory and control state. A descriptor possession check is not a substitute for frontend
ownership validation. No provider OAuth/API credential is used for these local capabilities.

## 4. Daemon operation families

| Operations                           | Contract                                                                                              |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `list`, `inspect`                    | Return daemon terminal metadata, including sequence, cursors, runtime and bridge/result state         |
| `start`                              | Validate a supported launch body; reserve a startup claim before asynchronous PTY creation            |
| `attach`, `detach`                   | Observe bounded output from a cursor; detach also releases that connection's write control            |
| `acquire_control`, `release_control` | One connection owns input/resize; explicit `takeover` revokes and notifies its predecessor            |
| `write`                              | Requires attachment and current control; validates base64 and at most 64 KiB decoded input            |
| `resize`                             | Requires current control; dimensions are bounded integers                                             |
| `interrupt`, `stop`, `stop_all`      | Explicit process-control operations; stop uses bounded escalation, not a provider permission decision |
| `set_waiting`, `set_lifecycle`       | Normalize attention/working state; ignore stale transitions that would revive stopping/finalized work |
| `set_hidden`                         | Presentation visibility only; hiding does not stop the provider                                       |
| `forget`                             | Remove a finalized terminal; active terminals cannot be forgotten                                     |
| `watch_threads`, `notify_threads`    | Project-audience metadata fanout; no message body or provider injection                               |

There are **four active terminals** maximum, including in-progress starts. A finalized terminal
can remain in the map until forgotten; the active limit is not a global lifetime-terminal or
total-memory bound. The ring is bounded per terminal. General connection/event socket queues
are not a formally bounded, denial-of-service-proof transport: `safeWrite` handles failures but
does not turn every outgoing write into a drain-aware queue.

Request validation rejects unexpected start fields and incompatible kinds/providers/flags.
These checks constrain the control plane, not what an authorized provider or shell can do with
the same user's filesystem permissions. Other authenticated operations do not all require the
write-control ownership used specifically for `write`/`resize`.

## 5. Output cursors and rendering acknowledgement

Every emitted byte advances `nextCursor`; eviction advances `oldestCursor`. `attach(cursor)`
returns at most **64 KiB** and reports actual start/end, latest available cursor, and truncation
when the requested history has already been evicted from the **2 MiB** ring. Old data is not
reconstructed from disk. Metadata events signal availability; they do not push an unlimited
transcript into every renderer.

Electron main maintains a delivery record for each renderer/terminal. It sends one in-flight
slice through `relay:terminal-data`. The renderer decodes/writes it through xterm and acknowledges
the expected end cursor. Main rejects mismatched acknowledgements and advances only that
delivery. An exit event waits behind outstanding output so a view does not dispose its terminal
before the last available slice.

The TUI's `attachTerminalSession` has a serialized pull loop and its own cursor. It installs
raw input only after replay/control setup, handles output-available/exit races, restores raw/
paused stream state on every cleanup path, and releases/detaches without killing the session.
`Ctrl+Q`, `Ctrl+B` then `D`, and `Ctrl+]` are detach controls. Read-only attach does not acquire
input/resize ownership; takeover is explicit.

These cursors count bytes. They are unrelated to continuity's UTF-16 evidence cursors or provider
conversation resume IDs. A renderer acknowledgement is not persistent output storage, a test
result, or proof that a provider/model consumed the data.

## 6. PTY backend and stopping

`createTerminalHost()` normally starts native `node-pty`, with ConPTY on Windows. The desktop
host can wrap the relay controller in a Node parent guard. The guard's readiness marker is
removed from visible output, parent death is monitored, and stop escalates through descendants.
The default server stop escalation requests interruption, then termination after roughly two
seconds and a force tree kill after roughly four seconds. Exact native behavior remains
platform-dependent. Natural ConPTY exit closes native resources to release worker handles.

`pty_bridge.py` implements a separate legacy protocol with PTY output, fd-3 control, and fd-4
bridge readiness/status. The daemon takes this branch only when internally passed
`forcePythonBridge` and a bridge path. Ordinary CLI/Electron launches do not automatically switch
to Python when native loading fails. The helper remains packaged/tested for compatibility.

Windows inherited-provider arguments fold newlines to spaces in `InheritedProcessHost`.
The capture grant uses that same argument form to identify the opening handoff if it is echoed
by a provider hook. Subsequent submitted messages follow the ordinary capture rules.
This is a platform launch transformation, not proof of byte-identical cross-platform prompts.
Native Windows terminal/provider continuity acceptance remains a separate qualification from
the release tarball/native dependency smoke matrix.

## 7. Lifecycle, active runtime, and state synchronization

Provider state and terminal process state are distinct. Structured integrations publish only:

- `working`;
- `needs_permission`;
- `waiting_for_input`.

Claude uses official session-local lifecycle hooks. Codex starts an authenticated loopback
app-server and native remote TUI, with a second passive status connection. OpenCode starts a
random-password loopback server, observes SSE, and reconciles bounded pending state with GET
requests. None of these paths answers permission/question requests. Unsupported providers can
use conservative output-attention hints; spoofable output is never approval authority.

The daemon's monotonic runtime accumulates while starting/running, freezes while waiting, and
uses a monotonic sequence to reject older observations in task projections. It is not the
renderer duration computed from start/end wall-clock timestamps.

The reusable `DaemonBridgeWorker` runs `relay bridge --worker`. Its version-1 newline protocol
bounds frames to **128 KiB**, pending requests to **64**, and request time to **5 seconds**.
Invalid/oversized/missing responses reject pending work and restart the worker on a later request.
A per-terminal daemon queue coalesces pending updates with final > transition > heartbeat
priority. Five-second heartbeats do not each require a fresh CLI startup.

Finalization is idempotent. It consults the matching provider result when available, otherwise
uses a conservative bridge fallback; marks state synchronization pending; retries final sync;
and exposes `cleanupPending`/`state_sync_failed` when persistence did not finish. An observed
PTY exit must not automatically be equated with successful task completion.

## 8. Recovery evidence

| Evidence                                                                                       | Result                                                           |
| ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Complete current daemon inventory contains a terminal                                          | Adopt its lease under that daemon identity and refresh ownership |
| Complete inventory lacks it; same-host prior boot is established                               | Candidate for interrupted/cancelled finalization                 |
| Complete inventory lacks it; required current controller and bridge PIDs are conclusively gone | Candidate for finalization                                       |
| Inventory lacks it but death is not established                                                | Mark orphaned and retain the claim                               |
| No inventory; controller is current-host/current-boot and PID exists                           | Report live local evidence                                       |
| No inventory; local controller PID is gone                                                     | Mark orphaned, retain claim until appropriate recovery           |
| No inventory; host/boot/PID cannot be qualified                                                | `needs_attention`; do not infer death from an old heartbeat      |

Boot identity is a host/approximate boot-minute marker plus independent instance UUIDs, not a
privileged kernel attestation. PID reuse can conservatively leave a lease blocked. Force recovery
is an explicit operator action and cannot prove an outside provider process has stopped.

Private terminal-journal discovery bounds file/project scans and checks filename/path hashes,
regular files, sizes and schemas. Journals contain project paths needed for rediscovery; they
must not be confused with the path-stripped public activity feed.

## 9. Complete Electron preload surface

This table inventories `desktop/preload.cjs`; main-process validation, not preload naming,
determines accepted payloads and owning renderer/project/terminal relationships. An `invoke`
returns a result; `send` is an event; subscriptions return an unsubscribe function.

| Method                      | Channel                     | Direction                              |
| --------------------------- | --------------------------- | -------------------------------------- |
| `selectProject`             | `relay:select-project`      | invoke                                 |
| `validateProject`           | `relay:validate-project`    | invoke                                 |
| `setActiveProject`          | `relay:set-active-project`  | send                                   |
| `command`                   | `relay:command`             | invoke, validated task-command surface |
| `dashboard`                 | `relay:dashboard`           | invoke                                 |
| `history`                   | `relay:history`             | invoke                                 |
| `checkpoints`               | `relay:checkpoints`         | invoke                                 |
| `checkpointDiff`            | `relay:checkpoint-diff`     | invoke                                 |
| `agentCatalog`              | `relay:agent-catalog`       | invoke                                 |
| `usage`                     | `relay:usage`               | invoke                                 |
| `usageTokens`               | `relay:usage-tokens`        | invoke                                 |
| `usageOptIn`                | `relay:usage-opt-in`        | invoke                                 |
| `setUsageOptIn`             | `relay:usage-set-opt-in`    | invoke                                 |
| `activity`                  | `relay:activity`            | invoke                                 |
| `interactive`               | `relay:interactive`         | invoke                                 |
| `openShell`                 | `relay:shell`               | invoke                                 |
| `workspaceList`             | `relay:workspace-list`      | invoke                                 |
| `workspaceCreate`           | `relay:workspace-create`    | invoke                                 |
| `terminalInput`             | `relay:terminal-input`      | send                                   |
| `terminalAttention`         | `relay:terminal-attention`  | send                                   |
| `resizeTerminal`            | `relay:terminal-resize`     | send                                   |
| `stopTerminal`              | `relay:terminal-stop`       | invoke                                 |
| `stopAllTerminals`          | `relay:terminal-stop-all`   | invoke                                 |
| `interruptTerminal`         | `relay:terminal-interrupt`  | invoke                                 |
| `closeTerminal`             | `relay:terminal-close`      | invoke                                 |
| `hideTerminal`              | `relay:terminal-hide`       | invoke                                 |
| `showTerminalTab`           | `relay:terminal-show`       | invoke                                 |
| `acknowledgeTerminalOutput` | `relay:terminal-output-ack` | send                                   |
| `terminalInventory`         | `relay:terminal-inventory`  | invoke                                 |
| `rendererReady`             | `relay:renderer-ready`      | send                                   |
| `onTerminalData`            | `relay:terminal-data`       | receive                                |
| `onTerminalStatus`          | `relay:terminal-status`     | receive                                |
| `onTerminalExit`            | `relay:terminal-exit`       | receive                                |
| `onTerminalControl`         | `relay:terminal-control`    | receive                                |
| `onUsageUpdate`             | `relay:usage-update`        | receive                                |
| `onDeepLink`                | `relay:deep-link`           | receive                                |
| `onThreadsChanged`          | `relay:threads-changed`     | receive                                |
| `threads`                   | `relay:threads`             | invoke                                 |
| `thread`                    | `relay:thread`              | invoke                                 |
| `sendMessage`               | `relay:send-message`        | invoke                                 |
| `replyMessage`              | `relay:reply-message`       | invoke                                 |
| `markMessageRead`           | `relay:mark-message-read`   | invoke                                 |
| `acknowledgeMessage`        | `relay:acknowledge-message` | invoke                                 |
| `renameSession`             | `relay:rename-session`      | invoke                                 |

Electron uses context isolation, disabled Node integration and renderer sandboxing. Local xterm
assets satisfy CSP; navigation and new windows are refused. A terminal deep link accepts only
`rirei://terminal/<valid-uuid>`, with no path/command/query/fragment. The bounded intent queue
bridges cold start/reload and focuses an existing owner, not arbitrary execution.

`LatestRequestGate` tickets bind revision and UI scope so old catalog/usage/history responses
cannot replace a newer selection. Provider model/effort preferences live in localStorage;
task/run state and daemon inventory remain authoritative. M5 handoff rendering profiles are a
different concept from these session preferences.

## 10. Public and private outputs

CLI success contracts differ by command and version. The top-level error handler emits a JSON
error envelope only when the argv contains `--json`; selecting `--format json` for a bounded
retrieval response does not itself change the global error format. Single retrieval failures
throw and use exit 1; generated batches can have per-item errors with a successful process exit.

Activity is a sanitized read-only projection. Terminal RPC metadata includes project paths and
bridge information for local control and is not that public projection. Message bodies, raw PTY
bytes, continuity sources, and permission-request details do not automatically enter activity or
metadata-only Threads notifications. Explicit opt-in continuity and explicit private benchmark
tracing have different retention contracts.

See [security](security.md), [state and events](state-and-events.md), and
[continuity architecture](continuity-architecture.md) for exact storage/privacy limits.
