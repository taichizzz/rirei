import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { promisify } from 'node:util';
import {
  assertCleanSuccessor,
  copyWorktree,
  createRelayWrapper,
  handoffContentChecks,
  loadTasks,
  markdownReport,
  publicationResult,
  repositoryFingerprint,
  runDryTask,
  validateCapturedNotes,
} from './run.mjs';

const execFileAsync = promisify(execFile);
const directories = [];

async function removeAll() {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
}

async function gitRepo() {
  const directory = await mkdtemp(path.join(tmpdir(), 'handoff-v2-test-'));
  directories.push(directory);
  await execFileAsync('git', ['init', '--initial-branch=main'], {
    cwd: directory,
  });
  await execFileAsync('git', ['config', 'user.email', 'test@example.invalid'], {
    cwd: directory,
  });
  await execFileAsync('git', ['config', 'user.name', 'Handoff V2 Test'], {
    cwd: directory,
  });
  await mkdir(path.join(directory, 'src'), { recursive: true });
  await writeFile(
    path.join(directory, 'src', 'index.js'),
    'module.exports = 1;\n',
  );
  await execFileAsync('git', ['add', '--all'], { cwd: directory });
  await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: directory });
  return directory;
}

function task(id) {
  return {
    id,
    title: id,
    request:
      'Implement src/index.js: accept integer and IMF-fixdate values and clamp.',
    expectedNotes: {
      requiredTypes: ['done', 'rejected', 'next'],
      needles: { rejected: 'parseInt', next: 'IMF-fixdate' },
    },
  };
}

const handoff = (overrides = {}) => {
  const base = {
    text: 'Task: Implement retry parsing\n\nInspect the working tree and preserve existing changes.',
    budget: { estimatedTokens: 40 },
    capsule: {
      notes: [
        {
          type: 'done',
          text: 'Foundation',
          provenance: { source: 'agent', agent: 'antigravity' },
          freshness: 'current',
        },
        {
          type: 'rejected',
          text: 'parseInt accepts junk prefixes',
          provenance: { source: 'agent', agent: 'antigravity' },
          freshness: 'current',
        },
        {
          type: 'next',
          text: 'Implement IMF-fixdate parsing',
          provenance: { source: 'agent', agent: 'antigravity' },
          freshness: 'current',
        },
      ],
    },
  };
  const value = { ...base, ...overrides };
  return {
    ...value,
    capsule: {
      ...value.capsule,
      notes: (value.capsule?.notes ?? []).map((note) => ({
        createdAt: '2026-01-01T00:00:00.000Z',
        git: {
          commit: 'abc1234',
          branch: 'main',
          fingerprint: 'f'.repeat(64),
        },
        ...note,
      })),
    },
  };
};

test.afterEach(removeAll);

test('copyWorktree excludes .relay and hidden tests by default', async () => {
  const source = await gitRepo();
  await mkdir(path.join(source, '.relay'));
  await writeFile(path.join(source, '.relay', 'state.json'), '{}');
  await mkdir(path.join(source, 'test'));
  await writeFile(path.join(source, 'test', 'hidden.test.js'), 'hidden\n');
  await writeFile(path.join(source, 'test', 'public.test.js'), 'public\n');
  const destination = await mkdtemp(path.join(tmpdir(), 'handoff-v2-copy-'));
  directories.push(destination);
  await copyWorktree(source, destination);
  await assert.rejects(
    import('node:fs/promises').then((fs) =>
      fs.access(path.join(destination, '.relay', 'state.json')),
    ),
  );
  await assert.rejects(
    import('node:fs/promises').then((fs) =>
      fs.access(path.join(destination, 'test', 'hidden.test.js')),
    ),
  );
  await import('node:fs/promises').then((fs) =>
    fs.access(path.join(destination, 'test', 'public.test.js')),
  );
});

test('copyWorktree can retain .relay explicitly for recovery paths', async () => {
  const source = await gitRepo();
  await mkdir(path.join(source, '.relay'));
  await writeFile(path.join(source, '.relay', 'state.json'), '{}');
  const destination = await mkdtemp(path.join(tmpdir(), 'handoff-v2-copy-'));
  directories.push(destination);
  await copyWorktree(source, destination, { includeRelay: true });
  await import('node:fs/promises').then((fs) =>
    fs.access(path.join(destination, '.relay', 'state.json')),
  );
});

