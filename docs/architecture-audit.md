# Architecture documentation audit

Audit started: **2026-11-11**; validation updated: **2026-11-13**.
Baseline Git commit: `1b71fcddef0cb12179df5a39832049ecd221620b`, with
the then-unreleased M0–M5 changes. The audit preserves that working-copy scope. See the
[alpha.5.5 update notes](release-0.1.0-alpha.5.5.md) for the release scope.

Subsequent qualification update, **2026-11-18**: the E1 result and newly added receiver-runner
coverage are linked below. The static inventory counts and verification date at the end retain
the original 2026-11-13 documentation-pass scope.

## Scope and method

The audit compared maintained docs against the CLI entrypoint, application/state/provider
contracts, active Electron/TUI/daemon paths, persistence helpers, token analytics, continuity
modules, benchmark infrastructure, package build/allowlist and release workflow. It inspected
implementation and relevant test contracts without launching providers, scanning private provider
logs/credentials, installing the desktop app, or changing runtime behavior. Two false source
comments about terminal journals omitting paths were corrected as documentation.

Primary outputs:

- [Architecture](architecture.md): current layers, authorities, storage, four end-to-end flows.
- [42 decision records](architecture-decisions.md): rationale, mechanism, tradeoff and evidence.
- [Runtime protocols](runtime-protocols.md): process/IPC/control/output/recovery mechanics and
  the complete current Electron preload method/channel inventory.
- [Continuity architecture](continuity-architecture.md): the consolidated M0–M5 pipeline,
  identities, source contracts, limits, failure handling and evaluation boundaries.

“Covered” below means a principal contract now has an architectural explanation and evidence
pointer. It does not mean every branch was dynamically exercised by this documentation pass,
every historical intent was recovered, or every current source feature shipped in alpha.5.1.

## Contradictions and missing explanations found

| Finding before the audit                                                                                         | Correction / current explanation                                                                                                      |
| ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Architecture tree omitted context, messages, token analytics, platform/TUI and current daemon boundaries         | Current source map plus ADR-001–042 and the continuity guide                                                                          |
| Architecture claimed all data lived under project `.relay/`                                                      | Separate task authority, platform data, legacy worktree/quota roots, Electron userData and private benchmark roots                    |
| Desktop/development described Python as the active PTY prerequisite                                              | Native `node-pty`/ConPTY is the default; Python is an explicitly forced compatibility/test branch                                     |
| `writeState` was described as acquiring the lock/revision guard itself                                           | `updateState`/`replaceState` own mutation locking; `writeState` only validates/publishes                                              |
| Atomic rename was described too broadly as interruption/durability protection                                    | Atomic visibility is separate from explicit file/directory fsync and from multi-file transactionality                                 |
| A stale heartbeat stamp was called proof the controller was gone                                                 | Evidence-based reconciliation matrix; old timestamps alone do not release authoritative ownership                                     |
| Terminal journals were said to store no paths, despite `projectRoot` in their schema                             | Private path-bearing restart metadata is distinct from public activity; docs and two source comments corrected                        |
| Different lock families were implied to share one stale-owner policy                                             | Authoritative state uses owned dead-PID reclamation; derivative terminal-journal locking has age-based reclamation                    |
| Security described one Git mutation while exclusion and workspace creation both existed                          | Explicit local exclusion-file maintenance versus previewed additive worktree creation; no automatic destructive Git operation         |
| `relayPath` wording implied all writes and a complete filesystem confinement boundary                            | Lexical project-path helper only; global stores and structural/no-follow readers have their own checks                                |
| Authentication/types/doctor docs used outdated `AuthResult`, model-array returns and always-Unknown capabilities | Actual authentication/discovery/result interfaces and advertised Yes/No columns documented                                            |
| A planned-redaction note implied the redaction module did not exist                                              | Recognized-secret handling exists for messages/continuity; checkpoint patches still have no dedicated redaction pass                  |
| Token analytics text promised raw data never entered a scanner's memory                                          | Rirei requests/retains normalized numeric reports; the install-owned external scanner has log access, and flags are not an OS sandbox |
| “No prompts in public activity” omitted the allowed task-title label                                             | Full payload fields are excluded, but bounded sanitized labels can overlap a task's first line; privacyMode uses generic labels       |
| Build docs called the CLI wholly self-contained and listed stale script commands                                 | External native/ESM dependencies and shared React identity; current npm scripts and package boundary                                  |
| Configuration implied one data-home policy for all consumers                                                     | Platform, legacy worktree, quota and Electron resolvers plus differing relative override semantics documented                         |
| Desktop IPC table was incomplete and still described fd-3/native output shapes incorrectly                       | Full preload inventory, base64/cursor/ack path, control ownership and compatibility-only fd protocol                                  |
| Registered internal `bridge` command had no CLI-reference section                                                | Registration/update/worker modes, identity/result flags, validation and bounded worker contract documented                            |
| Generated-report formatter ignore pattern also skipped maintained architecture pages                             | Root-anchor the ignore rule; maintained pages now participate in ordinary Markdown checks                                             |
| Current UI session profiles could be confused with M5 handoff profiles                                           | Persistent model/effort preferences versus rendering-only experimental output/layout strategy                                         |
| Milestone details existed without one cross-subsystem explanation                                                | Consolidated consent → source → requirement → identity/receipt → inspect/retrieve → profile/evaluation guide                          |
| Presence of protocol/helper code could be mistaken for activated native behavior                                 | Inactive approval transport, status-only native observers, benchmark Codex normalization and native continuity acceptance separated   |
| Generated root architecture/health reports mixed historical measurements and auxiliary workspace code            | Maintained docs declared canonical; generated reports remain historical tool artifacts                                                |

