# Handoff V2 implementation and benchmark plan

Status: ready for implementation
Created: 2026-08-11
Scope: compact handoff rendering, local Relay-state exclusion, reliable note capture, and a clean paired benchmark rerun

## 1. Outcome

Deliver a smaller and cleaner provider handoff that sends only continuation knowledge Git cannot
reconstruct. The default outbound handoff should normally use 200-300 estimated tokens, must not
repeat the task request, and must not ask the successor to record Relay notes. Relay state must not
appear in ordinary Git status. The benchmark must then be rerun from fresh repositories with no
Relay state available to either successor condition.

Implementation is complete when all product and benchmark acceptance criteria in this document
pass. A negative benchmark result is still a valid completion if it is measured and reported
honestly.

## 2. Evidence and current failure modes

The 2026-08-11 five-task benchmark measured these results:

| Metric                      |           Strong baseline |  Current Rirei handoff |            Delta |
| --------------------------- | ------------------------: | ---------------------: | ---------------: |
| Non-cached successor tokens |                   117,146 |                132,270 |           +12.9% |
| Successor wall time         |                394,708 ms |             373,642 ms |            -5.3% |
| Correct completions         |                       4/5 |                    4/5 |        no change |
| Handoff size                | 659-744 prompt characters | 1,462-2,349 characters | treatment larger |
| Handoff estimate            |            not applicable |         366-588 tokens |     above target |

The run exposed five issues this plan must correct:

1. A short task request appeared in both the title and Goal section.
2. The successor received a generic `relay note <type>` instruction and guessed unsupported types.
3. Completed work, changed files, test history, and other Git-recoverable facts consumed prompt space.
4. `.relay/` appeared in Git status, and baseline agents could inspect Relay state.
5. One predecessor worked outside the intended repository, so its notes were not captured.

The existing benchmark report remains the immutable V1 evidence:
`benchmarks/handoff/reports/2026-08-11.md`.

## 3. Product principles

### 3.1 Send the semantic delta

The default handoff should prioritize only:

1. The task once.
2. The next concrete action.
3. An active blocker.
4. A rejected approach that would otherwise be repeated.
5. A decision whose rationale is not evident from Git.
6. A failed or unverified test only when it changes the next action.
7. A short Git anchor and one preserve-existing-work safety sentence.

Completed work, passed tests, full changed-file lists, full commit hashes, and resolved notes remain in
the structured capsule or repository but do not appear in the default launch prompt.

### 3.2 Use progressive disclosure

The rendered text is the small launch prompt. `relay handoff --json` may retain a complete structured
capsule for UI display, auditing, or explicit inspection. Reducing the prompt must not delete durable
state.

### 3.3 Do not claim exact provider tokens

Providers tokenize Unicode and punctuation differently. Relay should report a deterministic
provider-neutral estimate and a character ceiling. The default contract is:

| Budget                           |                                                           Value |
| -------------------------------- | --------------------------------------------------------------: |
| Target range for normal handoffs |                                        200-300 estimated tokens |
| Effective maximum                |                                            300 estimated tokens |
| Effective character ceiling      |                                                1,200 characters |
| Minimum                          | none; a complete 90-token handoff is better than padding to 200 |

The implementation and report must call these values estimates unless measured provider prompt-token
counts are available separately.

### 3.4 Never invent notes

Relay may derive Git facts but must not infer a decision, blocker, or rejected approach from source
changes. Missing note capture must be visible rather than repaired with fabricated data.

## 4. Scope

### In scope

- Redesign the compact text renderer.
- Remove duplicate task text.
- Remove successor note-recording instructions.
- Add a 300-estimated-token effective default and a 1,200-character ceiling.
- Keep the complete structured JSON capsule available.
- Add `.relay/` to the repository-local Git exclude file safely and idempotently.
- Repair local exclusion for repositories initialized by older versions.
- Add an atomic, schema-validated batch note-capture path.
- Improve invalid note-type diagnostics.
- Add source-side note capture instructions to the benchmark predecessor only.
- Fail benchmark setup before successor calls when expected notes were not captured.
- Build fresh successor repositories without `.relay/` in either condition.
- Replace the ambiguous Retry-After hidden fixture assertion.
- Run dry validation, repository verification, and the paid benchmark after explicit approval.
- Publish a new V2 report without overwriting V1.

### Out of scope