test('repositoryFingerprint covers content, modes, HEAD, and index but ignores relay state', async () => {
  const repo = await gitRepo();
  const first = await repositoryFingerprint(repo);
  await mkdir(path.join(repo, '.relay'));
  await writeFile(path.join(repo, '.relay', 'state.json'), '{}');
  const second = await repositoryFingerprint(repo);
  assert.equal(second, first);
  await writeFile(path.join(repo, 'note.txt'), 'change\n');
  const untracked = await repositoryFingerprint(repo);
  assert.notEqual(untracked, first);
  await execFileAsync('git', ['add', 'note.txt'], { cwd: repo });
  const staged = await repositoryFingerprint(repo);
  assert.notEqual(staged, untracked);
  await execFileAsync('git', ['commit', '-m', 'note'], { cwd: repo });
  const committed = await repositoryFingerprint(repo);
  assert.notEqual(committed, staged);
  await chmod(path.join(repo, 'src', 'index.js'), 0o755);
  const modeChanged = await repositoryFingerprint(repo);
  assert.notEqual(modeChanged, committed);
});

test('handoffContentChecks counts request occurrences and note instructions', () => {
  const taskValue = task('retry-after');
  const exact = handoffContentChecks(
    handoff({
      text: `Task: ${taskValue.request}\n\nNext: finish`,
    }),
    taskValue,
  );
  assert.equal(exact.duplicateTaskOccurrences, 1);
  assert.equal(exact.containsNoteInstruction, false);

  const duplicated = handoffContentChecks(
    handoff({
      text: `Task: ${taskValue.request}\n\n${taskValue.request}\n\nrelay note next "x"`,
    }),
    taskValue,
  );
  assert.equal(duplicated.duplicateTaskOccurrences, 2);
  assert.equal(duplicated.containsNoteInstruction, true);
});

test('publicationResult removes private paths and raw prompts', () => {
  const command = {
    executable: 'codex',
    args: ['exec', '--model', 'model-id', 'private prompt /private/task'],
    cwd: '/private/task',
    policy: { sandbox: true },
  };
  const published = publicationResult({
    schemaVersion: 1,
    runRoot: '/private/run',
    relayBundle: '/Users/example/project/dist/index.cjs',
    preflight: {
      codex: {
        executable: '/Users/example/bin/codex',
        model: 'model-id',
        authenticationChecked: true,
      },
    },
    tasks: [
      {
        predecessor: { command },
        conditions: { baseline: { command }, treatment: { command } },
      },
    ],
  });
  const json = JSON.stringify(published);
  assert.doesNotMatch(json, /\/private\/|\/Users\/|private prompt/);
  assert.equal(published.preflight.codex.executable, 'codex');
  assert.deepEqual(published.tasks[0].conditions.treatment.command, {
    executable: 'codex',
    model: 'model-id',
    policy: { sandbox: true },
  });
});

test('archived V2 publication is private and satisfies the report contract', async () => {
  const reportRoot = new URL('./reports/', import.meta.url);
  const [resultText, analysisText, report] = await Promise.all([
    readFile(new URL('2026-08-11-v2.json', reportRoot), 'utf8'),
    readFile(new URL('2026-08-11-v2.analysis.json', reportRoot), 'utf8'),
    readFile(new URL('2026-08-11-v2.md', reportRoot), 'utf8'),
  ]);
  assert.doesNotMatch(
    resultText,
    /\/Users\/|\/private\/|"args"|"cwd"|Repository safety requirement/,
  );
  const regenerated = markdownReport(
    JSON.parse(resultText),
    JSON.parse(analysisText),
  );
  for (const heading of [
    '## Verdict',
    '## Paired results',
    '## Totals',
    '## Correctness',
    '## Capture and integrity',
    '## Provider execution',
    '## Limitations',
  ])
    for (const value of [report, regenerated])
      assert.match(value, new RegExp(`^${heading}`, 'm'));
  assert.match(report, /baseline 85515; treatment 78402/);
  assert.match(
    report,
    /historical run predates full HEAD\/index\/diff equality/,
  );
});

