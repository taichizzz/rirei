# Implementation notes

- This is a filesystem security boundary. Use Node built-ins only and fail closed.
- Export the async function from `src/index.js`; do not create or modify candidate paths.
- Public tests cover lexical foundations. Hidden tests exercise real symlinks.
