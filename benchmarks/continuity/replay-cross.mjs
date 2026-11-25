import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadContinuityContext } from '../../src/context/render.ts';
import {
  contextEventSchema,
  contextObservationSchema,
} from '../../src/context/schema.ts';
import { readContextJournal } from '../../src/context/store.ts';
import { fingerprint, WORKFLOWS } from './workflows.mjs';

const json = async (file) => JSON.parse(await readFile(file, 'utf8'));
const countRequirements = (prompt, requirements) =>
  requirements.filter(
    (text) =>
      prompt.includes(text) ||
      prompt.includes(JSON.stringify(text).slice(1, -1)),
  ).length;

/** Re-render saved evidence only. Does not modify candidates or invoke providers/graders. */
export async function replayCross(runRoot) {
  const source = await readFile(path.join(runRoot, 'report.json'));
  const report = JSON.parse(source);
  assert.equal(report.mode, 'real-bidirectional-predecessor-pilot');
  const rows = [];
  for (const row of report.cases) {
    assert.match(row.task, /^[a-z0-9-]+$/);
    assert.ok(['claude', 'codex'].includes(row.predecessor.provider));
    assert.ok(['claude', 'codex'].includes(row.receiver));
    assert.ok(Number.isSafeInteger(row.index) && row.index >= 0);
    const task = WORKFLOWS.find((task) => task.id === row.task);
    assert.ok(task);
    const arm = row.arms.find((arm) => arm.arm === 'rirei');
    assert.ok(arm);
    const base = path.join(
      runRoot,
      `case-${row.index}-${row.task}-${row.predecessor.provider}-to-${row.receiver}`,
    );
    const frozen = (await json(path.join(base, 'frozen-history.json'))).map(
      (event) => contextEventSchema.parse(event),
    );
    assert.equal(
      fingerprint(
        JSON.stringify(
          frozen.map((event) => contextObservationSchema.parse(event)),
        ),
      ),
      row.historyHash,
    );
    const workspace = path.join(base, 'rirei');
    const state = await json(path.join(workspace, '.relay/state.json'));
    const beforeJournal = await readContextJournal(workspace, state.sessionId);
    assert.equal(
      fingerprint(
        JSON.stringify(
          beforeJournal.events.map((event) =>
            contextObservationSchema.parse(event),
          ),
        ),
      ),
      row.historyHash,
    );
    const before = await readFile(
      path.join(base, 'rirei-artifacts/prompt.txt'),
      'utf8',
    );
    assert.equal(fingerprint(before), arm.execution.promptHash);
    const boundary = before.indexOf('CONTINUATION BRIEFING');
    assert.ok(boundary >= 0);
    // All saved checkpoints differ from their predecessor capture launch anchor.
    const briefing = await loadContinuityContext(
      workspace,
      state.sessionId,
      workspace,
      'offline-replay-changed-worktree',
    );
    assert.ok(briefing);
    const after = before.slice(0, boundary) + briefing.text;
    const submissions = beforeJournal.events.filter(
      (event) => event.kind === 'prompt_submission',
    );
    for (const event of submissions) {
      assert.ok(
        briefing.selectedEvidence.some(
          (excerpt) =>
            excerpt.eventId === event.id &&
            excerpt.start === 0 &&
            excerpt.end === event.text.length &&
            excerpt.text === event.text,
        ),
      );
    }
    assert.equal(briefing.submissionCoverage.requiredSourceIds.length, 0);
    assert.equal(
      countRequirements(after, task.requirements),
      task.requirements.length,
    );
    assert.equal(after.includes(path.join(base, 'predecessor')), false);
    assert.equal(
      (await readContextJournal(workspace, state.sessionId)).digest,
      beforeJournal.digest,
    );
    rows.push({
      caseIndex: row.index,
      task: row.task,
      direction: `${row.predecessor.provider}-to-${row.receiver}`,
      originalLiveCorrect: arm.correct,
      newLiveCorrect: null,
      historyHash: row.historyHash,
      originalPromptHash: fingerprint(before),
      candidatePromptHash: fingerprint(after),
      originalPromptCharacters: before.length,
      candidatePromptCharacters: after.length,
      candidateBriefingCharacters: briefing.text.length,
      requirementCount: task.requirements.length,
      originalExactRequirementsInline: countRequirements(
        before,
        task.requirements,
      ),
      candidateExactRequirementsInline: countRequirements(
        after,
        task.requirements,
      ),
      submittedMessagesFullyInline: briefing.submissionCoverage.fullyInlined,
      submittedMessageCount: submissions.length,
      historicalPredecessorPathInPreview: after.includes(
        path.join(base, 'predecessor'),
      ),
      currentWorkspaceExplicit: briefing.text.includes(
        JSON.stringify(workspace),
      ),
      sourceJournalUnchanged: true,
    });
  }
  assert.equal(
    fingerprint(await readFile(path.join(runRoot, 'report.json'))),
    fingerprint(source),
  );
  const here = path.dirname(fileURLToPath(import.meta.url));
  return {
    schemaVersion: 1,
    mode: 'offline-requirement-preservation-replay',
    providerSessions: 0,
    originalReportHash: fingerprint(source),
    candidateSourceHashes: Object.fromEntries(
      await Promise.all(
        [
          '../../src/context/briefing.ts',
          '../../src/context/render.ts',
          '../../src/context/paths.ts',
          '../../src/cli/context.ts',
          'replay-cross.mjs',
        ].map(async (name) => [
          name,
          fingerprint(await readFile(path.resolve(here, name))),
        ]),
      ),
    ),
    rows,
    limitations: [
      'Source-preservation and preview checks only; no new model continuations or token/cost measurements.',
      'The original live correctness results remain unchanged. New live correctness is unknown.',
      'Path suppression is a display heuristic, not a filesystem sandbox; complete source records remain exact.',
    ],
  };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const { values } = parseArgs({
    options: {
      'run-root': { type: 'string' },
      'output-directory': { type: 'string' },
    },
  });
  if (!values['run-root']) throw new Error('--run-root is required.');
  const result = await replayCross(path.resolve(values['run-root']));
  const serialized = JSON.stringify(result, null, 2) + '\n';
  assert.doesNotMatch(
    serialized,
    /\/Users\/|\/private\/var\/|\/home\/|[A-Za-z]:\\/,
  );
  if (values['output-directory']) {
    const destination = path.resolve(values['output-directory']);
    await mkdir(destination, { mode: 0o700 });
    await writeFile(path.join(destination, 'replay.json'), serialized, {
      mode: 0o600,
    });
  }
  process.stdout.write(serialized);
}
