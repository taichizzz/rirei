# Implementation notes

- Use only Node.js built-ins and export from `src/index.js`.
- Inputs are untrusted JSON-like configuration; prototype safety is a correctness requirement.
- Do not mutate or retain mutable aliases to either input. Run `npm test` after edits.
