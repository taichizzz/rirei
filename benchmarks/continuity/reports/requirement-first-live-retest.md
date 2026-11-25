# Requirement-first handoff: live receiver retest

## Conclusion

**The requirement-first candidate recovered the observed acceptance failures on these saved
checkpoints.** Rirei's generated implementations passed **4/4** cases, compared with **2/4**
in the original pilot. Fresh full-history receivers also passed **4/4**.

One Rirei session encountered storage and logging failures. Its implementation passed every
acceptance group, but the predeclared execution/capture gate still marks it invalid. Rirei
therefore has **3/4 strict successful runs**. This is not a clean four-case performance win.

## Outcomes

| Direction      | Task          | Previous Rirei acceptance | New Rirei acceptance | New full-history acceptance | New Rirei run validity   |
| -------------- | ------------- | ------------------------- | -------------------- | --------------------------- | ------------------------ |
| Claude → Codex | Tenant ledger | Pass                      | Pass, 7/7 groups     | Pass, 7/7 groups            | Clean                    |
| Claude → Codex | Cursor feed   | Pass                      | Pass, 7/7 groups     | Pass, 7/7 groups            | Clean                    |
| Codex → Claude | Cursor feed   | Fail                      | Pass, 7/7 groups     | Pass, 7/7 groups            | Storage/logging incident |
| Codex → Claude | Tenant ledger | Fail                      | Pass, 7/7 groups     | Pass, 7/7 groups            | Clean                    |

All eight outputs passed six behavioral groups and one provided-file integrity group:
**56/56 acceptance groups**. The previously missed page-size limit, defensive copying,
duplicate-first-wins behavior, and safe-integer validation now pass the frozen checks.
Finite acceptance checks do not prove correctness for every possible input.

## Method and budget

- **Eight fresh receiver launches**, four per receiving provider, with **zero new predecessors**.
  Reused the four byte-frozen partial repositories and real histories from the
  [original two-way pilot](2026-11-02-bidirectional.md).
- Both methods received identical checkpoint files and could retrieve the same complete
  retained visible evidence. Rirei used the requirement-first briefing; the baseline used full
  retained history. Receiver order remained balanced by task within each direction.
- Both methods received an explicit current-workspace instruction and historical-path guidance.
  This shared prompt change limits causal comparisons with the original pilot.
- Claude Code **2.1.258**, requested `sonnet` / low, resolved **`claude-sonnet-5`**. Codex CLI
  **0.166.0**, requested **`gpt-5.6-sol` / low**; the stream did not emit a resolved model ID.
  Codex was **0.153.4** previously. Fresh arms share a version within each provider; historical
  score differences include that CLI change.
- At most 180 seconds per session. **All eight authorized attempts were used**, including
  the storage-affected session. No failed receiver was replaced or automatically rerun.
- Held-out acceptance drivers ran after the live sessions ended, outside candidate workspaces.

## Storage incident and recovery

The Codex → Claude cursor-feed Rirei session encountered **10 filesystem-error tool results**,
including read timeouts and `ENOSPC`. Its logger also recorded an `ENOSPC` write failure.
Claude eventually completed with exit code 0 and a final usage record; replay of the saved
trace reproduced its counters. The capture failure flag remains set.

The original stop record, result, and usage were preserved. Unused development packages were
removed only from the agent-created temporary verification checkout. The remaining four
receivers ran in local temporary workspaces after a free-space check and were archived
privately afterward. Their continuation ledger carried forward the first four attempts,
keeping the aggregate cap at eight. The other seven traces had no matching filesystem errors.

This recovery changed the runtime environment across phases. Exclude the affected **pair**,
not just Rirei's side, when comparing clean paired performance.

## Clean matched-pair measurements

| Direction      | Matched cases | Context      | Acceptance | Non-cached input + output | Tool calls | Receiver wall time |
| -------------- | ------------: | ------------ | ---------: | ------------------------: | ---------: | -----------------: |
| Claude → Codex |             2 | Full history |        2/2 |                    25,027 |          9 |          154.651 s |
| Claude → Codex |             2 | Rirei        |        2/2 |                    18,072 |          7 |          149.799 s |
| Codex → Claude |             1 | Full history |        1/1 |                    10,196 |          3 |           24.843 s |
| Codex → Claude |             1 | Rirei        |        1/1 |                     9,732 |          4 |           39.753 s |

In the two clean Codex-receiver pairs, Rirei used about **27.8% fewer non-cached input + output
tokens**, with **3.1% less receiver wall time**. In the one clean Claude-receiver pair, it used
**4.6% fewer non-cached tokens** but **60.0% more wall time** and one more tool call.

Efficiency remains mixed; the sample is small and cache reuse varies. These counters are not
an authoritative subscription-quota or dollar bill. Totals are not pooled across providers.
Raw totals, including the affected session, remain in the [analysis](requirement-first-live-retest/analysis.md)
and must not be presented as clean latency or cost results. Historical predecessor costs remain
unmeasured; checkpoint reuse does not establish end-to-end production savings.

## Evidence and retention

- Every Rirei prompt contained **6/6 complete requirement strings**, versus 0/6 previously.
  Lexical preservation and behavioral acceptance are recorded separately.
- All paired checkpoint hashes, retained-history hashes, and evidence-integrity checks passed.
  Frozen reference snapshots remained unchanged. Replayed counters matched execution metrics.
- No literal references to another known workspace appeared in the new receiver tool calls.
  This is not proof of adversarial filesystem isolation.
- Acceptance passes, infrastructure flags, strict successes, and clean-pair totals remain
  separate. The original live report and its 2/4 score were not rewritten.

[Per-case counters, hashes, and diagnostics](requirement-first-live-retest/analysis.json) are
included. The combined private report SHA-256 is
`1e0bde884fdfb04f879e61d6708c2c189733b7bc458de9de90f4aa9fa2222862`.
Private originals, the stop record, continuation controller, workspaces, visible streams,
and verified tested-source/CLI-bundle archive remain under
`.relay/benchmarks/requirement-first-retest-1/` and `local-continuation-1/`.
Public exports exclude account details, prompts, commands, host paths, and session identifiers.

This is one receiver-only trial per method on two authored tasks per direction. It does not
qualify an Orca comparison, agent-written handoff, Windows, new predecessor capture, or the
interactive switch UI. The fix has positive behavior evidence here; broader quality, latency,
and cost advantages require additional held-out tasks and repeated storage-stable pairs.
