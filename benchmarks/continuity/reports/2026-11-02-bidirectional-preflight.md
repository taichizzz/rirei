# Two-way handoff pilot — 2026-11-02

Follow-up: after sign-in and an authorized replacement, the
[two-way pilot completed](2026-11-02-bidirectional.md). This document preserves the initial
authentication failure and its zero-token counters.

## Initial attempt: blocked before model inference

The user approved a two-way experiment with a 12-session total cap. The first Claude
predecessor launch exited with an authentication error:

> Failed to authenticate: OAuth session expired and could not be refreshed

The CLI's earlier `auth status` reported a cached signed-in state; the actual invocation
failed. The experiment stopped before starting any receivers or Codex predecessors.
**This initial attempt produced no continuation-quality or performance comparison.**

| Observation                   | Result            |
| ----------------------------- | ----------------- |
| Launch attempts recorded      | 1 of 12           |
| Receivers launched            | 0                 |
| Reported input/output tokens  | 0 / 0             |
| Reported cache read/write     | 0 / 0             |
| Requested Claude model/effort | `sonnet` / `low`  |
| Resolved model at CLI startup | `claude-sonnet-5` |
| CLI exit code                 | 1                 |
| Startup-failure wall time     | 987 ms            |
| Automatic reruns              | 0                 |

Zero counters describe this authentication failure, not the expected cost of a coding run.
The CLI's synthetic error response is not a completed model turn or coding predecessor.

## Planned design

- Two multi-file tasks: an atomic tenant event ledger and a stable cursor-paginated feed.
- Each task is attempted in both directions: **Claude → Codex** and **Codex → Claude**.
- Four real predecessors, then two fresh receivers per frozen checkpoint: **Rirei's current
  briefing** and **full retained visible history**. Both may retrieve the same source records.
- Claude `sonnet` / low and Codex `gpt-5.6-sol` / low, held fixed within each comparison.
- Predecessors implement only the first helper stage; interrupt after a captured completed
  source-changing tool, or 75 seconds. Receivers have a 180-second limit. This controlled
  partial-work setup uses authored tasks; it is not a naturalistic interruption study.
- Rotate receiver order, freeze implementation/history hashes, withhold acceptance drivers,
  and grade only after the live sessions stop. Each task has six behavioral groups plus
  a provided-file integrity check.
- Record preparation, predecessor, and receiver costs separately. Missing counters remain
  unknown; cache creation/read counters are distinct and cross-provider totals are not bills.

Frozen fixture hashes:

| Task            | SHA-256                                                            |
| --------------- | ------------------------------------------------------------------ |
| `tenant-ledger` | `ab1b6f8cf39c8d7c52f2aed6be3b57c8617920f8e6c27be5356fb75604d8e4d5` |
| `cursor-feed`   | `b8499ae3fb549b50fb7f3d55a00dc5154622306bba756f88e3b6e37a0e979a9d` |

## What was verified

- Offline reference implementations pass every acceptance group; initial implementations fail.
- Fake-provider process tests exercise both directions, native-shaped Claude hooks, Codex exec
  events, identical paired checkpoints, source lookup, evidence integrity, and external grading.
- Concurrent budget reservations are serialized, repeated session keys are refused, and the
  total cap is enforced. Those tests use fake providers and consume no live model quota.
- The failed native Claude invocation delivered **SessionStart, UserPromptSubmit, and SessionEnd**
  through the production capture path. This verifies those three hook deliveries on Claude Code
  2.1.258, not native tool-hook delivery or successful task continuation.
- Codex exec capture retains visible commands, file changes, and assistant claims; reasoning
  items are excluded. Its new observer remains benchmark-scoped; interactive Codex capture
  is not enabled in the application.
- Targeted regressions: **63 tests passed**; targeted TypeScript, ESLint, and CLI build passed.

## Artifacts and continuation

The original protocol, session ledger, filtered visible event stream, hook journal, and
failure report are retained privately under the ignored project-local directory
`.relay/benchmarks/bidirectional-2026-11-02/`. Public records omit account information,
absolute host paths, prompts, commands, and provider session identifiers.

Sign in interactively with `claude auth login` before another live invocation. The original
attempt remains recorded. Replacing this zero-token failed launch requires authorization;
automatic reruns are disabled. Completing all four predecessors and eight receivers after
this failure would require one replacement beyond the original 12-attempt cap.