test('final hardened V2 archive passes privacy and integrity checks', async () => {
  const reportRoot = new URL('./reports/', import.meta.url);
  const [resultText, analysisText, report] = await Promise.all([
    readFile(new URL('2026-08-12-v2.json', reportRoot), 'utf8'),
    readFile(new URL('2026-08-12-v2.analysis.json', reportRoot), 'utf8'),
    readFile(new URL('2026-08-12-v2.md', reportRoot), 'utf8'),
  ]);
  assert.doesNotMatch(
    resultText,
    /\/Users\/|\/private\/|"args"|"cwd"|"authenticated"|Repository safety requirement/,
  );
  const result = JSON.parse(resultText);
  const analysis = JSON.parse(analysisText);
  assert.equal(result.integrityVersion, 'v2-full-git-state-v1');
  assert.equal(result.providerCommandCount, 15);
  assert.equal(result.dryRunValidation.length, 5);
  assert.equal(analysis.summary.successCounts.baseline, 5);
  assert.equal(analysis.summary.successCounts.treatment, 5);
  assert.equal(analysis.summary.improvedTasks, 1);
  assert.equal(analysis.summary.decisionRule.passed, false);
  assert.ok(
    result.tasks.every(
      (task) =>
        task.capture.validated &&
        task.handoff.duplicateTaskOccurrences === 1 &&
        !task.handoff.containsNoteInstruction &&
        task.conditions.treatment.prompt.matchesCapturedHandoff === true &&
        Object.values(task.conditions).every(
          (condition) =>
            !condition.relayStatePresentBeforeSuccessor &&
            !condition.relayPathInGitStatus &&
            condition.conditionFingerprintEqual,
        ),
    ),
  );
  assert.match(report, /baseline 87455; treatment 101008/);
  assert.match(report, /Decision rule passed: false/);
});

test('validateCapturedNotes accepts compliant captures and rejects gaps', () => {
  const taskValue = task('retry-after');
  const valid = validateCapturedNotes(handoff(), taskValue);
  assert.equal(valid.validated, true);
  assert.deepEqual(valid.noteTypes, ['done', 'next', 'rejected']);
  assert.equal(valid.count, 3);

  const missing = validateCapturedNotes(
    handoff({ capsule: { notes: [] } }),
    taskValue,
  );
  assert.equal(missing.validated, false);
  assert.match(missing.failures.join('; '), /missing note type: done/);
  assert.match(missing.failures.join('; '), /missing note type: rejected/);
  assert.match(missing.failures.join('; '), /missing note type: next/);

  const wrongNeedle = validateCapturedNotes(
    handoff({
      capsule: {
        notes: [
          {
            type: 'rejected',
            text: 'numeric coercion is unsafe',
            provenance: { source: 'agent', agent: 'antigravity' },
            freshness: 'current',
          },
          {
            type: 'done',
            text: 'Foundation',
            provenance: { source: 'agent', agent: 'antigravity' },
            freshness: 'current',
          },
          {
            type: 'next',
            text: 'Implement IMF-fixdate parsing',
            provenance: { source: 'agent', agent: 'antigravity' },
            freshness: 'current',
          },
        ],
      },
    }),
    taskValue,
  );
  assert.equal(wrongNeedle.validated, false);
  assert.match(
    wrongNeedle.failures.join('; '),
    /no rejected note containing "parseInt"/,
  );

  const badProvenance = validateCapturedNotes(
    handoff({
      capsule: {
        notes: [
          {
            type: 'rejected',
            text: 'parseInt accepts junk prefixes',
            provenance: { source: 'user', recordedBy: 'relay-cli' },
            freshness: 'current',
          },
          {
            type: 'done',
            text: 'Foundation',
            provenance: { source: 'agent', agent: 'antigravity' },
            freshness: 'current',
          },
          {
            type: 'next',
            text: 'Implement IMF-fixdate parsing',
            provenance: { source: 'agent', agent: 'antigravity' },
            freshness: 'current',
          },
        ],
      },
    }),
    taskValue,
  );
  assert.equal(badProvenance.validated, false);
  assert.match(
    badProvenance.failures.join('; '),
    /lack antigravity agent provenance/,
  );

  const stale = validateCapturedNotes(
    handoff({
      capsule: {
        notes: [
          {
            type: 'rejected',
            text: 'parseInt accepts junk prefixes',
            provenance: { source: 'agent', agent: 'antigravity' },
            freshness: 'diverged',
          },
          {
            type: 'done',
            text: 'Foundation',
            provenance: { source: 'agent', agent: 'antigravity' },
            freshness: 'current',
          },
          {
            type: 'next',
            text: 'Implement IMF-fixdate parsing',
            provenance: { source: 'agent', agent: 'antigravity' },
            freshness: 'current',
          },
        ],
      },
    }),
    taskValue,
  );
  assert.equal(stale.validated, false);
  assert.match(stale.failures.join('; '), /not current/);

  const splitBatch = handoff();
  splitBatch.capsule.notes[1].git = {
    ...splitBatch.capsule.notes[1].git,
    fingerprint: 'a'.repeat(64),
  };
  const mismatchedAnchor = validateCapturedNotes(splitBatch, taskValue);
  assert.equal(mismatchedAnchor.validated, false);
  assert.match(mismatchedAnchor.failures.join('; '), /batch Git anchor/);
});