- Automatic model-generated summaries inside the renderer.
- Parsing hidden reasoning or complete provider conversations.
- Copying Relay state into the baseline condition.
- Post-hoc insertion of missing benchmark notes.
- A broad agent-orchestration redesign.
- TUI, Electron, or GPUI work.
- Claims of statistical significance from five tasks.

## 5. Phase 0: preserve evidence and establish gates

### Tasks

1. Inspect `git status`, current diffs, and the existing benchmark reports before editing.
2. Do not alter or delete the V1 report, raw-run references, or unrelated user changes.
3. Record the current test counts and verify the V1 result files still parse.
4. Add unit tests that fail under the current renderer before changing production behavior.
5. Do not create a commit until the local Git email is the GitHub noreply identity.

### Required pre-implementation assertions

- V1 report files remain byte-for-byte unchanged.
- Benchmark V2 uses a newly created run root and never recovers the V1 run.
- No provider process is started by unit tests or dry-run validation.

## 6. Phase 1: reduce the handoff prompt

### 6.1 Configuration contract

Update `src/config/schema.ts` with a backward-compatible effective target.

Recommended design:

| Field                      | New repository default | Existing repository behavior                  |
| -------------------------- | ---------------------: | --------------------------------------------- |
| `handoff.maxCharacters`    |                  1,200 | Preserve an explicitly configured lower value |
| `handoff.maxTokens`        |                    300 | Preserve an explicitly configured lower value |
| `handoff.targetCharacters` |                  1,200 | Default to 1,200 when absent                  |
| `handoff.targetTokens`     |                    300 | Default to 300 when absent                    |

The renderer should use the minimum of configured ceilings and target ceilings. Adding defaulted target
fields lets older explicit `4,000`/`1,000` config files adopt compact rendering without silently
rewriting their persisted files. If a smaller implementation provides the same compatibility, prefer
it and document the choice.

Do not raise a user-configured lower ceiling. Do not silently reinterpret a user-configured value as
an exact provider token count.

### 6.2 Render the task exactly once

Replace the current heading-plus-Goal duplication with one task block.

Normalization for duplicate detection should:

1. Collapse whitespace.
2. Trim leading and trailing whitespace.
3. Compare normalized title and normalized original request exactly.

Rendering rule:

| Condition                                                  | Output                                                                                         |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Title equals original request after normalization          | Render one `Task:` line using that text                                                        |
| Original request contains material detail beyond the title | Render one bounded `Task:` item using the original request; do not render the title separately |
| Original request exceeds its item budget                   | Truncate at a Unicode-safe boundary and include a visible truncation marker                    |

The task item has first priority but must not be allowed to consume the entire handoff. Reserve enough
space for a Git anchor, safety line, and at least one `Next` or `Blocker` item when present. Keep the
full original request in the structured capsule.

### 6.3 Remove successor note instructions

Delete this concept from rendered handoff text:

```text
Agents: record high-value updates with relay note ...
```

The successor launch prompt must contain no `relay note` command, generic note placeholder, note-type
list, or request to update Relay state. Note capture belongs to the source lifecycle, not the compact
handoff.

Retain one short safety sentence because the benchmark baseline gets an equivalent instruction:

```text
Inspect the working tree and preserve existing changes.
```

### 6.4 Prioritize sections

Use this prompt-item priority order:

| Priority | Content                                                | Default prompt behavior         |
| -------: | ------------------------------------------------------ | ------------------------------- |
|        1 | Single task representation                             | include once                    |
|        2 | Latest unresolved `next`                               | include                         |
|        3 | Latest unresolved `blocker`                            | include                         |
|        4 | Latest unresolved `rejected`                           | include when space remains      |
|        5 | Latest unresolved `decision` with short rationale      | include when space remains      |
|        6 | Latest unresolved `question`                           | include when space remains      |
|        7 | Latest failed or unknown test relevant to continuation | include when space remains      |
|        8 | Omission count                                         | include only if it fits cheaply |

Do not include these by default:

- `done` notes
- legacy completed work
- passing test history
- changed-file lists
- full Git fingerprint
- full commit hash
- resolved notes
- generic state such as `active` when the launch itself implies it

The structured capsule may continue to carry these fields. A later schema cleanup is optional and must
not block V2.

### 6.5 Compact note formatting

Use concise provenance only when it changes trust. Avoid repeating `[verified]`, timestamps, and
freshness prose on every line.

