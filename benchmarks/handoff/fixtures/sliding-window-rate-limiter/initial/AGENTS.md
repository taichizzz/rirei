# Implementation notes

- Use only Node.js built-ins and keep the public API in `src/index.js`.
- Never store unbounded timestamp arrays; use a fixed circular ring of sub-window buckets.
- Multi-token acquires must be atomic: if tokens exceed capacity, deduct zero tokens and calculate retryAfterMs.
- Run `npm test` after edits. Hidden evaluator tests are not present during implementation.
