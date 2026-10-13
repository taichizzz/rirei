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
  renderHandoffForBudget,
  repositoryFingerprint,
  runCondition,
  runDryTask,
  validateCapturedNotes,
} from './run.mjs';
import {
  aggregateResults,
  detectIdenticalPrompts,
  HANDOFF_BUDGETS,
  hashPrompt,
} from './lib.mjs';

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
  assert.equal(
    result.successorGates.baseline.fingerprint,
    result.successorGates['handoff-with-notes'].fingerprint,
  );
  assert.equal(
    result.successorGates.baseline.fingerprint,
    result.successorGates['handoff-no-notes'].fingerprint,
  );
  assert.equal(
    result.successorGates.baseline.fingerprint,
    result.successorGates['handoff-300'].fingerprint,
  );
  assert.equal(
    result.successorGates.baseline.fingerprint,
    result.successorGates['handoff-800'].fingerprint,
  );
  assert.equal(
    result.successorGates.baseline.fingerprint,
    result.successorGates['handoff-2000'].fingerprint,
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
  assert.equal(typeof result.handoff.sha256, 'string');
  assert.equal(result.handoff.sha256.length, 64);
  assert.ok(result.handoffNoNotes);
  assert.equal(result.handoffNoNotes.duplicateTaskOccurrences, 1);
  assert.equal(result.handoffNoNotes.containsNoteInstruction, false);
  assert.ok(
    result.handoffNoNotes.estimatedTokens <= 300,
    `expected <=300 est. tokens for no-notes, got ${result.handoffNoNotes.estimatedTokens}`,
  );
  assert.ok(
    result.handoffNoNotes.characters <= 1_200,
    `expected <=1,200 characters for no-notes, got ${result.handoffNoNotes.characters}`,
  );

  assert.ok(result.budgets, 'result.budgets must be defined');
  assert.deepEqual(
    Object.keys(result.budgets)
      .map(Number)
      .sort((a, b) => a - b),
    HANDOFF_BUDGETS,
  );
  for (const budget of HANDOFF_BUDGETS) {
    const b = result.budgets[budget];
    assert.equal(b.budget, budget);
    assert.equal(b.maxTokens, budget);
    assert.equal(b.maxCharacters, 4 * budget);
    assert.ok(
      b.characters <= 4 * budget,
      `budget ${budget} chars (${b.characters}) <= ${4 * budget}`,
    );
    assert.ok(
      b.estimatedTokens <= budget,
      `budget ${budget} tokens (${b.estimatedTokens}) <= ${budget}`,
    );
    assert.equal(typeof b.sha256, 'string');
    assert.equal(b.sha256.length, 64);
    assert.equal(b.duplicateTaskOccurrences, 1);
    assert.equal(b.containsNoteInstruction, false);
    assert.equal(typeof b.isDuplicate, 'boolean');
  }
  assert.equal(result.budgets[300].isDuplicate, false);
  assert.equal(result.budgets[300].identicalTo, null);
  assert.equal(result.budgets[800].isDuplicate, true);
  assert.equal(result.budgets[800].identicalTo, 300);
  assert.equal(result.budgets[2000].isDuplicate, true);
  assert.equal(result.budgets[2000].identicalTo, 300);
});

test('renderHandoffForBudget configures token and character limits proportionally', async () => {
  await import('node:fs/promises').then((fs) =>
    fs.access(fileURLToPath(new URL('../../dist/index.cjs', import.meta.url))),
  );
  const runRoot = await mkdtemp(path.join(tmpdir(), 'handoff-v2-budget-'));
  directories.push(runRoot);
  const relayBin = await createRelayWrapper(runRoot);
  const taskRoot = path.join(runRoot, 'budget-task');
  await mkdir(taskRoot);
  const repo = await gitRepo();

  const { relayCommand } = await import('./run.mjs');
  await relayCommand({
    args: ['init'],
    cwd: repo,
    relayBin,
    timeoutMs: 30_000,
    logDirectory: path.join(taskRoot, 'logs', 'relay-init'),
  });
  await relayCommand({
    args: ['start', 'Test budget request with ample length to measure limits.'],
    cwd: repo,
    relayBin,
    timeoutMs: 30_000,
    logDirectory: path.join(taskRoot, 'logs', 'relay-start'),
  });

  for (const budget of HANDOFF_BUDGETS) {
    const rendered = await renderHandoffForBudget({
      repo,
      budget,
      relayBin,
      timeoutMs: 30_000,
      logDirectory: path.join(taskRoot, 'logs', `budget-${budget}`),
      taskRoot,
    });
    assert.equal(rendered.budget.maxTokens, budget);
    assert.equal(rendered.budget.maxCharacters, 4 * budget);
    assert.ok(
      rendered.budget.usedCharacters <= 4 * budget,
      `expected <= ${4 * budget} used chars, got ${rendered.budget.usedCharacters}`,
    );
    assert.ok(
      rendered.budget.estimatedTokens <= budget,
      `expected <= ${budget} est tokens, got ${rendered.budget.estimatedTokens}`,
    );
  }
});

