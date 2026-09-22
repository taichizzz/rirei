# Implementation notes

- Use only Node.js built-ins and keep the public API in `src/index.js`.
- Treat inputs and patch operations as potentially untrusted; validate strictly.
- Never use JSON.parse / JSON.stringify cloning; mutations must be atomic in-place with reversible rollback.
- Run `npm test` after edits. Hidden evaluator tests are not present during implementation.
