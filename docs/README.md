# Relay documentation

Relay preserves provider-independent coding-task state so a developer can move one task
between installed coding-agent CLIs (Claude Code, Codex, Gemini, Antigravity, and OpenCode) without losing
context or exposing credentials.

This directory documents how Relay actually behaves today. Where the implementation is
intentionally conservative or a configuration value is reserved for future use, the docs
say so explicitly rather than describing aspirational behavior.

## Contents

For installation and changes in this version, see the [alpha.5.5 update notes](release-0.1.0-alpha.5.5.md).

| Document                                                 | What it covers                                                                                               |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| [architecture.md](architecture.md)                       | Current module/authority map and task, switch, daemon, and continuity data flows.                            |
| [architecture-decisions.md](architecture-decisions.md)   | 42 retrospective decisions with rationale, mechanism, tradeoffs, status and evidence.                        |
| [runtime-protocols.md](runtime-protocols.md)             | Daemon framing/control, complete Electron preload inventory, output/recovery mechanics.                      |
| [continuity-architecture.md](continuity-architecture.md) | Detailed M0–M5 consent, source/identity, snapshot/receipt, inspection/retrieval and evaluation architecture. |
| [architecture-audit.md](architecture-audit.md)           | Source-to-document coverage, corrected contradictions, and unresolved qualification/debt.                    |
| [cli-reference.md](cli-reference.md)                     | Every `relay` command, its options, and exact behavior.                                                      |
| [configuration.md](configuration.md)                     | `.relay/config.json` schema, defaults, and which fields are honored vs. reserved.                            |
| [state-and-events.md](state-and-events.md)               | The `RelayState` schema, migrations, atomic writes, and activity projection.                                 |
| [checkpoints-and-handoff.md](checkpoints-and-handoff.md) | Checkpoint contents, size bounding, and the handoff format.                                                  |
| [benchmarks.md](benchmarks.md)                           | Handoff benchmark protocol, archived results, limits, and reproduction commands.                             |
| [agents.md](agents.md)                                   | The adapter contract, executable/exit detection, and how to add an adapter.                                  |
| [relay-threads.md](relay-threads.md)                     | Local run messaging, capability checks, limits, and delivery semantics.                                      |
| [desktop.md](desktop.md)                                 | The Electron app, the integrated xterm.js terminal, and the PTY bridge.                                      |
| [security.md](security.md)                               | Authentication boundary, Git safety rules, path policy, and secret handling.                                 |
| [approval-protocol.md](approval-protocol.md)             | Versioned local permission-decision boundary and provider activation requirements.                           |
| [development.md](development.md)                         | Building, testing, linting, packaging, and the source tree.                                                  |
| [publication.md](publication.md)                         | Licensing, package checks, history cleanup, and release gates.                                               |
| [changelog.md](changelog.md)                             | User-visible implementation and documentation changes.                                                       |

## Planning

For proposed future work, see the [handoff efficiency plan](handoff-efficiency-plan.md):
phases, interfaces, correctness gates, and separately budgeted evaluation for lower-token,
faster continuations. Proposed commands in that plan are not current CLI behavior.

[M0–M1 milestone notes](handoff-efficiency-m0-m1.md) describe the implemented measurement
and benchmark-runtime foundation and its offline verification.

[M2 milestone notes](handoff-efficiency-m2.md) cover the implemented input identities,
host-command receipts, conservative freshness display, and offline qualification.
[M3 milestone notes](handoff-efficiency-m3.md) cover bounded current-state inspection,
snapshot-bound source excerpts, saved-case replay, and local preparation measurements.
[M4 milestone notes](handoff-efficiency-m4.md) cover exact source windows, indexed historical
lookup, cursor invalidation, bounded batches, and measured offline retrieval volume.
[M5 preparation notes](handoff-efficiency-m5.md) cover named output/layout rendering profiles,
budget-preserving fallback, and balanced cache-analysis controls. The
[E1 live smoke](../benchmarks/continuity/reports/e1-2026-11-18.md) records current default-candidate
quality parity, mixed efficiency, and helper-routing limits. E2/output-layout evaluation remains
separately budgeted and pending.

## Quick orientation

- The **repository and `.relay/` task files are the project source of truth.** Relay does not
  transfer a live provider conversation/account or hidden reasoning. The opt-in prototype can
  include bounded retained visible instructions/tool evidence in an approved handoff.
- Relay **owns** task orchestration, checkpointing, handoff generation, and local history.
- Each **provider CLI owns** its own authentication, billing, rate limits, and permissions.
- Relay **never** commits, pushes, resets, merges, or discards repository changes.

Alpha.5.5 includes the opt-in continuity commands; the milestone notes preserve their original
as-tested scope and results.
Explanatory rationale is retrospective unless a linked plan records it; implementation status,
native acceptance and measured efficiency are different claims. The complete architecture guides
are maintained in this repository; the minimal npm package contains only its curated operational docs.

For a task-by-task walkthrough, start with [cli-reference.md](cli-reference.md).