Recommended text forms:

```text
Next: handle IMF-fixdate validation and clamp past dates.
Blocked: refresh endpoint still returns 401. [changed]
Avoid: parseInt; it accepts malformed numeric prefixes.
Decision: use monotonic time so wall-clock changes cannot revive entries.
```

Keep full provenance, timestamps, note IDs, Git fingerprints, and freshness in JSON. Add `[changed]` or
`[diverged]` to text only when a note is no longer current.

### 6.6 Budget algorithm

The renderer should be deterministic.

1. Compute the effective character and estimated-token ceilings.
2. Reserve the Git anchor and safety line before adding variable items.
3. Add the single task item.
4. Sort unresolved notes newest-first within each type.
5. Add items in the priority order above.
6. Truncate an individual item only when it is mandatory and cannot fit otherwise.
7. Omit lower-priority items instead of truncating every item into unusable fragments.
8. Return omission counts in JSON even if the text omission line cannot fit.
9. Preserve Unicode validity and never emit a replacement character.
10. Verify the final text against both effective ceilings before returning it.

Use a short Git anchor such as `Git: main@4e951db; dirty` in text. Keep the full commit, branch,
fingerprint, status, and changed files in the capsule.

### 6.7 Renderer tests

Update `tests/cli/lifecycle.test.ts` and add focused renderer tests if separating them produces clearer
coverage.

Required cases:

- A one-line request appears exactly once.
- A title that is a prefix of a detailed request does not cause duplication.
- No rendered handoff contains `relay note`.
- Default output is at most 1,200 characters and 300 estimated tokens.
- A typical fixture with next, rejected, decision, done, changed files, and passed tests lands in the
  200-300 estimated-token range or below it without padding.
- `done`, passed tests, and changed-file lists remain in JSON where applicable but are absent from
  default text.
- `next` and `blocker` outrank `decision`, `done`, and changed files.
- Changed/diverged freshness remains visible for rendered notes.
- Long ASCII and Unicode requests remain valid and bounded.
- Very small user-configured ceilings remain respected.
- The switch preview and actual launched prompt use the same captured Git snapshot.

## 7. Phase 2: exclude `.relay/` from ordinary Git status

### 7.1 Storage decision

Use the repository-local Git exclude file, not the tracked project `.gitignore`:

```text
/.relay/
```

This keeps Relay state private to each clone, avoids changing user-owned tracked files, and applies to
ordinary `git status`, not only Relay's internal Git commands.

Resolve the file through Git rather than assuming `.git` is a directory:

```sh
git rev-parse --path-format=absolute --git-path info/exclude
```

This is required for linked worktrees and repositories where `.git` is a file.

### 7.2 Safe helper

Add one reusable helper, preferably near `src/git/repository.ts`, with these guarantees:

1. It obtains the canonical repository root through Git.
2. It obtains the absolute local exclude path through `git rev-parse`.
3. It rejects a symlink or non-regular existing exclude file.
4. It preserves every existing line and the existing file mode.
5. It appends exactly one root-anchored `/.relay/` line.
6. It handles a missing final newline correctly.
7. It is idempotent under repeated calls.
8. It does not edit `.gitignore`, global Git configuration, remotes, branches, or the index.
9. It reports a clear error if local exclusion cannot be installed.

The repository documentation currently says worktree creation is Relay's only Git mutation. Update
that statement to distinguish content/history mutation from the new local metadata exclusion.

### 7.3 Initialization and upgrade repair

Call the helper from `relay init` before creating durable state. If exclusion fails, abort before
writing `.relay/config.json`.

Older repositories also need repair. Invoke the same idempotent helper from the shared entry path for
stateful commands when `.relay/` already exists. Do not rewrite the file after the exact pattern is
present. A warning-only fallback is not sufficient because it recreates benchmark contamination.

Relay's existing pathspec exclusion in `inspectGitSnapshot` should remain as defense in depth.

### 7.4 Exclusion tests

Required integration cases:

- Immediately after `relay init`, plain `git status --porcelain=v1 --untracked-files=all` does not
  show `.relay/`.
