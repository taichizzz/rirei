# Implementation notes

- Use only Node.js built-ins and keep the public API in `src/index.js`.
- Treat parser input as untrusted protocol text; reject malformed values rather than guessing.
- Run `npm test` after edits. Hidden evaluator tests are not present during implementation.