test('renderHandoffForBudget produces distinct prompts across budgets for rich handoffs', async () => {
  await import('node:fs/promises').then((fs) =>
    fs.access(fileURLToPath(new URL('../../dist/index.cjs', import.meta.url))),
  );
  const runRoot = await mkdtemp(path.join(tmpdir(), 'handoff-v2-rich-budget-'));
  directories.push(runRoot);
  const relayBin = await createRelayWrapper(runRoot);
  const taskRoot = path.join(runRoot, 'rich-budget-task');
  await mkdir(taskRoot);
  const repo = await gitRepo();

  const { relayCommand } = await import('./run.mjs');
  await relayCommand({
    args: ['init'],
    cwd: repo,
    relayBin,
    timeoutMs: 30_000,
    logDirectory: path.join(taskRoot, 'logs', 'relay-init'),
  });
  await relayCommand({
    args: [
      'start',
      'Architect and build an adaptive rate-limiting and circuit-breaking engine with sliding-window telemetry and token-bucket replenishment.',
    ],
    cwd: repo,
    relayBin,
    timeoutMs: 30_000,
    logDirectory: path.join(taskRoot, 'logs', 'relay-start'),
  });

  const types = ['next', 'blocker', 'rejected', 'decision', 'question'];
  const notes = [];
  for (let i = 0; i < 20; i += 1) {
    notes.push({
      type: types[i % types.length],
      text: `Architectural specification item ${i + 1}: detailed explanation of behavior, failure recovery protocols, edge-case validation, bounded buffer constraints, and invariants for subsystem component ${i + 1}.`,
    });
  }

  await relayCommand({
    args: [
      'note',
      'import',
      '--stdin',
      '--source',
      'agent',
      '--agent',
      'antigravity',
    ],
    cwd: repo,
    relayBin,
    timeoutMs: 30_000,
    logDirectory: path.join(taskRoot, 'logs', 'relay-import'),
    stdin: `${JSON.stringify({ schemaVersion: 1, notes })}\n`,
  });

  const budgetHandoffs = {};
  for (const budget of HANDOFF_BUDGETS) {
    budgetHandoffs[budget] = await renderHandoffForBudget({
      repo,
      budget,
      relayBin,
      timeoutMs: 30_000,
      logDirectory: path.join(taskRoot, 'logs', `budget-${budget}`),
      taskRoot,
    });
  }

  const h300 = budgetHandoffs[300];
  const h800 = budgetHandoffs[800];
  const h2000 = budgetHandoffs[2000];

  // Distinct prompts generated across all 3 budgets
  assert.notEqual(h300.text, h800.text);
  assert.notEqual(h800.text, h2000.text);
  assert.notEqual(h300.text, h2000.text);

  // Strictly increasing character and estimated token counts
  assert.ok(
    h300.budget.usedCharacters < h800.budget.usedCharacters,
    `300 chars (${h300.budget.usedCharacters}) < 800 chars (${h800.budget.usedCharacters})`,
  );
  assert.ok(
    h800.budget.usedCharacters < h2000.budget.usedCharacters,
    `800 chars (${h800.budget.usedCharacters}) < 2000 chars (${h2000.budget.usedCharacters})`,
  );
  assert.ok(
    h300.budget.estimatedTokens < h800.budget.estimatedTokens,
    `300 tokens (${h300.budget.estimatedTokens}) < 800 tokens (${h800.budget.estimatedTokens})`,
  );
  assert.ok(
    h800.budget.estimatedTokens < h2000.budget.estimatedTokens,
    `800 tokens (${h800.budget.estimatedTokens}) < 2000 tokens (${h2000.budget.estimatedTokens})`,
  );

  // Strictly decreasing omitted items (2000 fits everything)
  assert.ok(
    h300.budget.omittedItems > h800.budget.omittedItems,
    `300 omitted (${h300.budget.omittedItems}) > 800 omitted (${h800.budget.omittedItems})`,
  );
  assert.ok(
    h800.budget.omittedItems > h2000.budget.omittedItems,
    `800 omitted (${h800.budget.omittedItems}) > 2000 omitted (${h2000.budget.omittedItems})`,
  );
  assert.equal(h2000.budget.omittedItems, 0);

  // Respective limits respected
  for (const budget of HANDOFF_BUDGETS) {
    const h = budgetHandoffs[budget];
    assert.ok(
      h.budget.usedCharacters <= 4 * budget,
      `budget ${budget} chars <= ${4 * budget}`,
    );
    assert.ok(
      h.budget.estimatedTokens <= budget,
      `budget ${budget} tokens <= ${budget}`,
    );
  }

  // Hashes are distinct
  const hash300 = hashPrompt(h300.text);
  const hash800 = hashPrompt(h800.text);
  const hash2000 = hashPrompt(h2000.text);
  assert.notEqual(hash300, hash800);
  assert.notEqual(hash800, hash2000);
  assert.notEqual(hash300, hash2000);

  // Deduplication analysis detects all 3 as distinct
  const analysis = detectIdenticalPrompts(budgetHandoffs);
  assert.equal(analysis[300].isDuplicate, false);
  assert.equal(analysis[300].identicalTo, null);
  assert.equal(analysis[800].isDuplicate, false);
  assert.equal(analysis[800].identicalTo, null);
  assert.equal(analysis[2000].isDuplicate, false);
  assert.equal(analysis[2000].identicalTo, null);
});