## Source-to-document coverage ledger

The formatter finding involved both `.prettierignore`'s generated-report pattern and
`.gitignore`'s generated architecture filenames. Those rules are now root-anchored so generated
root reports remain excluded while maintained pages under `docs/` are checkable. The option-name
inventory also exposed missing `--plans-only` and `--delivery` descriptions; their actual scope
and reserved-delivery behavior are now in the CLI reference.

| Maintained source family                                  | Architecture / rationale coverage                                                                                                 | Evidence contracts                                                                         |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `src/index.ts`, `src/cli/`                                | Shared entry/services, command scope and error formats; ADR-001–003                                                               | CLI reference; `tests/cli/`                                                                |
| `src/application/project-setup.ts`                        | Explicit initialization, dirty baseline, closed-task replacement; ADR-004                                                         | Project-setup and lifecycle tests                                                          |
| `src/application/sessions.ts`, `src/process/`             | Stable operation/run IDs, lease-before-spawn, one-time completion, latest-state merge; ADR-002, 006–008                           | Session fake-host and lifecycle tests                                                      |
| Controller/heartbeat/reconciliation                       | Host/boot/instance evidence, complete inventory, explicit force recovery; ADR-008 and runtime recovery matrix                     | Controller, heartbeat and reconciliation tests                                             |
| `src/state/schema.ts`, `migrations.ts`, `store.ts`        | Independent schema versions, optional stronger metadata, atomic publication/archive limits; ADR-004, 024, 030                     | State migration/store/concurrency tests                                                    |
| `src/state/lock.ts`                                       | Claim rename, acquisition gate, owner token and bounded waits; ADR-005                                                            | State concurrency tests and recorded M5 deadline failures                                  |
| `src/state/leases.ts`                                     | Cooperative one managed writer/worktree and compatibility mirrors; ADR-007                                                        | Session/workspace tests                                                                    |
| `src/state/activity.ts`, `events.ts`                      | Sanitized derivative projection, fixed messages/allowed labels, best-effort publication; ADR-014                                  | Activity projection tests                                                                  |
| TypeScript/desktop terminal journals                      | Private project-path restart hints, filename/path checks, bounded discovery and separate lock rules; ADR-014                      | Journal and ownership-discovery tests                                                      |
| `src/state/history.ts`, `notes.ts`, run labels            | Metadata-only history, declared provenance, freshness anchors and nonrouting display aliases; ADR-014–016, 018                    | CLI history/note/label tests                                                               |
| Git repository helpers                                    | Authority discovery, legacy fingerprint limits, exclusion and additive worktree operations; ADR-017–018, 029                      | Git/checkpoint/worktree tests                                                              |
| `src/worktrees/`                                          | Preview/base/path validation, operation identity, registry publication and non-destructive cleanup; ADR-017, 024                  | Workspace manager tests                                                                    |
| `src/agents/adapter.ts`, `registry.ts`                    | Capabilities, discovery/authentication, launch/resume/classification; ADR-003, 013, 016                                           | Auth/model/resume/provider fixtures                                                        |
| Quota collectors/limit detection/handoff suggestions      | Freshness-qualified medium-confidence evidence, explicit launch warnings/offers; ADR-013, 019                                     | Limit/preflight/handoff-suggestion tests                                                   |
| `src/platform/`                                           | Endpoint/descriptor discovery, PATH/PATHEXT, shell/process control, platform data and installation diagnostics; ADR-012, 020, 024 | Platform and packed-install checks                                                         |
| `src/terminal/`, desktop native loader/host               | Native PTY, parent guard, ConPTY cleanup and separate host interfaces; ADR-002, 012                                               | Native-host/protocol/installer smoke contracts                                             |
| Daemon server/client/protocol                             | Protocol v2, descriptor v1, connection/control capabilities, startup claims, cursors, active runtime; ADR-009–013                 | Daemon/protocol tests                                                                      |
| Bridge CLI/reused worker/sync queues                      | Bounded worker protocol, pending request cap, retry/reset and final-update priority                                               | Daemon sync-worker and lifecycle tests                                                     |
| Provider lifecycle wrappers                               | Passive official hook/loopback observations, no permission replies; ADR-013, 023, 036                                             | Wrapper fixtures; version-specific native qualification remains distinct                   |
| `desktop/main.mjs`, `preload.cjs`, typed ESM declarations | Full IPC inventory, ownership validation, output ACK sequencing, isolated renderer; ADR-010–011, 022                              | IPC/daemon/desktop source contracts                                                        |
| Renderer modules/material/deep links                      | xterm, current-view request tickets, local preferences, reduced transparency, UUID-only intents; ADR-021–022                      | Renderer/latest-request/deep-link/material tests                                           |
| TUI setup/state/attach/threads/mouse                      | Shared services, raw attach/detach/control, provider selection, inbox/analytics projections; ADR-002, 016, 019                    | TUI integration/attach tests; Windows installation guide                                   |
| `src/messages/`, `desktop/threads-ipc.mjs`                | Strict task/run identities, state-before-threads lock order, manual inbox/ack, redaction/envelopes; ADR-015                       | Message capability/store/service/render and desktop Threads tests                          |
| `src/token-usage/`                                        | Opt-in install-owned scanner, numeric normalization, timezone/range coverage, last-good cache; ADR-019                            | Token source/cache/privacy/range fixture tests                                             |
| Approval protocol/store                                   | Implemented validation model versus inactive decision transport; ADR-023                                                          | Approval model/store tests, not activated-provider acceptance                              |
| Context schema/store/capture/normalizers                  | Consent/epoch/grants, visible fields, strict logical append and source-loss reporting; ADR-025–026, 036                           | Capture/normalizer/source/compiled CLI tests                                               |
| Context render/briefing/path handling                     | Exact requirements/chronology, source completeness and historical authority; ADR-027–028, 034                                     | Briefing, interruption and saved-case replay                                               |
| Covered snapshot and verification modules                 | Declared input scope, double-scan consistency, pending/exit/environment receipts; ADR-029–030                                     | Snapshot/receipt/spawn-failure fixtures                                                    |
| Inspection/code-display modules                           | One observed bundle, immutable Git blobs, display omissions and cache key; ADR-031, 034                                           | Inspection/source/compiled CLI and numeric M3 report                                       |
| Retrieval schema/index/cursor/file/output modules         | Exact data types, stable offsets, invalidation, request-file transport and fair batches; ADR-032–034                              | M4 retrieval, batch, CLI and authored-volume workload                                      |
| Prompt-policy module and preview CLI                      | No source reselection, headroom charge, explicit fallback and layout diagnostics; ADR-035                                         | M5 preservation/budget/prefix/source/compiled tests                                        |
| Benchmark controls/runtime/budget/writer/measurement      | Frozen artifact identity, local preflight, shared attempt cap, persistence and provider counter semantics; ADR-037–040            | M0–M5 notes and fake-provider/fault/replay fixtures                                        |
| Benchmark output/layout planning/analysis                 | Separate contrast, AB/BA order, model/version/spacing/counter coverage and no automatic promotion; ADR-041                        | M5 protocol/analysis tests; output/layout live observations absent                         |
| Frozen-control E1 receiver runner                         | Archived/current CLI identities, balanced pairs, eight-attempt cap and explicit helper; ADR-037–041                               | E1 boundary tests, fake rehearsal and eight live receivers; shell PATH limitation recorded |
| Build/package/CI/distribution                             | External dependencies, ASAR closure, exact tarball matrix, immutable/publication boundaries; ADR-020, 024                         | Package check, packed smoke, release workflow                                              |