- `git check-ignore -q -- .relay/state.json` succeeds after task start.
- Existing `.git/info/exclude` content remains unchanged apart from one appended Relay line.
- Repeated Relay commands do not duplicate the line.
- An older initialized repository missing the line is repaired on its next stateful command.
- A linked worktree resolves the correct exclude path and hides Relay state.
- A symlinked exclude file is rejected rather than followed.
- Ordinary source changes remain visible in Git status.
- No tracked `.gitignore` file is created or modified.

## 8. Phase 3: improve reliable note capture

### 8.1 Reliability definition

Reliable capture means:

- Notes are written in the actual task repository.
- Note types are schema-valid before state mutation.
- Multiple notes are committed atomically to Relay state.
- Every agent-authored note has provider provenance and one captured Git fingerprint.
- Failure is explicit before a successor launch or benchmark call.
- Relay does not silently fabricate notes or scrape private reasoning.

### 8.2 Add an atomic batch path

Keep the existing single-note command for users. Add a machine-oriented stdin command, using a clear
name such as:

```sh
relay note import --stdin --source agent --agent antigravity
```

Accepted stdin schema:

```json
{
  "schemaVersion": 1,
  "notes": [
    {
      "type": "next",
      "text": "Implement IMF-fixdate parsing and clamp past dates."
    },
    {
      "type": "rejected",
      "text": "Do not use parseInt.",
      "reason": "It accepts malformed numeric prefixes."
    }
  ]
}
```

Implementation requirements:

1. Bound stdin before parsing, for example at 16 KiB.
2. Accept at most 20 notes per import.
3. Reuse the existing 500-character text and reason limits.
4. Validate the complete payload before writing any note.
5. Capture one Git snapshot for the entire batch.
6. Write the entire batch through one `updateState` transaction.
7. Reject a changed task/session before committing.
8. Enforce the existing 500-note session limit before writing.
9. Return note IDs, types, and provenance as JSON.
10. Never accept provenance fields from stdin; provenance comes from trusted CLI options.

If Commander subcommand compatibility makes `relay note import` disproportionately invasive, use an
equally explicit machine-only command. Do not overload the current `--json` output flag with input
semantics.

### 8.3 Improve invalid-type diagnostics

Keep the canonical note types:

```text
done, next, decision, rejected, blocker, question
```

Do not silently map ambiguous values such as `progress` or `implementation` to `done`. Instead, return
a concise correction that explains unfinished work belongs in `next` and finished work belongs in
`done`. This prevents false completion data while making retries deterministic.

### 8.4 Keep recording on the source side

Do not place recording instructions in the successor handoff. For the benchmark, the controlled
predecessor phase is the source-side capture contract. Replace open-ended examples with the exact
canonical note types and the atomic import command.

Every predecessor prompt must include:

- The absolute repository path.
- A requirement that all edits, tests, and Relay commands run in that path.
- The exact JSON note schema.
- Expected semantic categories for that fixture.
- A statement that missing notes fail capture rather than being repaired.

For normal product use, add a pre-switch capture check. If there is no unresolved continuation note
of type `next`, `blocker`, `rejected`, `decision`, or `question`, the preview must say that the handoff
contains only Git-recoverable context. Interactive switching should offer a chance to cancel and add a
note. Non-interactive switching should fail unless an explicit `--allow-empty-notes` override is
provided. Keep the existing `--yes` approval requirement separate from this data-quality override.

### 8.5 Capture tests

Required cases:

- A valid batch writes all notes with one shared Git anchor.
- One invalid item rejects the entire batch and writes nothing.
- Oversized stdin and more than 20 items fail before state mutation.
- Agent provenance requires `--agent`; user provenance rejects it.
- A concurrent task/session replacement rejects the batch.
- The 500-note limit is enforced for the final combined count.
- An unsupported type produces the canonical type list and `next`/`done` guidance.
- A switch with no continuation notes warns interactively and fails non-interactively without the
  override.
- A successor prompt contains no note-capture instruction even after the source used batch capture.

## 9. Phase 4: make benchmark V2 uncontaminated

### 9.1 Fresh-run rule

V2 must use a new `handoff-benchmark-*` run root. Do not use `recover.mjs` against V1. Do not copy V1
condition repositories into V2.

### 9.2 Predecessor protocol

For each fixture:

1. Create a fresh Git repository.
2. Run the current built `relay init` and assert ordinary Git status hides `.relay/`.
3. Start Relay with the full task request.
4. Launch the controlled Antigravity predecessor in the absolute repository path.
5. Require the predecessor to implement only the visible phase and use the exact batch note contract.
6. Verify the public phase passes.
7. Verify hidden work remains incomplete without exposing hidden tests to the provider.
8. Validate captured notes against fixture expectations.
9. Create a checkpoint and render the exact handoff once.

