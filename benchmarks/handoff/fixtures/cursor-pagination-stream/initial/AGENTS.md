# Implementation notes

- Use only Node.js built-ins and keep the public API in `src/index.js`.
- Never use offset-based pagination or slice(offset); cursors must be composite keysets encoded in base64url.
- Sort comparisons must deterministically place null/undefined values LAST regardless of ASC or DESC order.
- Run `npm test` after edits. Hidden evaluator tests are not present during implementation.
