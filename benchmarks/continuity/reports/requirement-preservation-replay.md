# Requirement-first handoff candidate

## What changed

The two-way pilot exposed a concrete defect: the compact selector excerpted a roughly
1,600-character submission and displaced its acceptance requirements with trailing setup
instructions. The post-pilot candidate now gives complete retained submissions priority
over tool output and assistant claims.

- When the submitted messages fit the available 6,000-character briefing budget, keep them
  whole, with source IDs and receipt order. Under pressure, prefer newer whole messages.
- Treat excerpts as incomplete previews. Any message not fully inline appears in
  `submissionCoverage.requiredSourceIds`, and the briefing requires source lookup before editing.
- `relay context task` returns both the original task and paged `submittedMessages`, along
  with the current workspace. Empty structured task fields no longer hide later submissions.
- Show the current workspace explicitly. Suppress path-bearing historical tool commands,
  outputs, edit paths, and assistant claims from previews while retaining their exact sources.
- Distinguish capture truncation/redaction from display omission. Lookup cannot reconstruct
  text that was never retained. The path display heuristic is not a filesystem sandbox.

## Saved-case replay

`replay-cross.mjs` re-renders the four original Rirei handoffs using their captured journals.
It verifies original prompt/history hashes and confirms that the source journals and original
report remain unchanged. It invokes no providers and does not edit or regrade the candidates.

| Original handoff | Task          | Complete requirement strings before | After | Current workspace explicit | Historical predecessor path in preview |
| ---------------- | ------------- | ----------------------------------: | ----: | -------------------------- | -------------------------------------- |
| Claude → Codex   | Tenant ledger |                                 0/6 |   6/6 | Yes                        | No                                     |
| Codex → Claude   | Cursor feed   |                                 0/6 |   6/6 | Yes                        | No                                     |
| Claude → Codex   | Cursor feed   |                                 0/6 |   6/6 | Yes                        | No                                     |
| Codex → Claude   | Tenant ledger |                                 0/6 |   6/6 | Yes                        | No                                     |

Every saved submission is now fully inline, and each briefing remains below 6,000 characters.
Exact requirement-string presence is an offline preservation check, not a semantic compliance
or model-performance score. The reviewed [replay data and candidate source hashes](requirement-preservation-replay/replay.json)
record this candidate separately from the original experiment.

## Verification and remaining gate

Follow-up: the [receiver-only live retest](requirement-first-live-retest.md) completed with
Rirei acceptance passes on 4/4 cases and full history on 4/4. One Rirei session had storage
and logging errors. The offline replay remains separate from those live results.

Regression coverage includes complete acceptance messages longer than 900 characters,
uncued requirements, chronological corrections, overflow source instructions, Unicode/budget
bounds, truncated/redacted capture, historical POSIX/Windows paths, and paginated task lookup
with more than 20 submissions and unrelated-workspace evidence.

The clean verification checkout passed TypeScript, ESLint, formatting, CLI build, and
**703 tests with 3 skipped**, plus six frozen interruption-fixture checks, the offline
two-way fixture checks, and the package-content allowlist check.
The existing 33 benchmark tests and eight-task zero-provider dry-run passed, as did the
packed CLI install, TUI, daemon, PTY, reinstall, and uninstall smoke check.

The [original live pilot](2026-11-02-bidirectional.md) remains **Rirei 2/4 versus full history
4/4**. At the time of this offline replay, candidate live correctness, usage, and runtime were
unknown. The subsequent retest is linked above; additional held-out cases and repeated,
storage-stable paired trials remain necessary for broader claims.