test('runCondition deduplication skips provider call and marks duplicateOf', async () => {
  const repo = await gitRepo();
  const expectedFingerprint = await repositoryFingerprint(repo);
  const taskRoot = await mkdtemp(path.join(tmpdir(), 'handoff-v2-reused-'));
  directories.push(taskRoot);

  const mockPredecessorResult = {
    condition: 'handoff-300',
    prompt: {
      kind: 'exact-handoff-300',
      characters: 150,
      sha256: 'a'.repeat(64),
      matchesCapturedHandoff: true,
    },
    command: { executable: 'codex', args: [], cwd: repo, policy: {} },
    wallTimeMs: 1200,
    exitCode: 0,
    signal: null,
    timedOut: false,
    metrics: { inputTokens: 50, cachedInputTokens: 0, outputTokens: 25 },
    evaluation: { combined: { passed: true } },
    changedLines: 10,
    rejectedApproachRepeated: false,
    relayStateAccessed: false,
  };

  const handoffDummy = {
    text: 'Task: Implement retry parsing\n\nGit: main@1234567\n\nInspect the working tree and preserve existing changes.',
  };
  const budgetHandoffs = {
    300: handoffDummy,
    800: handoffDummy,
    2000: handoffDummy,
  };

  const result = await runCondition({
    task: task('retry-after'),
    condition: 'handoff-800',
    repo,
    expectedFingerprint,
    prompt: handoffDummy.text,
    handoffWithNotes: handoffDummy,
    handoffNoNotes: handoffDummy,
    budgetHandoffs,
    taskRoot,
    timeoutMs: 30_000,
    reusedResult: mockPredecessorResult,
  });

  assert.equal(result.condition, 'handoff-800');
  assert.equal(result.skippedProviderCall, true);
  assert.equal(result.duplicateOf, 'handoff-300');
  assert.equal(result.wallTimeMs, 1200);
  assert.equal(result.evaluation.combined.passed, true);
  assert.equal(result.conditionFingerprintEqual, true);
  assert.equal(result.relayStatePresentBeforeSuccessor, false);
  assert.equal(result.prompt.kind, 'exact-handoff-800');
  assert.equal(result.prompt.matchesCapturedHandoff, true);
});

