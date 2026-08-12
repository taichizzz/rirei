# Implementation notes

- Keep the cache deterministic through the injected `now()` clock; do not use timers.
- Use only Node.js built-ins and export `TtlLruCache` from `src/index.js`.
- Public tests cover the basic Map-like phase. Run `npm test` after edits.
