# Synthetic successor pilot

Provider sessions: 12. Model: gpt-5.6-sol; effort: low.

| Arm                | Correct / executed | Input tokens | Cached input | Output | Non-cached input + output | Tool calls | Wall time (ms) |
| ------------------ | -----------------: | -----------: | -----------: | -----: | ------------------------: | ---------: | -------------: |
| request-repository |              3 / 3 |      199,465 |      158,080 |  3,073 |                    44,458 |         14 |         64,147 |
| full-history       |              3 / 3 |      203,050 |      160,256 |  2,882 |                    45,676 |         12 |         62,803 |
| rirei-v1           |              3 / 3 |      224,508 |      188,160 |  3,383 |                    39,731 |         15 |         67,135 |
| rirei-v2           |              3 / 3 |      212,171 |      154,880 |  3,380 |                    60,671 |         17 |         63,280 |

## V2 versus frozen V1

- promptCharacters: -11.54%.
- inputTokens: -5.5%.
- nonCachedTokens: +52.7%.
- wallTimeMs: -5.74%.
- toolCalls: +13.33%.

## Limitations

- One successor per case and arm; no confidence intervals or causal attribution.
- These small tasks have a correctness ceiling and do not demonstrate a memory advantage.
- Cache reuse varies; non-cached tokens are not an authoritative bill or subscription-quota measure.
- Capture and human effort are unmeasured, not zero.
- Context-lookup command counts are attempts and can include short-circuited shell chains.
- Parent-directory searches are audit flags, not proof of answer leakage; filesystem read isolation was not adversarial.
- No real Claude predecessor, agent-written handoff, or Orca runtime was compared.