test('markdownReport excludes aliases from failure and missing metric totals and includes budget results', () => {
  const condSuccess = {
    command: { executable: 'codex', args: [], cwd: '/fake', policy: {} },
    wallTimeMs: 100,
    exitCode: 0,
    signal: null,
    timedOut: false,
    metrics: { inputTokens: 50, cachedInputTokens: 0, outputTokens: 20 },
    evaluation: { combined: { passed: true } },
    conditionFingerprintEqual: true,
    relayStatePresentBeforeSuccessor: false,
    relayPathInGitStatus: false,
  };

  // handoff-300 has a failure and a missing metric field
  const condFailing = {
    command: { executable: 'codex', args: [], cwd: '/fake', policy: {} },
    wallTimeMs: 150,
    exitCode: 1, // failure!
    signal: null,
    timedOut: false,
    metrics: { inputTokens: 50, cachedInputTokens: 0, outputTokens: null }, // missing metric!
    evaluation: { combined: { passed: false } },
    conditionFingerprintEqual: false, // gate failure!
    relayStatePresentBeforeSuccessor: false,
    relayPathInGitStatus: false,
  };

  const dummyBudget = {
    characters: 100,
    maxCharacters: 1200,
    estimatedTokens: 25,
    maxTokens: 300,
    sha256: 'abc1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
    isDuplicate: false,
    identicalTo: null,
  };

  const dummyBudget800 = {
    ...dummyBudget,
    characters: 200,
    maxCharacters: 3200,
    estimatedTokens: 50,
    maxTokens: 800,
    sha256: 'def1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
  };

  const dummyBudget2000 = {
    ...dummyBudget800,
    maxCharacters: 8000,
    maxTokens: 2000,
    isDuplicate: true,
    identicalTo: 800,
  };

  const taskResult = {
    taskId: 'retry-after',
    title: 'Retry after header support',
    dryRun: false,
    order: [
      'baseline',
      'handoff-no-notes',
      'handoff-300',
      'handoff-800',
      'handoff-2000',
    ],
    handoff: {
      estimatedTokens: 25,
      characters: 100,
      duplicateTaskOccurrences: 1,
      containsNoteInstruction: false,
    },
    capture: {
      validated: true,
      count: 3,
      noteTypes: ['done', 'next', 'rejected'],
    },
    budgets: {
      300: dummyBudget,
      800: dummyBudget800,
      2000: dummyBudget2000,
    },
    predecessor: {
      exitCode: 0,
      command: { executable: 'codex', args: [], cwd: '/fake', policy: {} },
    },
    conditions: {
      baseline: condSuccess,
      'handoff-no-notes': condSuccess,
      'handoff-300': condFailing,
      'handoff-800': condSuccess,
      'handoff-2000': {
        ...condSuccess,
        skippedProviderCall: true,
        duplicateOf: 'handoff-800',
      },
      'handoff-with-notes': condFailing, // ALIAS pointing to handoff-300!
    },
  };

  const result = {
    schemaVersion: 1,
    integrityVersion: 'v2-full-git-state-v1',
    taskCount: 1,
    providerCommandCount: 4,
    dryRun: false,
    tasks: [taskResult],
    dryRunValidation: [{}],
  };

  const analysis = aggregateResults(result.tasks);
  const report = markdownReport(result, analysis);

  // Crucial check: failures and missing metrics must be counted ONCE, not twice from the alias!
  assert.match(report, /failures or timeouts: 1/);
  assert.match(report, /Missing required successor metric fields: 1\./);
  assert.match(report, /Successor gate failures: 1\./);

  // Budget report lines present
  assert.match(report, /Handoff 300 tokens: 0\/1\./);
  assert.match(report, /Handoff 800 tokens: 1\/1\./);
  assert.match(report, /Handoff 2,000 tokens: 1\/1\./);
  assert.match(
    report,
    /Budget successor wall time: 300 tokens: 150 ms; 800 tokens: 100 ms; 2,000 tokens: 100 ms\./,
  );
  assert.match(
    report,
    /## Budget arm performance \(300 \/ 800 \/ 2,000 tokens\)/,
  );
  assert.match(report, /reused \(handoff-800\)/);
});
