import assert from 'node:assert/strict';
import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import {
  archiveAndResetPreflightCondition,
  buildRecoveryPlan,
  classifyCodexPreflightFailure,
  reconstructTaskResult,
} from './recover.mjs';
import { providerCommands } from './run.mjs';

async function writeJson(path, value) {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeCompleteProviderLog(
  directory,
  command = {},
  { stdout = '', stderr = '', output = stdout } = {},
) {
  await mkdir(directory, { recursive: true });
  await Promise.all([
    writeJson(join(directory, 'command.json'), command),
    writeFile(join(directory, 'stdout.log'), stdout),
    writeFile(join(directory, 'stderr.log'), stderr),
    writeFile(join(directory, 'output.jsonl'), output),
  ]);
}

const parserError = `error: unexpected argument '--ask-for-approval' found

Usage: codex exec [OPTIONS] [PROMPT]
`;

const preflightCommand = {
  executable: 'codex',
  args: ['exec', '--ask-for-approval', 'never', 'prompt'],
  exitCode: 2,
};

test('strictly classifies only zero-model Codex parser failures', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'handoff-preflight-classifier-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const valid = join(root, 'valid');
  await writeCompleteProviderLog(valid, preflightCommand, {
    stderr: parserError,
    output: '',
  });
  assert.equal((await classifyCodexPreflightFailure(valid)).retryable, true);

  const invalidCases = [
    {
      name: 'model-output',
      command: preflightCommand,
      logs: { stdout: '{"type":"turn.started"}\n', stderr: parserError },
      failedCheck: 'emptyStdout',
    },
    {
      name: 'successful-exit',
      command: { ...preflightCommand, exitCode: 0 },
      logs: { stderr: parserError, output: '' },
      failedCheck: 'nonzeroExit',
    },
    {
      name: 'missing-flag',
      command: { ...preflightCommand, args: ['exec', 'prompt'] },
      logs: { stderr: parserError, output: '' },
      failedCheck: 'obsoleteFlag',
    },
    {
      name: 'different-error',
      command: preflightCommand,
      logs: { stderr: 'network unavailable\n', output: '' },
      failedCheck: 'parserDiagnostic',
    },
    {
      name: 'nonempty-jsonl-copy',
      command: preflightCommand,
      logs: { stderr: parserError, output: '{}\n' },
      failedCheck: 'emptyOutput',
    },
  ];
  for (const invalid of invalidCases) {
    const directory = join(root, invalid.name);
    await writeCompleteProviderLog(directory, invalid.command, invalid.logs);
    const classification = await classifyCodexPreflightFailure(directory);
    assert.equal(classification.retryable, false);
    assert.match(classification.reason, new RegExp(invalid.failedCheck));
  }
});

test('builds the supported noninteractive Codex exec argument shape', () => {
  const command = providerCommands('prompt', '/repo').codex;
  assert.deepEqual(command.args, [
    'exec',
    '--json',
    '--ephemeral',
    '--ignore-user-config',
    '--sandbox',
    'workspace-write',
    '--model',
    'gpt-5.6-sol',
    '-c',
    'model_reasoning_effort="low"',
    'prompt',
  ]);
  assert.equal(command.args.includes('--ask-for-approval'), false);
});

test('recovery plan lists eleven actual model calls in fair order', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'handoff-recovery-plan-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const predecessors = [
    ['task-1-retry-after', 'predecessor-provider'],
    ['task-2-deep-config-merge', 'predecessor-provider'],
    ['task-3-ttl-lru-cache', 'predecessor-provider'],
    ['task-4-workspace-path', 'predecessor-provider'],
  ];
  await Promise.all(
    predecessors.map(([taskDirectory, log]) =>
      writeCompleteProviderLog(
        join(root, taskDirectory, 'logs', log),
        { executable: 'agy', exitCode: 0 },
        {
          stdout: '{"event":"result","result":{"usage":{"input_tokens":1}}}\n',
        },
      ),
    ),
  );
  const preflights = [
    ['task-1-retry-after', 'baseline'],
    ['task-1-retry-after', 'treatment'],
    ['task-2-deep-config-merge', 'treatment'],
    ['task-2-deep-config-merge', 'baseline'],
    ['task-3-ttl-lru-cache', 'baseline'],
    ['task-3-ttl-lru-cache', 'treatment'],
  ];
  await Promise.all(
    preflights.map(([taskDirectory, condition]) =>
      writeCompleteProviderLog(
        join(root, taskDirectory, 'logs', condition, 'provider'),
        preflightCommand,
        { stderr: parserError, output: '' },
      ),
    ),
  );

  const plan = await buildRecoveryPlan(root);
  assert.equal(plan.pendingActualModelCallCount, 11);
  assert.equal(plan.priorActualModelCalls, 4);
  assert.equal(plan.zeroModelPreflightFailures.length, 6);
  assert.deepEqual(
    plan.pending.map((call) => call.id),
    [
      'task-1:baseline',
      'task-1:treatment',
      'task-2:treatment',
      'task-2:baseline',
      'task-3:baseline',
      'task-3:treatment',
      'task-4:treatment',
      'task-4:baseline',
      'task-5:predecessor',
      'task-5:baseline',
      'task-5:treatment',
    ],
  );
  const ambiguous = join(
    root,
    'task-1-retry-after',
    'logs',
    'baseline',
    'provider',
  );
  await writeFile(join(ambiguous, 'stdout.log'), '{"type":"thread.started"}\n');
  await writeFile(
    join(ambiguous, 'output.jsonl'),
    '{"type":"thread.started"}\n',
  );
  await assert.rejects(
    buildRecoveryPlan(root),
    /ambiguous consumed invocation task-1:baseline/,
  );
});