All enumerated principal maintained families now have an architecture entry. Tiny utilities and
every individual option remain defined by their source/API documentation; the ledger is not a
claim that every internal branch requires its own ADR.

## Remaining implementation and qualification gaps

These are now **documented gaps**, not features silently claimed complete:

1. **Storage/entrypoint drift:** platform paths, legacy worktree paths, Electron runtime roots and
   some Windows desktop assumptions are not one completed migration. Relative overrides differ.
   Bootstrap's selected-worktree discovery also differs from later primary-authority task lookup;
   arbitrary linked-worktree initialization is not separately qualified by the normal managed flow.
2. **Durability/lock asymmetry:** authoritative state rename lacks explicit fsync; derivative
   terminal journals use age-based lock reclamation; multi-file actions are not transactions.
3. **Load-sensitive deadlines:** M5 parallel runs hit existing snapshot/message-lock deadlines;
   the serial full suite passed. No broader concurrent-I/O robustness claim was established.
4. **Transport/global lifetime bounds:** per-frame/per-terminal ring and Electron in-flight delivery
   are bounded; arbitrary socket/event backlog, connections, and lifetime completed terminals are
   not proven globally bounded. This is not a multiuser/DOS-resistant daemon claim.
5. **Native capture/switch acceptance:** native status observers do not establish interactive Codex
   continuity capture. General reverse capture, application switches and native Windows continuity
   still need separate version/platform qualification. Existing Windows package smoke is narrower.