Add expected capture fields to `benchmarks/handoff/fixtures/manifest.json`, for example required note
types and required text needles. Validate provider provenance and reject `changed` or `diverged`
freshness at capture time.

If capture validation fails, abort that task before either Codex successor call. Do not synthesize,
copy, or manually insert notes after the predecessor exits.

### 9.3 Physically remove Relay state from both conditions

Create baseline and treatment repositories from the same interrupted source snapshot, including the
same Git history and working-tree changes but excluding:

```text
.relay/
test/hidden.test.js
```

Neither successor needs the benchmark Relay wrapper after successor note instructions are removed.
Do not leave a copy under `.relay/benchmark-bin`.

Before each successor call, assert:

1. `.relay/` does not exist physically.
2. `git status --porcelain=v1 --untracked-files=all` contains no Relay path.
3. The baseline and treatment tracked files, untracked task files, index, HEAD, and diff fingerprint
   are identical.
4. Hidden tests do not exist.
5. The treatment prompt is byte-for-byte equal to `handoff.text` from the single capture.

This is stronger than checking whether provider output mentions `.relay`: the state must be
unavailable.

### 9.4 Prompt fairness

Baseline receives the full request once plus the same preserve-work instruction available to the
treatment:

```text
<full task request>

Inspect the working tree and preserve existing changes. Finish the implementation and run all public tests.
```

Treatment receives only the exact rendered handoff text. Do not append harness-only guidance after
hashing or recording the treatment prompt.

Keep these controls unchanged unless documented in the report:

- Same predecessor checkpoint for both conditions.
- Same Codex model and reasoning effort.
- Ephemeral sessions.
- Sequential execution.
- Alternating condition order by task.
- Same per-command timeout.
- Same public and hidden evaluation after each successor.
- Provider-emitted token metrics only; missing values stay `null`.

### 9.5 Replace the ambiguous Retry-After assertion

Change the far-future date in
`benchmarks/handoff/fixtures/retry-after/hidden/hidden.test.js` from the semantically inconsistent
weekday:

```text
Sun, 06 Nov 2094 08:49:37 GMT
```

to the calendar-correct IMF-fixdate:

```text
Sat, 06 Nov 2094 08:49:37 GMT
```

Then run the reference implementation against all public and hidden tests. Review every hidden fixture
before provider execution and record that review in the V2 report.

### 9.6 Add contamination and budget fields

The V2 result should record at least:

| Field                              | Purpose                               |
| ---------------------------------- | ------------------------------------- |
| `relayStatePresentBeforeSuccessor` | must be `false` for both conditions   |
| `relayPathInGitStatus`             | must be `false` for both conditions   |
| `conditionFingerprintEqual`        | must be `true` before provider calls  |
| `captureValidated`                 | must be `true` before successor calls |
| `capturedNoteTypes`                | documents source-side evidence        |
| `handoff.characters`               | deterministic prompt size             |
| `handoff.estimatedTokens`          | provider-neutral estimate             |
| `handoff.duplicateTaskOccurrences` | must be one                           |
| `handoff.containsNoteInstruction`  | must be `false`                       |
| `prompt.sha256`                    | exact prompt provenance               |

Keep predecessor capture tokens separate from successor paired metrics. State clearly that the V2
experiment measures successor continuation, not total end-to-end workflow cost, unless an additional
control predecessor is introduced.

## 10. Phase 5: validate before paid execution

### Product verification

Run:

```sh
npm test
npm run check
npm run lint
npm run format
npm run build
node --test benchmarks/handoff/lib.test.mjs benchmarks/handoff/recover.test.mjs
node benchmarks/handoff/run.mjs --dry-run
npm run package:check
npm run audit:production
```

Also run focused Git-status integration checks in a normal repository and linked worktree.

### Dry-run acceptance gate

Dry-run must prove all of the following without provider calls:

- Every initial fixture fails its intended public foundation.
- Every reference implementation passes public and hidden tests.
- Retry-After uses a calendar-correct IMF-fixdate.
- Every generated handoff is at most 1,200 characters and 300 estimated tokens.
- Every task request occurs once in treatment text.
- No treatment text contains `relay note`.
- `.relay/` is absent from both successor repositories.
- Baseline and treatment fingerprints match before prompts differ.
- Expected note-capture schemas and manifest assertions parse.
- Expected provider command count is exactly 15 for a five-task execute run.