test('assertCleanSuccessor rejects relay presence, hidden tests, and mismatch', async () => {
  const repo = await gitRepo();
  const expectedFingerprint = await repositoryFingerprint(repo);
  const taskRoot = await mkdtemp(path.join(tmpdir(), 'handoff-v2-gates-'));
  directories.push(taskRoot);
  const options = {
    repo,
    expectedFingerprint,
    condition: 'baseline',
    taskRoot,
    timeoutMs: 30_000,
  };
  const clean = await assertCleanSuccessor(options);
  assert.equal(clean.relayStatePresentBeforeSuccessor, false);
  assert.equal(clean.relayPathInGitStatus, false);
  assert.equal(clean.conditionFingerprintEqual, true);

  await mkdir(path.join(repo, '.relay'));
  await writeFile(path.join(repo, '.relay', 'state.json'), '{}');
  await assert.rejects(
    assertCleanSuccessor(options),
    /\.relay\/ must not exist/,
  );

  await rm(path.join(repo, '.relay'), { recursive: true, force: true });
  await writeFile(path.join(repo, 'dirty.txt'), 'change\n');
  await assert.rejects(
    assertCleanSuccessor(options),
    /differs from the pristine predecessor copy/,
  );
});

test('runDryTask applies the full dry-run gate on a real relay build', async () => {
  await import('node:fs/promises').then((fs) =>
    fs.access(fileURLToPath(new URL('../../dist/index.cjs', import.meta.url))),
  );
  const runRoot = await mkdtemp(path.join(tmpdir(), 'handoff-v2-dryrun-'));
  directories.push(runRoot);
  const relayBin = await createRelayWrapper(runRoot);
  const tasks = await loadTasks();
  const task = tasks.find((candidate) => candidate.id === 'retry-after');
  assert.ok(task, 'retry-after fixture must be present');
  const taskRoot = path.join(runRoot, 'task-retry-after');
  await mkdir(taskRoot);
  const result = await runDryTask(task, taskRoot, relayBin, 60_000);
  assert.equal(result.initialPublicFailedAsExpected, true);
  assert.equal(result.referencePublicPassed, true);
  assert.equal(result.referencePublicAndHiddenPassed, true);
  assert.equal(result.relayHiddenAfterInit, true);
  assert.equal(result.relayExcludedAfterStart, true);
  assert.equal(result.captureValidated, true);
  assert.equal(
    result.successorGates.baseline.fingerprint,
    result.successorGates.treatment.fingerprint,
  );
  assert.equal(result.handoff.duplicateTaskOccurrences, 1);
  assert.equal(result.handoff.containsNoteInstruction, false);
  assert.ok(
    result.handoff.estimatedTokens <= 300,
    `expected <=300 est. tokens, got ${result.handoff.estimatedTokens}`,
  );
  assert.ok(
    result.handoff.characters <= 1_200,
    `expected <=1,200 characters, got ${result.handoff.characters}`,
  );
});