6. **Permission decisions:** validated protocol/store exists but its HTTP decision channel and native
   provider reply activation remain inactive. Current operation is status observation only.
7. **Verification scope:** no CLI creates a hermetic trusted reuse qualification; ignored inputs,
   dependencies/services/environment and observation intervals remain partially unmeasured.
8. **Efficiency promotion:** [E1 completed on 2026-11-18](../benchmarks/continuity/reports/e1-2026-11-18.md)
   with 4/4 strict cases per version and mixed efficiency. E2/E3 remain pending; lower live usage/time
   was not established across receivers. Native targeted lookup was unexercised, and login-shell
   PATH shadowing exposed a helper-routing qualification gap.
9. **Distribution:** npm registry/trusted-publisher and macOS signing/notarization status must be
   established through release evidence, not inferred from source metadata or this audit.
10. **Historical author intent:** where no design note/approval exists, rationale is reconstructed.
    Owner review can amend these records; the audit cannot recover unrecorded private discussions.

## Auxiliary workspace artifacts

Generated root `ARCHITECTURE*.md`, `.furou/`, sync copies such as `… 2.ts`, and local runtime
artifacts are not canonical maintained architecture sources. Broad TypeScript/format/test discovery
can still encounter sync copies, so their absence from the explicit application import graph does
not prove every root-wide check ignores them. Prior code qualification used the clean intended-file
verification checkout; this audit does not delete or overwrite these artifacts.

Untracked `todo-api/`, `workflow_engine/`, `tests_workflow/`, SQLite files and ad-hoc live-driver
scripts are auxiliary/user-workload material, not an imported production service of `relay`.
Their own internal architectures and private run histories are **not fully documented by this
application audit**. They are identified rather than promoted into the app diagram or executed
to infer behavior. A separate owner-requested workload audit can define that scope.

Vendored/native third-party internals, provider-private protocols beyond the implemented fields,
credentials/log contents, and generated binaries are likewise outside this documentation inspection.

## Validation and maintenance

This pass validates touched Markdown formatting, repository-relative links/anchors, referenced
source/test paths, the 42 decision identifiers, and coverage of the current preload inventory.

The completed static inventory checked **16 Markdown documents, 136 local links/anchors, 117
explicit source/test paths, 17 named npm scripts, 42 ordered decision records, all 44 current
preload methods/channels, 26 registered root CLI commands, and 89 distinct declared option names**.
External URLs were not fetched. The generated root reports remain ignored while the maintained
architecture pages are no longer skipped by the formatter.

Final verification passed `npm run format`, `npm run check`, `npm run lint`, and
`npm run package:check` (the existing 13-file package boundary). These checks ran in the clean
intended-file verification checkout; the 20 audited documentation/configuration/comment files
were confirmed byte-identical to the working copy. The working copy also passed a targeted
whitespace check. Runtime-source edits in this documentation pass are comments only.

No new runtime/native test score or architecture “health grade” is manufactured. The latest code
qualification remains M5's **850 passed / 3 skipped** serial suite plus its documented fixture and
packaging checks.

For each future architectural change, update: decision/status/rationale, mechanism and failure
boundary, persistent/wire version and owner, source/test evidence, and shipped/prototype/native
qualification. Recheck this ledger when a new entrypoint, store, source type, transport, cache,
provider capability, or default policy is added. Preserve historical as-tested benchmark reports.