Do not run `--execute` if any dry-run gate fails.

## 11. Phase 6: execute and report benchmark V2

### Execution authorization

The full run makes 15 provider calls and may consume quota. Ask the user for explicit approval
immediately before running:

```sh
node benchmarks/handoff/run.mjs --execute
```

Confirm `agy` and `codex` authentication, executable paths, model IDs, and command metadata before the
first call. Do not retry ambiguous or partially emitted model runs. Preserve the existing strict
zero-model retry rules if recovery becomes necessary.

### V2 report

Create new dated files under `benchmarks/handoff/reports/`. Do not overwrite V1.

The Markdown report must include:

1. Verdict stated without marketing language.
2. Baseline and treatment correctness.
3. Non-cached successor token totals and paired deltas.
4. Wall-time totals and paired deltas.
5. Per-task handoff characters and estimated tokens.
6. Capture success and captured note types per task.
7. Explicit proof that Relay state was absent from both successor conditions.
8. The original predeclared 3/5 decision-rule result.
9. Any provider failures, retries, missing metrics, or manual causal review.
10. Limitations, including synthetic tasks and exclusion of incremental predecessor capture cost.

Update `benchmarks/handoff/README.md` to link V2 and preserve the V1 negative result as historical
evidence.

## 12. Acceptance criteria

### Product acceptance

- Default handoff text is no more than 300 estimated tokens and 1,200 characters.
- Typical nontrivial handoffs use 200-300 estimated tokens or less without padding.
- The task request appears once.
- Successor prompt contains no note-recording instruction.
- `next`, blocker, rejected approach, and decision rationale outrank Git-recoverable content.
- Full durable data remains available in the structured capsule.
- Plain Git status does not show `.relay/` after initialization or upgrade repair.
- Local exclude installation is safe, idempotent, and tested with worktrees.
- Batch note capture is bounded, validated, atomic, and provenance-aware.
- Empty continuation context is visible before switching.

### Benchmark acceptance

- V2 starts from a fresh run root.
- Five predecessor captures are valid or the run stops before affected successor calls.
- Both successor repositories physically lack `.relay/`.
- Both condition snapshots are identical before prompts differ.
- Hidden tests are absent during model work and reviewed before execution.
- All handoffs satisfy the V2 budget and content checks.
- Exactly 15 intended provider calls are made for a complete five-task run.
- Results use provider-emitted metrics without inferred missing values.
- A new JSON result and Markdown report preserve all caveats.
- The report is published even if Rirei loses.

### Product decision rule

Keep the existing directional benchmark rule for comparability:

> Treatment maintains correctness and reduces non-cached successor tokens or wall time by at least
> 20% on at least 3/5 tasks, with no misleading handoff-caused failure.

Passing this rule supports a larger benchmark. It does not establish statistical significance.

## 13. Expected files

Likely production changes:

- `src/handoff.ts`
- `src/config/schema.ts`
- `src/config/loader.ts`, only if migration support is necessary
- `src/git/repository.ts` or one small local-exclude helper
- `src/cli/init.ts`
- `src/cli/note.ts`
- `src/state/notes.ts`
- `src/cli/switch.ts`
- `src/index.ts` or the shared stateful-command entry point

Likely test changes:

- `tests/cli/lifecycle.test.ts`
- focused Git helper tests under `tests/git/`
- focused state-note tests under `tests/state/`
- `benchmarks/handoff/lib.test.mjs`
- benchmark runner tests, adding a new test file if clearer than extending recovery tests

Likely benchmark and documentation changes:

- `benchmarks/handoff/run.mjs`
- `benchmarks/handoff/lib.mjs`
- `benchmarks/handoff/fixtures/manifest.json`
- `benchmarks/handoff/fixtures/*/phase.md`
- `benchmarks/handoff/fixtures/retry-after/hidden/hidden.test.js`
- `benchmarks/handoff/README.md`
- new dated V2 files under `benchmarks/handoff/reports/`
- `docs/checkpoints-and-handoff.md`
- `docs/configuration.md`
- `docs/cli-reference.md`
- `docs/security.md`
- `docs/development.md`
- `docs/changelog.md`
- `README.md` only if public behavior claims need correction