test('archives preflight evidence and resets a condition from predecessor', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'handoff-preflight-reset-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const taskRoot = join(root, 'task-1-retry-after');
  const predecessor = join(taskRoot, 'predecessor');
  const baseline = join(taskRoot, 'baseline');
  for (const repo of [predecessor, baseline]) {
    await mkdir(join(repo, '.relay'), { recursive: true });
    await mkdir(join(repo, 'src'), { recursive: true });
    await mkdir(join(repo, 'test'), { recursive: true });
  }
  await writeFile(
    join(predecessor, '.relay', 'state.json'),
    '{"revision":1}\n',
  );
  await writeFile(join(predecessor, 'src', 'index.js'), 'predecessor\n');
  await writeFile(join(baseline, '.relay', 'state.json'), '{"revision":1}\n');
  await writeFile(join(baseline, 'src', 'index.js'), 'stale\n');
  await writeFile(join(baseline, 'test', 'hidden.test.js'), 'hidden\n');
  await writeCompleteProviderLog(
    join(taskRoot, 'logs', 'baseline', 'provider'),
    preflightCommand,
    { stderr: parserError, output: '' },
  );
  await mkdir(join(taskRoot, 'logs', 'baseline', 'evaluation'), {
    recursive: true,
  });
  await writeFile(
    join(taskRoot, 'logs', 'baseline', 'evaluation', 'marker'),
    'local evaluation\n',
  );

  await archiveAndResetPreflightCondition({
    runRoot: root,
    taskRoot,
    condition: 'baseline',
  });

  const archive = join(taskRoot, 'logs', 'preflight-failures', 'baseline');
  await access(join(archive, 'provider', 'command.json'));
  await access(join(archive, 'evaluation', 'marker'));
  assert.equal(
    await readFile(join(baseline, 'src', 'index.js'), 'utf8'),
    'predecessor\n',
  );
  assert.equal(
    await readFile(join(baseline, '.relay', 'state.json'), 'utf8'),
    '{"revision":1}\n',
  );
  await assert.rejects(access(join(baseline, 'test', 'hidden.test.js')));
  assert.equal(
    (await readJsonForTest(join(archive, 'manifest.json'))).status,
    'archived-and-reset',
  );
  await archiveAndResetPreflightCondition({
    runRoot: root,
    taskRoot,
    condition: 'baseline',
  });
  assert.equal(
    await readFile(join(baseline, 'src', 'index.js'), 'utf8'),
    'predecessor\n',
  );
});

async function readJsonForTest(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

test('reconstructs a task from persisted logs without inferring metrics', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'handoff-reconstruction-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const task = {
    id: 'example',
    title: 'Example',
    rejectedNoteNeedle: 'unsafe',
    rejectedSourcePattern: 'unsafeCall',
  };
  const command = {
    executable: 'codex',
    args: ['exec', 'prompt'],
    cwd: root,
    wallTimeMs: 20,
    exitCode: 0,
    signal: null,
    timedOut: false,
  };
  await writeCompleteProviderLog(join(root, 'logs', 'predecessor-provider'), {
    ...command,
    executable: 'agy',
    args: ['-p', 'phase'],
  });
  await writeJson(join(root, 'logs', 'predecessor-public', 'command.json'), {
    exitCode: 0,
  });
  await writeJson(join(root, 'logs', 'relay-checkpoint', 'command.json'), {
    exitCode: 0,
  });
  await writeJson(join(root, 'logs', 'relay-handoff', 'stdout.log'), {
    text: 'handoff',
    budget: { estimatedTokens: 2, omittedItems: 0 },
    capsule: { notes: [] },
  });
  for (const condition of ['baseline', 'treatment']) {
    await writeCompleteProviderLog(
      join(root, 'logs', condition, 'provider'),
      command,
    );
    for (const evaluation of ['public', 'hidden', 'combined']) {
      await writeJson(
        join(root, 'logs', condition, 'evaluation', evaluation, 'command.json'),
        { exitCode: 0, signal: null, wallTimeMs: 1 },
      );
    }
    await mkdir(join(root, condition, 'src'), { recursive: true });
    await writeFile(join(root, condition, 'src', 'index.js'), 'export {};\n');
  }

  const result = await reconstructTaskResult({
    task,
    taskRoot: root,
    taskIndex: 0,
  });
  assert.equal(result.predecessor.captureSucceeded, true);
  assert.equal(result.conditions.baseline.metrics.inputTokens, null);
  assert.equal(result.conditions.treatment.evaluation.combined.passed, true);
  assert.equal(result.handoff.notes.count, 0);
});
