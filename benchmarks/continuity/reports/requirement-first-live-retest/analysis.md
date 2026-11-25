# Frozen-checkpoint receiver retest

Receiver launches: 8; new predecessors: 0; reused checkpoints: 4; total attempts in this retest: 8.

| Direction       | Arm          | Correct | Prompt chars |   Input | Cached input | Output | Non-cached input + output | Tool calls | Receiver time (ms) |
| --------------- | ------------ | ------: | -----------: | ------: | -----------: | -----: | ------------------------: | ---------: | -----------------: |
| claude-to-codex | full-history |     2/2 |       25,168 | 238,411 |      219,904 |  6,520 |                    25,027 |          9 |            154,651 |
| claude-to-codex | rirei        |     2/2 |       10,789 | 150,760 |      138,496 |  5,808 |                    18,072 |          7 |            149,799 |
| codex-to-claude | full-history |     2/2 |       21,977 | 133,139 |      108,915 |  4,522 |                    28,746 |          7 |             55,777 |
| codex-to-claude | rirei        |     1/2 |       11,426 | 359,649 |      339,407 |  9,193 |                    29,435 |         25 |            158,699 |

Strict correctness above includes the execution/capture validity gate. Acceptance passes are tracked separately.

| Direction       | Arm          | Acceptance passes | Clean runs | Strict successes |
| --------------- | ------------ | ----------------: | ---------: | ---------------: |
| claude-to-codex | full-history |               2/2 |        2/2 |              2/2 |
| claude-to-codex | rirei        |               2/2 |        2/2 |              2/2 |
| codex-to-claude | full-history |               2/2 |        2/2 |              2/2 |
| codex-to-claude | rirei        |               2/2 |        1/2 |              1/2 |

## Clean matched pairs only

| Direction       | Arm          | Matched cases | Correct | Non-cached input + output | Receiver time (ms) |
| --------------- | ------------ | ------------: | ------: | ------------------------: | -----------------: |
| claude-to-codex | full-history |             2 |       2 |                    25,027 |            154,651 |
| claude-to-codex | rirei        |             2 |       2 |                    18,072 |            149,799 |
| codex-to-claude | full-history |             1 |       1 |                    10,196 |             24,843 |
| codex-to-claude | rirei        |             1 |       1 |                     9,732 |             39,753 |

## Paired task outcomes

- claude-to-codex / tenant-ledger: full history pass, Rirei pass. Rirei versus full history: {"promptCharacters":-47.45,"inputTokens":-37.7,"nonCachedTokens":-27.9,"wallTimeMs":-9.81,"toolCalls":-20}.
- codex-to-claude / cursor-feed: full history pass, Rirei fail. Rirei versus full history: {"promptCharacters":-48.16,"inputTokens":301.42,"nonCachedTokens":6.22,"wallTimeMs":284.52,"toolCalls":425}.
- claude-to-codex / cursor-feed: full history pass, Rirei pass. Rirei versus full history: {"promptCharacters":-62.77,"inputTokens":-35.58,"nonCachedTokens":-27.67,"wallTimeMs":10.73,"toolCalls":-25}.
- codex-to-claude / tenant-ledger: full history pass, Rirei pass. Rirei versus full history: {"promptCharacters":-47.87,"inputTokens":6.48,"nonCachedTokens":-4.55,"wallTimeMs":60.02,"toolCalls":33.33}.

## Limitations

- Two authored tasks per direction, one receiver per arm/checkpoint; no statistical superiority claim.
- Controlled first-stage-only predecessors, not naturalistic interruptions or a full application switch-UI trial.
- Full history means all retained visible evidence, with the same capture bounds/redactions as Rirei.
- Predecessor usage counters are missing after interruption; total lifecycle cost and human effort are unknown.
- Token totals are compared within a receiver provider, not pooled into cross-provider bills or quota estimates.
- Cache reuse, tool-call counts, and path confusion vary; shorter prompts do not imply better continuation.
- Exact requirement-string presence is a lexical diagnostic, not a semantic compliance score.
- Lookup counts are command attempts; literal path-reference audits do not establish filesystem read isolation.
- No Orca runtime, agent-written handoff, reverse interactive capture integration, or Windows acceptance was compared.