This list is directional. Prefer the smallest correct implementation and do not touch unrelated dirty
files.

## 14. Implementation order

1. Add failing handoff-content and budget tests.
2. Implement compact rendering and effective defaults.
3. Add local Git exclusion and upgrade repair with integration tests.
4. Add atomic note import and source-capture validation.
5. Add the empty-continuation switch gate.
6. Redesign benchmark copying so both successor repositories exclude `.relay/`.
7. Fix and review the Retry-After hidden assertion.
8. Add dry-run contamination, equality, note-capture, and budget gates.
9. Run all local verification and inspect the complete diff.
10. Ask for paid-run approval.
11. Execute V2 without reusing V1 repositories.
12. Analyze and publish the V2 report honestly.

## 15. Next-agent prompt

Use this prompt verbatim for the implementation agent:

```text
Implement the Handoff V2 plan in `docs/handoff-v2-plan.md` end to end.

Start by reading the plan, `src/handoff.ts`, `src/config/schema.ts`, `src/git/repository.ts`, `src/cli/init.ts`, `src/cli/note.ts`, `src/state/notes.ts`, `src/cli/switch.ts`, `tests/cli/lifecycle.test.ts`, `benchmarks/handoff/run.mjs`, `benchmarks/handoff/lib.mjs`, `benchmarks/handoff/README.md`, and `benchmarks/handoff/reports/2026-08-11.md`. Inspect `git status` and existing diffs first. The worktree is dirty: preserve all existing user changes, do not revert unrelated files, do not overwrite the V1 benchmark report, and do not commit unless explicitly asked.

Required outcomes:

1. Reduce the default outbound handoff to at most 300 estimated tokens and 1,200 characters, normally 200-300 tokens or less without padding.
2. Render the task exactly once. Keep the full structured capsule, but omit done work, passing tests, changed-file lists, and other Git-recoverable details from default text.
3. Remove every successor note-recording instruction from handoff text.
4. Safely and idempotently add `/.relay/` to the repository-local Git exclude file using `git rev-parse --path-format=absolute --git-path info/exclude`. Apply it during init and repair older initialized repositories. Preserve existing exclude contents, reject symlinks, support linked worktrees, and leave tracked `.gitignore` files untouched.
5. Improve note capture with a bounded, schema-validated, atomic stdin batch command. Capture one Git snapshot per batch, enforce provenance and note limits, and reject the whole batch on any invalid item. Do not silently map ambiguous note types.
6. Add a pre-switch data-quality gate when no unresolved next/blocker/rejected/decision/question note exists. Keep this separate from launch approval and provide an explicit non-interactive override.
7. Clean benchmark V2: use exact source-side note instructions, absolute predecessor repository paths, and a capture validation gate. Abort before successor calls if capture is missing or invalid.
8. Build both successor repositories from the same interrupted snapshot while physically excluding `.relay/` and hidden tests from both. Assert repository equality, Relay-state absence, clean Git status, exact treatment-prompt hashing, and no successor note instruction before any model call.
9. Correct the Retry-After hidden future date from `Sun, 06 Nov 2094` to `Sat, 06 Nov 2094`, then validate all reference fixtures.
10. Add or update tests for every acceptance criterion in the plan. Update behavior documentation and the benchmark protocol.

Use the smallest correct changes. Do not infer or fabricate semantic notes. Do not claim exact provider token counts where only Relay's estimate exists. Do not expose credentials, provider logs, raw conversations, `.relay/` state, or private paths in published reports.

Run `npm test`, `npm run check`, `npm run lint`, `npm run format`, `npm run build`, `node --test benchmarks/handoff/lib.test.mjs benchmarks/handoff/recover.test.mjs`, `node benchmarks/handoff/run.mjs --dry-run`, `npm run package:check`, and `npm run audit:production`. Fix all failures caused by the changes.

After local verification, summarize the changed files, exact test results, generated handoff sizes, Git-exclusion proof, and dry-run benchmark gates. Before `node benchmarks/handoff/run.mjs --execute`, stop and ask the user for explicit approval because the complete run makes 15 provider calls and consumes quota. Once approved, run V2 from a fresh run root, do not recover or reuse V1, save new dated JSON and Markdown reports, update the benchmark README, and report the result honestly even if Rirei loses.
```
