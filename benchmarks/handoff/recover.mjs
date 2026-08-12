#!/usr/bin/env node
import { constants } from 'node:fs';
import {
  access,
  cp,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  aggregateResults,
  parseJsonLines,
  parseProviderMetrics,
  summarizeHandoff,
} from './lib.mjs';
import {
  TEMP_PARENT,
  copyWorktree,
  createRelayWrapper,
  evaluate,
  executableOnPath,
  isWithin,
  loadTasks,
  providerCommands,
  relayCommand,
  repositoryFingerprint,
  runCommand,
  runCondition,
  setupTaskRepo,
  sha256,
} from './run.mjs';

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_RECOVERY_MODEL_CALLS = 11;
const PRIOR_MODEL_CALLS = [
  ['task-1-retry-after', 'predecessor-provider'],
  ['task-2-deep-config-merge', 'predecessor-provider'],
  ['task-3-ttl-lru-cache', 'predecessor-provider'],
  ['task-4-workspace-path', 'predecessor-provider'],
];
const PREFLIGHT_CONDITIONS = [
  ['task-1-retry-after', 'baseline'],
  ['task-1-retry-after', 'treatment'],
  ['task-2-deep-config-merge', 'treatment'],
  ['task-2-deep-config-merge', 'baseline'],
  ['task-3-ttl-lru-cache', 'baseline'],
  ['task-3-ttl-lru-cache', 'treatment'],
];

function parseArguments(argv) {
  const options = {
    execute: false,
    runRoot: null,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--execute') options.execute = true;
    else if (argument === '--dry-run') options.execute = false;
    else if (argument === '--run-root') options.runRoot = argv[++index];
    else if (argument === '--timeout-ms')
      options.timeoutMs = Number(argv[++index]);
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!options.runRoot) {
    throw new Error('--run-root is required; recovery never discovers a run.');
  }
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1_000) {
    throw new Error('--timeout-ms must be an integer of at least 1000.');
  }
  return options;
}

async function validateRunRoot(input) {
  if (resolve(input) !== input) {
    throw new Error('--run-root must be an exact absolute path.');
  }
  const [approvedParent, runRoot] = await Promise.all([
    realpath(TEMP_PARENT),
    realpath(input),
  ]);
  if (
    dirname(runRoot) !== approvedParent ||
    !isWithin(approvedParent, runRoot) ||
    !runRoot.startsWith(`${approvedParent}/handoff-benchmark-`)
  ) {
    throw new Error(
      `--run-root must be a direct handoff-benchmark child of ${approvedParent}.`,
    );
  }
  return runRoot;
}

async function pathExists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

const providerLogFiles = [
  'command.json',
  'stdout.log',
  'stderr.log',
  'output.jsonl',
];

async function providerLogComplete(logDirectory) {
  const present = await Promise.all(
    providerLogFiles.map((name) => pathExists(join(logDirectory, name))),
  );
  if (present.some(Boolean) && !present.every(Boolean)) {
    throw new Error(`Partial provider log is ambiguous: ${logDirectory}`);
  }
  return present.every(Boolean);
}

function providerLog(runRoot, taskDirectory, relativeLog) {
  return join(runRoot, taskDirectory, 'logs', relativeLog);
}

export function makeRecoveryCallSpecs(runRoot) {
  const task1 = join(runRoot, 'task-1-retry-after');
  const task2 = join(runRoot, 'task-2-deep-config-merge');
  const task3 = join(runRoot, 'task-3-ttl-lru-cache');
  const task4 = join(runRoot, 'task-4-workspace-path');
  const task5 = join(runRoot, 'task-5-event-reconciliation');
  const successor = (taskRoot, taskIndex, taskId, condition) => ({
    id: `task-${taskIndex + 1}:${condition}`,
    taskIndex,
    taskId,
    provider: 'codex',
    condition,
    repo: join(taskRoot, condition),
    logDirectory: join(taskRoot, 'logs', condition, 'provider'),
  });
  return [
    successor(task1, 0, 'retry-after', 'baseline'),
    successor(task1, 0, 'retry-after', 'treatment'),
    successor(task2, 1, 'deep-config-merge', 'treatment'),
    successor(task2, 1, 'deep-config-merge', 'baseline'),
    successor(task3, 2, 'ttl-lru-cache', 'baseline'),
    successor(task3, 2, 'ttl-lru-cache', 'treatment'),
    successor(task4, 3, 'workspace-path', 'treatment'),
    successor(task4, 3, 'workspace-path', 'baseline'),
    {
      id: 'task-5:predecessor',
      taskIndex: 4,
      taskId: 'event-reconciliation',
      provider: 'antigravity',
      condition: 'predecessor',
      repo: join(task5, 'predecessor'),
      logDirectory: join(task5, 'logs', 'predecessor-provider'),
    },
    successor(task5, 4, 'event-reconciliation', 'baseline'),
    successor(task5, 4, 'event-reconciliation', 'treatment'),
  ];
}

const metricsAreNull = (metrics) =>
  Object.values(metrics).every((value) => value === null);

export async function classifyCodexPreflightFailure(logDirectory) {
  if (!(await providerLogComplete(logDirectory))) {
    return { retryable: false, reason: 'provider log is absent' };
  }
  const [command, stdout, stderr, output] = await Promise.all([
    readJson(join(logDirectory, 'command.json')),
    readFile(join(logDirectory, 'stdout.log'), 'utf8'),
    readFile(join(logDirectory, 'stderr.log'), 'utf8'),
    readFile(join(logDirectory, 'output.jsonl'), 'utf8'),
  ]);
  const checks = {
    codexExecutable:
      typeof command.executable === 'string' &&
      basename(command.executable) === 'codex',
    nonzeroExit: typeof command.exitCode === 'number' && command.exitCode !== 0,
    emptyStdout: stdout.length === 0,
    emptyOutput: output.length === 0,
    nullMetrics: metricsAreNull(parseProviderMetrics('codex', stdout)),
    obsoleteFlag:
      Array.isArray(command.args) &&
      command.args.some((argument) => argument === '--ask-for-approval'),
    parserDiagnostic:
      /error:\s+unexpected argument ['"]--ask-for-approval['"] found/i.test(
        stderr,
      ) && /Usage:\s+codex exec/i.test(stderr),
  };
  const retryable = Object.values(checks).every(Boolean);
  return {
    retryable,
    reason: retryable
      ? 'verified zero-model Codex parser failure'
      : `strict checks failed: ${Object.entries(checks)
          .filter(([, passed]) => !passed)
          .map(([name]) => name)
          .join(', ')}`,
    checks,
  };
}

function hasActualModelOutput(provider, text) {
  const records = parseJsonLines(text);
  if (provider === 'antigravity') {
    return records.some(
      (record) =>
        record.event === 'result' ||
        (record.event === 'step_update' &&
          (record.step_update?.usage ||
            record.step_update?.step_type === 'agent_response')),
    );
  }
  return records.some(
    (record) =>
      record.type === 'turn.completed' ||
      (record.type === 'item.completed' &&
        [
          'agent_message',
          'reasoning',
          'command_execution',
          'file_change',
          'mcp_tool_call',
        ].includes(record.item?.type)),
  );
}

async function logHasActualModelOutput(call) {
  if (!(await providerLogComplete(call.logDirectory))) return false;
  const stdout = await readFile(join(call.logDirectory, 'stdout.log'), 'utf8');
  return hasActualModelOutput(call.provider, stdout);
}

function preflightArchiveRoot(runRoot, taskDirectory, condition) {
  return join(runRoot, taskDirectory, 'logs', 'preflight-failures', condition);
}

export async function buildRecoveryPlan(runRoot) {
  for (const [taskDirectory, relativeLog] of PRIOR_MODEL_CALLS) {
    const logDirectory = providerLog(runRoot, taskDirectory, relativeLog);
    if (!(await providerLogComplete(logDirectory))) {
      throw new Error(
        `Refusing recovery because a prior Antigravity model call is missing: ${logDirectory}`,
      );
    }
    const stdout = await readFile(join(logDirectory, 'stdout.log'), 'utf8');
    if (!hasActualModelOutput('antigravity', stdout)) {
      throw new Error(
        `Prior Antigravity log lacks model output: ${logDirectory}`,
      );
    }
  }
  const calls = makeRecoveryCallSpecs(runRoot);
  const pending = [];
  const completed = [];
  const preflightFailures = [];
  for (const call of calls) {
    const taskDirectory = `task-${call.taskIndex + 1}-${call.taskId}`;
    const archiveProvider = join(
      preflightArchiveRoot(runRoot, taskDirectory, call.condition),
      'provider',
    );
    const expectsPreflightArchive = PREFLIGHT_CONDITIONS.some(
      ([expectedTask, expectedCondition]) =>
        expectedTask === taskDirectory && expectedCondition === call.condition,
    );
    const archiveExists = await pathExists(archiveProvider);
    if (archiveExists) {
      if (!expectsPreflightArchive) {
        throw new Error(`Unexpected preflight archive for ${call.id}.`);
      }
      const archived = await classifyCodexPreflightFailure(archiveProvider);
      if (!archived.retryable) {
        throw new Error(
          `Archived preflight evidence failed validation for ${call.id}: ${archived.reason}.`,
        );
      }
      preflightFailures.push({ id: call.id, location: archiveProvider });
    }
    if (await providerLogComplete(call.logDirectory)) {
      const preflight = await classifyCodexPreflightFailure(call.logDirectory);
      if (call.provider === 'codex' && preflight.retryable) {
        if (archiveExists) {
          throw new Error(
            `Both active and archived preflight evidence exist for ${call.id}.`,
          );
        }
        preflightFailures.push({ id: call.id, location: call.logDirectory });
        pending.push(call);
      } else if (await logHasActualModelOutput(call)) {
        completed.push(call);
      } else {
        throw new Error(
          `Refusing to repeat ambiguous consumed invocation ${call.id}: ${preflight.reason}.`,
        );
      }
    } else pending.push(call);
  }
  const statePath = join(runRoot, 'recovery-state.json');
  if (await pathExists(statePath)) {
    const state = await readJson(statePath);
    if (state.inFlight && pending.some((call) => call.id === state.inFlight)) {
      throw new Error(
        `Refusing to repeat ${state.inFlight}: launch was recorded but complete provider logs are absent.`,
      );
    }
  }
  if (pending.length > MAX_RECOVERY_MODEL_CALLS) {
    throw new Error(
      `Recovery would require ${pending.length} model calls; maximum is ${MAX_RECOVERY_MODEL_CALLS}.`,
    );
  }
  if (preflightFailures.length !== PREFLIGHT_CONDITIONS.length) {
    throw new Error(
      `Expected six verified zero-model preflight failures; found ${preflightFailures.length}.`,
    );
  }
  return {
    schemaVersion: 1,
    mode: 'handoff-recovery',
    runRoot,
    priorActualModelCalls: PRIOR_MODEL_CALLS.length,
    completedRecoveryModelCalls: completed.length,
    pendingActualModelCallCount: pending.length,
    maximumRecoveryModelCalls: MAX_RECOVERY_MODEL_CALLS,
    projectedActualModelCallCount:
      PRIOR_MODEL_CALLS.length + completed.length + pending.length,
    zeroModelPreflightFailures: preflightFailures,
    pending: pending.map(
      ({ id, taskIndex, taskId, provider, condition, repo }) => ({
        id,
        taskIndex,
        taskId,
        provider,
        condition,
        repo,
      }),
    ),
  };
}

function summarizeCommand(command) {
  return {
    executable: command.executable,
    args: command.args,
    cwd: command.cwd,
    policy: providerCommands('', command.cwd)[
      command.executable === 'agy' ? 'antigravity' : 'codex'
    ].policy,
  };
}

function summarizeEvaluationCommand(command) {
  return {
    passed: command.exitCode === 0,
    exitCode: command.exitCode,
    signal: command.signal,
    wallTimeMs: command.wallTimeMs,
  };
}

async function readEvaluation(taskRoot, condition) {
  const root = join(taskRoot, 'logs', condition, 'evaluation');
  const [publicCommand, hiddenCommand, combinedCommand] = await Promise.all([
    readJson(join(root, 'public', 'command.json')),
    readJson(join(root, 'hidden', 'command.json')),
    readJson(join(root, 'combined', 'command.json')),
  ]);
  return {
    public: summarizeEvaluationCommand(publicCommand),
    hidden: summarizeEvaluationCommand(hiddenCommand),
    combined: summarizeEvaluationCommand(combinedCommand),
  };
}

async function readChangedLines(taskRoot, condition) {
  const root = join(taskRoot, 'logs', condition, 'changed-lines');
  if (!(await pathExists(join(root, 'command.json')))) return null;
  const command = await readJson(join(root, 'command.json'));
  if (![0, 1].includes(command.exitCode)) return null;
  const output = await readFile(join(root, 'stdout.log'), 'utf8');
  let additions = 0;
  let deletions = 0;
  for (const line of output.split(/\r?\n/)) {
    const [added, deleted] = line.split('\t');
    if (/^\d+$/.test(added) && /^\d+$/.test(deleted)) {
      additions += Number(added);
      deletions += Number(deleted);
    }
  }
  return { additions, deletions, total: additions + deletions };
}

async function readCondition(task, taskRoot, condition, handoff) {
  const providerRoot = join(taskRoot, 'logs', condition, 'provider');
  const [command, stdout, evaluation, changedLines, source] = await Promise.all(
    [
      readJson(join(providerRoot, 'command.json')),
      readFile(join(providerRoot, 'stdout.log'), 'utf8'),
      readEvaluation(taskRoot, condition),
      readChangedLines(taskRoot, condition),
      readFile(join(taskRoot, condition, 'src', 'index.js'), 'utf8'),
    ],
  );
  const prompt = command.args.at(-1);
  const rejectedNotes = handoff.capsule?.notes?.filter(
    (note) => note.type === 'rejected',
  );
  const rejectedRepeated = rejectedNotes?.some((note) =>
    note.text.includes(task.rejectedNoteNeedle),
  )
    ? new RegExp(task.rejectedSourcePattern, 'm').test(source)
    : null;
  const relayStateAccessed = /(?:^|[\s"'])\.relay(?:\/|[\s"'])/m.test(stdout);
  return {
    condition,
    prompt: {
      kind:
        condition === 'baseline'
          ? 'full-request-plus-inspection'
          : 'exact-handoff',
      characters: typeof prompt === 'string' ? prompt.length : null,
      sha256: typeof prompt === 'string' ? await sha256(prompt) : null,
    },
    command: summarizeCommand(command),
    wallTimeMs: command.wallTimeMs ?? null,
    exitCode: command.exitCode ?? null,
    signal: command.signal ?? null,
    timedOut: command.timedOut ?? null,
    metrics: parseProviderMetrics('codex', stdout),
    evaluation,
    changedLines,
    rejectedApproachRepeated: rejectedRepeated,
    relayStateAccessed,
    baselineRelayContamination:
      condition === 'baseline' ? relayStateAccessed : false,
  };
}

async function readPredecessor(taskRoot, captureSucceeded) {
  const providerRoot = join(taskRoot, 'logs', 'predecessor-provider');
  const [command, stdout, publicCommand] = await Promise.all([
    readJson(join(providerRoot, 'command.json')),
    readFile(join(providerRoot, 'stdout.log'), 'utf8'),
    readJson(join(taskRoot, 'logs', 'predecessor-public', 'command.json')),
  ]);
  const checkpointPath = join(
    taskRoot,
    'logs',
    captureSucceeded ? 'relay-checkpoint' : 'recovery-relay-checkpoint',
    'command.json',
  );
  const checkpoint = (await pathExists(checkpointPath))
    ? await readJson(checkpointPath)
    : null;
  return {
    command: summarizeCommand(command),
    wallTimeMs: command.wallTimeMs ?? null,
    exitCode: command.exitCode ?? null,
    signal: command.signal ?? null,
    timedOut: command.timedOut ?? null,
    metrics: parseProviderMetrics('antigravity', stdout),
    checkpointExitCode: checkpoint?.exitCode ?? null,
    captureSucceeded,
    publicPhasePassed: publicCommand.exitCode === 0,
    hiddenWorkRemained: true,
  };
}

export async function reconstructTaskResult({
  task,
  taskRoot,
  taskIndex,
  captureSucceeded = true,
}) {
  const handoffLog = join(
    taskRoot,
    'logs',
    captureSucceeded ? 'relay-handoff' : 'recovery-relay-handoff',
    'stdout.log',
  );
  const handoff = await readJson(handoffLog);
  const order =
    taskIndex % 2 === 0 ? ['baseline', 'treatment'] : ['treatment', 'baseline'];
  const [predecessor, baseline, treatment] = await Promise.all([
    readPredecessor(taskRoot, captureSucceeded),
    readCondition(task, taskRoot, 'baseline', handoff),
    readCondition(task, taskRoot, 'treatment', handoff),
  ]);
  const result = {
    taskId: task.id,
    title: task.title,
    order,
    predecessor,
    handoff: summarizeHandoff(handoff),
    conditions: { baseline, treatment },
  };
  if (!captureSucceeded) {
    result.caveats = [
      'Antigravity exited 0 in its scratch directory, but the actual predecessor public phase failed; the actual repository had no source change or Relay notes.',
      'Checkpoint and handoff were captured during recovery from the unchanged actual predecessor repository.',
    ];
  }
  return result;
}

async function ensureTask4Prepared(task, taskRoot, relayBin, timeoutMs) {
  const predecessorRepo = join(taskRoot, 'predecessor');
  const [actualSource, initialSource, state, providerCommand] =
    await Promise.all([
      readFile(join(predecessorRepo, 'src', 'index.js'), 'utf8'),
      readFile(
        join(
          dirname(fileURLToPath(import.meta.url)),
          'fixtures',
          task.id,
          'initial',
          'src',
          'index.js',
        ),
        'utf8',
      ),
      readJson(join(predecessorRepo, '.relay', 'state.json')),
      readJson(join(taskRoot, 'logs', 'predecessor-provider', 'command.json')),
    ]);
  if (providerCommand.exitCode !== 0) {
    throw new Error(
      'Task 4 recovery requires the recorded predecessor exit 0.',
    );
  }
  if (actualSource !== initialSource) {
    throw new Error(
      'Task 4 actual predecessor source is not the unchanged fixture.',
    );
  }
  if (!Array.isArray(state.notes) || state.notes.length !== 0) {
    throw new Error(
      'Task 4 actual predecessor unexpectedly contains Relay notes.',
    );
  }
  const publicCommand = await readJson(
    join(taskRoot, 'logs', 'predecessor-public', 'command.json'),
  );
  if (publicCommand.exitCode === 0) {
    throw new Error(
      'Task 4 recovery requires the recorded public-phase failure.',
    );
  }
  const checkpointLog = join(taskRoot, 'logs', 'recovery-relay-checkpoint');
  if (!(await pathExists(join(checkpointLog, 'command.json')))) {
    await relayCommand({
      args: [
        'checkpoint',
        '--message',
        'Recovery capture after predecessor failure',
      ],
      cwd: predecessorRepo,
      relayBin,
      timeoutMs,
      logDirectory: checkpointLog,
    });
  }
  const handoffLog = join(taskRoot, 'logs', 'recovery-relay-handoff');
  if (!(await pathExists(join(handoffLog, 'command.json')))) {
    await relayCommand({
      args: ['handoff', '--json'],
      cwd: predecessorRepo,
      relayBin,
      timeoutMs,
      logDirectory: handoffLog,
    });
  }
  const handoff = await readJson(join(handoffLog, 'stdout.log'));
  if ((handoff.capsule?.notes?.length ?? 0) !== 0) {
    throw new Error(
      'Task 4 recovery handoff must not contain fabricated notes.',
    );
  }
  for (const condition of ['baseline', 'treatment']) {
    const repo = join(taskRoot, condition);
    if (!(await pathExists(repo))) await copyWorktree(predecessorRepo, repo);
  }
  return handoff;
}

function baselinePrompt(task) {
  return `${task.request}\n\nBefore editing, inspect AGENTS.md, git status, and git diff. Preserve and build on the interrupted work. Finish the complete implementation and run all public tests.`;
}

async function moveEvidence(source, destination) {
  const [sourceExists, destinationExists] = await Promise.all([
    pathExists(source),
    pathExists(destination),
  ]);
  if (sourceExists && destinationExists) {
    throw new Error(`Refusing to overwrite archived evidence: ${destination}`);
  }
  if (sourceExists) {
    await mkdir(dirname(destination), { recursive: true });
    await rename(source, destination);
  }
}

export async function archiveAndResetPreflightCondition({
  runRoot,
  taskRoot,
  condition,
}) {
  const taskDirectory = basename(taskRoot);
  const logRoot = join(taskRoot, 'logs', condition);
  const providerRoot = join(logRoot, 'provider');
  const archiveRoot = preflightArchiveRoot(runRoot, taskDirectory, condition);
  const archiveProvider = join(archiveRoot, 'provider');
  const activeProviderExists = await providerLogComplete(providerRoot);
  const archivedProviderExists = await providerLogComplete(archiveProvider);
  if (activeProviderExists && archivedProviderExists) {
    if (
      await logHasActualModelOutput({
        provider: 'codex',
        logDirectory: providerRoot,
      })
    ) {
      return;
    }
    throw new Error(
      `Both active and archived preflight evidence exist for ${taskDirectory}:${condition}.`,
    );
  }
  const evidenceRoot = activeProviderExists ? providerRoot : archiveProvider;
  const classification = await classifyCodexPreflightFailure(evidenceRoot);
  if (!classification.retryable) {
    throw new Error(
      `Refusing reset for ${taskDirectory}:${condition}: ${classification.reason}.`,
    );
  }
  await mkdir(archiveRoot, { recursive: true });
  const manifestPath = join(archiveRoot, 'manifest.json');
  await writeFile(
    manifestPath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        id: `${taskDirectory}:${condition}`,
        status: 'archiving',
        classification,
      },
      null,
      2,
    )}\n`,
  );
  await moveEvidence(providerRoot, archiveProvider);
  await moveEvidence(
    join(logRoot, 'evaluation'),
    join(archiveRoot, 'evaluation'),
  );
  await moveEvidence(
    join(logRoot, 'changed-lines'),
    join(archiveRoot, 'changed-lines'),
  );
  await moveEvidence(
    join(taskRoot, `${condition}-predecessor-snapshot`),
    join(archiveRoot, 'predecessor-snapshot'),
  );
  await moveEvidence(
    join(taskRoot, `${condition}-final-snapshot`),
    join(archiveRoot, 'final-snapshot'),
  );
  await moveEvidence(logRoot, join(archiveRoot, 'derived-remainder'));
  const repo = join(taskRoot, condition);
  const predecessor = join(taskRoot, 'predecessor');
  await rm(repo, { recursive: true, force: true });
  await copyWorktree(predecessor, repo, { includeRelay: true });
  await rm(join(repo, 'test', 'hidden.test.js'), { force: true });
  const [predecessorRelay, conditionRelay] = await Promise.all([
    readFile(join(predecessor, '.relay', 'state.json'), 'utf8'),
    readFile(join(repo, '.relay', 'state.json'), 'utf8'),
  ]);
  if (predecessorRelay !== conditionRelay) {
    throw new Error(
      `Reset did not retain identical .relay state for ${taskDirectory}:${condition}.`,
    );
  }
  await writeFile(
    manifestPath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        id: `${taskDirectory}:${condition}`,
        status: 'archived-and-reset',
        classification,
        archived: [
          'provider',
          'evaluation',
          'changed-lines',
          'predecessor-snapshot',
          'final-snapshot',
          'derived-remainder',
        ],
      },
      null,
      2,
    )}\n`,
  );
  const statePath = join(runRoot, 'recovery-state.json');
  const state = (await pathExists(statePath))
    ? await readJson(statePath)
    : { schemaVersion: 2, completedModelCalls: [], inFlight: null };
  state.archivedPreflightAttempts ??= [];
  const id = `${taskDirectory}:${condition}`;
  if (!state.archivedPreflightAttempts.includes(id)) {
    state.archivedPreflightAttempts.push(id);
  }
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

function task5PredecessorPrompt(task, phase, repo) {
  return `${task.request}\n\n${phase}\n\nRepository safety requirement: the actual repository is exactly ${repo}. Use only that repository and never use ~/.gemini/antigravity-cli/scratch. Every file edit, test command, and relay note command must target this absolute path or first cd to ${repo}. Do not create or modify task files or Relay notes anywhere else.`;
}

async function runProviderCall(runRoot, call, operation) {
  const statePath = join(runRoot, 'recovery-state.json');
  const state = (await pathExists(statePath))
    ? await readJson(statePath)
    : { schemaVersion: 2, completedModelCalls: [], inFlight: null };
  state.completedModelCalls ??= state.completed ?? [];
  if (await providerLogComplete(call.logDirectory)) {
    if (!(await logHasActualModelOutput(call))) {
      const preflight =
        call.provider === 'codex'
          ? await classifyCodexPreflightFailure(call.logDirectory)
          : null;
      throw new Error(
        `Refusing to repeat ${call.id}: complete invocation has no verified model output${preflight ? ` (${preflight.reason})` : ''}.`,
      );
    }
    let changed = false;
    if (state.inFlight === call.id) {
      state.inFlight = null;
      changed = true;
    }
    if (!state.completedModelCalls.includes(call.id)) {
      state.completedModelCalls.push(call.id);
      changed = true;
    }
    if (changed) {
      await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
    }
    return null;
  }
  if (state.inFlight && state.inFlight !== call.id) {
    throw new Error(
      `Ambiguous prior recovery call in flight: ${state.inFlight}`,
    );
  }
  if (state.inFlight === call.id) {
    throw new Error(
      `Refusing to repeat ${call.id}: launch was recorded but complete provider logs are absent.`,
    );
  }
  state.inFlight = call.id;
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
  const result = await operation();
  if (!(await logHasActualModelOutput(call))) {
    state.inFlight = null;
    state.failedClosedInvocations ??= [];
    state.failedClosedInvocations.push(call.id);
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
    throw new Error(
      `${call.id} emitted no verified provider/model output; actual-call accounting failed closed.`,
    );
  }
  state.inFlight = null;
  if (!state.completedModelCalls.includes(call.id)) {
    state.completedModelCalls.push(call.id);
  }
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
  return result;
}

async function runSuccessors({
  runRoot,
  task,
  taskRoot,
  taskIndex,
  handoff,
  timeoutMs,
  callById,
}) {
  const order =
    taskIndex % 2 === 0 ? ['baseline', 'treatment'] : ['treatment', 'baseline'];
  const prompts = { baseline: baselinePrompt(task), treatment: handoff.text };
  const repos = {
    baseline: join(taskRoot, 'baseline'),
    treatment: join(taskRoot, 'treatment'),
  };
  const expectedFingerprint = await repositoryFingerprint(
    join(taskRoot, 'predecessor'),
  );
  for (const condition of order) {
    const call = callById.get(`task-${taskIndex + 1}:${condition}`);
    await runProviderCall(runRoot, call, () =>
      runCondition({
        task,
        condition,
        repo: repos[condition],
        expectedFingerprint,
        prompt: prompts[condition],
        handoff,
        taskRoot,
        timeoutMs,
      }),
    );
    const evaluationRoot = join(taskRoot, 'logs', condition, 'evaluation');
    const evaluationComplete = (
      await Promise.all(
        ['public', 'hidden', 'combined'].map((name) =>
          pathExists(join(evaluationRoot, name, 'command.json')),
        ),
      )
    ).every(Boolean);
    if (!evaluationComplete) {
      const repo = join(taskRoot, condition);
      await rm(join(repo, 'test', 'hidden.test.js'), { force: true });
      await evaluate(task, repo, evaluationRoot, timeoutMs);
    }
  }
}

async function evaluatePredecessor(task, taskRoot, timeoutMs) {
  const predecessorRepo = join(taskRoot, 'predecessor');
  const publicLog = join(taskRoot, 'logs', 'predecessor-public');
  let publicCommand;
  if (await pathExists(join(publicLog, 'command.json'))) {
    publicCommand = await readJson(join(publicLog, 'command.json'));
  } else {
    const result = await runCommand({
      executable: process.execPath,
      args: ['--test', 'test/public.test.js'],
      cwd: predecessorRepo,
      timeoutMs,
      logDirectory: publicLog,
    });
    publicCommand = result;
  }
  if (publicCommand.exitCode !== 0) {
    throw new Error(`${task.id}: predecessor did not pass its public phase.`);
  }
  const validation = join(taskRoot, 'interrupted-validation');
  if (!(await pathExists(validation)))
    await copyWorktree(predecessorRepo, validation);
  await rm(join(validation, 'test', 'hidden.test.js'), { force: true });
  const hiddenSource = join(
    dirname(fileURLToPath(import.meta.url)),
    'fixtures',
    task.id,
    'hidden',
    'hidden.test.js',
  );
  const hiddenTarget = join(validation, 'test', 'hidden.test.js');
  if (!(await pathExists(hiddenTarget))) {
    await cp(hiddenSource, hiddenTarget);
  }
  const hiddenLog = join(taskRoot, 'logs', 'predecessor-hidden');
  let hiddenCommand;
  if (await pathExists(join(hiddenLog, 'command.json'))) {
    hiddenCommand = await readJson(join(hiddenLog, 'command.json'));
  } else {
    hiddenCommand = await runCommand({
      executable: process.execPath,
      args: ['--test', 'test/hidden.test.js'],
      cwd: validation,
      timeoutMs,
      logDirectory: hiddenLog,
    });
  }
  if (hiddenCommand.exitCode === 0) {
    throw new Error(`${task.id}: predecessor left no hidden work.`);
  }
}

async function ensureTask5Prepared({
  runRoot,
  task,
  taskRoot,
  relayBin,
  timeoutMs,
  callById,
}) {
  const predecessorRepo = join(taskRoot, 'predecessor');
  let taskRelayBin = join(predecessorRepo, '.relay', 'benchmark-bin');
  if (!(await pathExists(predecessorRepo))) {
    await mkdir(taskRoot, { recursive: true });
    taskRelayBin = await setupTaskRepo(
      task,
      predecessorRepo,
      join(taskRoot, 'logs', 'setup'),
      relayBin,
      timeoutMs,
    );
  }
  const phase = await readFile(
    join(
      dirname(fileURLToPath(import.meta.url)),
      'fixtures',
      task.id,
      'phase.md',
    ),
    'utf8',
  );
  const prompt = task5PredecessorPrompt(task, phase, predecessorRepo);
  const command = providerCommands(prompt, predecessorRepo).antigravity;
  const call = callById.get('task-5:predecessor');
  const predecessor = await runProviderCall(runRoot, call, () =>
    runCommand({
      executable: command.executable,
      args: command.args,
      cwd: command.cwd,
      timeoutMs,
      logDirectory: call.logDirectory,
      env: {
        ...process.env,
        PATH: `${taskRelayBin}${delimiter}${process.env.PATH ?? ''}`,
      },
    }),
  );
  const predecessorCommand =
    predecessor ?? (await readJson(join(call.logDirectory, 'command.json')));
  if (predecessorCommand.exitCode !== 0) {
    throw new Error(`${task.id}: Antigravity predecessor failed.`);
  }
  await evaluatePredecessor(task, taskRoot, timeoutMs);
  const checkpointLog = join(taskRoot, 'logs', 'relay-checkpoint');
  if (!(await pathExists(join(checkpointLog, 'command.json')))) {
    await relayCommand({
      args: [
        'checkpoint',
        '--message',
        'Interrupted after controlled first phase',
      ],
      cwd: predecessorRepo,
      relayBin,
      timeoutMs,
      logDirectory: checkpointLog,
    });
  }
  const handoffLog = join(taskRoot, 'logs', 'relay-handoff');
  if (!(await pathExists(join(handoffLog, 'command.json')))) {
    await relayCommand({
      args: ['handoff', '--json'],
      cwd: predecessorRepo,
      relayBin,
      timeoutMs,
      logDirectory: handoffLog,
    });
  }
  const handoff = await readJson(join(handoffLog, 'stdout.log'));
  for (const condition of ['baseline', 'treatment']) {
    const repo = join(taskRoot, condition);
    if (!(await pathExists(repo))) await copyWorktree(predecessorRepo, repo);
  }
  return handoff;
}

function metricText(metrics) {
  return `in ${metrics.inputTokens ?? 'null'}, cache ${metrics.cachedInputTokens ?? 'null'}, out ${metrics.outputTokens ?? 'null'}, thinking ${metrics.reasoningTokens ?? 'null'}, turns ${metrics.modelTurns ?? 'null'}, tools ${metrics.toolCalls ?? 'null'}`;
}

function recoveryReport(result, analysis) {
  const lines = [
    '# Rirei handoff benchmark recovery report',
    '',
    `Mode: ${result.mode}`,
    `Tasks: ${result.taskCount}`,
    `Provider CLI process invocations: ${result.accounting.providerProcessInvocations}`,
    `Actual model calls: ${result.accounting.actualModelCalls}`,
    `Verified zero-model preflight failures: ${result.accounting.zeroModelPreflightFailures}`,
    `Actual model calls launched by recovery: ${result.recovery.actualModelCalls}`,
    '',
    '## Per-condition results',
    '',
    '| Task | Capture | Public phase | Condition | Prompt | Time ms | Tokens | Public | Hidden | Combined | Baseline .relay contamination |',
    '| --- | --- | --- | --- | --- | ---: | --- | --- | --- | --- | --- |',
  ];
  for (const task of result.tasks) {
    for (const condition of task.order) {
      const value = task.conditions[condition];
      lines.push(
        `| ${task.taskId} | ${task.predecessor.captureSucceeded} | ${task.predecessor.publicPhasePassed} | ${condition} | ${value.prompt.kind} (${value.prompt.characters ?? 'null'} chars) | ${value.wallTimeMs ?? 'null'} | ${metricText(value.metrics)} | ${value.evaluation.public.passed} | ${value.evaluation.hidden.passed} | ${value.evaluation.combined.passed} | ${value.baselineRelayContamination} |`,
      );
    }
  }
  lines.push('', '## Zero-model preflight failures', '');
  for (const failure of result.recovery.archivedPreflightFailures) {
    lines.push(`- ${failure.id}: ${failure.location}`);
  }
  lines.push('', '## Handoff notes', '');
  for (const task of result.tasks) {
    lines.push(
      `- ${task.taskId}: ${task.handoff.notes === null ? 'unavailable' : `${task.handoff.notes.count} notes; types ${JSON.stringify(task.handoff.notes.byType)}; provenance ${JSON.stringify(task.handoff.notes.byProvenance)}; freshness ${JSON.stringify(task.handoff.notes.byFreshness)}`}`,
    );
  }
  lines.push(
    '',
    '## Predeclared rule',
    '',
    '| Task | Time delta ms | Time reduction | Non-cached token delta | Token reduction | >=20% | Misleading handoff failure |',
    '| --- | ---: | ---: | ---: | ---: | --- | --- |',
    ...analysis.pairs.map(
      (pair) =>
        `| ${pair.taskId} | ${pair.wallTimeDeltaMs} | ${pair.timeReduction ?? 'null'} | ${pair.nonCachedTokenDelta ?? 'null'} | ${pair.tokenReduction ?? 'null'} | ${pair.reachesTwentyPercent} | ${pair.misleadingHandoffFailure ?? 'null'} |`,
    ),
    '',
    `- ${analysis.summary.decisionRule.text}`,
    `- Correct successors: baseline ${analysis.summary.successCounts.baseline}/${result.taskCount}; treatment ${analysis.summary.successCounts.treatment}/${result.taskCount}.`,
    `- Wall-time delta mean/median: ${analysis.summary.wallTimeDeltaMs.mean ?? 'null'} / ${analysis.summary.wallTimeDeltaMs.median ?? 'null'} ms.`,
    `- Non-cached-token delta mean/median: ${analysis.summary.nonCachedTokenDelta.mean ?? 'null'} / ${analysis.summary.nonCachedTokenDelta.median ?? 'null'}.`,
    `- Correctness maintained: ${analysis.summary.decisionRule.correctnessMaintained}`,
    `- Handoff-failure manual review clear: ${analysis.summary.decisionRule.handoffFailureReviewClear}`,
    `- Tasks reaching 20%: ${analysis.summary.improvedTasks}/${result.taskCount}`,
    `- Rule passed: ${analysis.summary.decisionRule.passed}`,
    '',
    '## Protocol deviations and caveats',
    '',
    ...result.protocolDeviations.map((item) => `- ${item}`),
    '- Metrics absent from provider output are null and are never inferred.',
    '- Failed treatments retain misleadingHandoffFailure=null pending manual review; recovery does not attribute failure to the handoff.',
    `- Baseline .relay contamination detected: ${result.baselineRelayContamination.detected}.`,
    '- Five fixed tasks do not establish statistical significance.',
  );
  return `${lines.join('\n')}\n`;
}

async function writeFinalArtifacts(runRoot, tasks, initialPlan, finalPlan) {
  const actualModelCalls =
    finalPlan.priorActualModelCalls + finalPlan.completedRecoveryModelCalls;
  if (
    finalPlan.pendingActualModelCallCount !== 0 ||
    finalPlan.completedRecoveryModelCalls !== MAX_RECOVERY_MODEL_CALLS ||
    actualModelCalls !== 15
  ) {
    throw new Error(
      `Refusing final artifacts: verified actual model calls are ${actualModelCalls}/15 with ${finalPlan.pendingActualModelCallCount} pending.`,
    );
  }
  const baselineByTask = Object.fromEntries(
    tasks.map((task) => [
      task.taskId,
      task.conditions.baseline.baselineRelayContamination,
    ]),
  );
  const result = {
    schemaVersion: 1,
    mode: 'execute-recovery',
    createdAt: new Date().toISOString(),
    runRoot,
    taskCount: tasks.length,
    accounting: {
      providerProcessInvocations: 21,
      providerProcessInvocationsByProvider: { antigravity: 5, codex: 16 },
      actualModelCalls,
      actualModelCallsByProvider: { antigravity: 5, codex: 10 },
      priorActualModelCalls: PRIOR_MODEL_CALLS.length,
      recoveryActualModelCalls: MAX_RECOVERY_MODEL_CALLS,
      zeroModelPreflightFailures: PREFLIGHT_CONDITIONS.length,
      tokenUsageSource: 'provider JSONL only; unavailable values are null',
    },
    recovery: {
      actualModelCalls: MAX_RECOVERY_MODEL_CALLS,
      launchedThisInvocation: initialPlan.pendingActualModelCallCount,
      archivedPreflightFailures: finalPlan.zeroModelPreflightFailures,
      launchPlan: 'recovery-plan.json',
    },
    protocolDeviations: [
      'Six original Codex process invocations failed CLI parsing before model contact; they are archived as zero-model preflight failures and excluded from actual model-call counts.',
      'Tasks 1-3 condition repositories were reset from their identical predecessor repositories before the corrected Codex invocations.',
      'Task 4 Antigravity ran in ~/.gemini/antigravity-cli/scratch despite its command cwd, so the actual predecessor repository remained unchanged, failed public tests, and had no actual Relay notes.',
      'Task 4 checkpoint and handoff capture occurred during recovery and truthfully contain no predecessor-authored notes.',
      'Task 5 Antigravity prompt pinned all edits, tests, and Relay commands to the absolute actual repository path.',
    ],
    baselineRelayContamination: {
      detected: Object.values(baselineByTask).some(Boolean),
      byTask: baselineByTask,
    },
    tasks,
  };
  const analysis = aggregateResults(tasks);
  analysis.protocolReview = {
    treatmentFailuresRequireManualReview: true,
    failedTreatmentsAttributedToHandoff: false,
    baselineRelayContamination: result.baselineRelayContamination,
    predecessorCaptureSucceeded: Object.fromEntries(
      tasks.map((task) => [task.taskId, task.predecessor.captureSucceeded]),
    ),
    protocolDeviations: result.protocolDeviations,
    accounting: result.accounting,
  };
  await Promise.all([
    writeFile(
      join(runRoot, 'result.json'),
      `${JSON.stringify(result, null, 2)}\n`,
    ),
    writeFile(
      join(runRoot, 'analysis.json'),
      `${JSON.stringify(analysis, null, 2)}\n`,
    ),
    writeFile(join(runRoot, 'report.md'), recoveryReport(result, analysis)),
  ]);
}

function printPlan(plan) {
  process.stdout.write(
    `Recovery launch plan: ${plan.pendingActualModelCallCount} pending actual model call(s)\n`,
  );
  for (const [index, call] of plan.pending.entries()) {
    process.stdout.write(
      `${index + 1}. ${call.id} | ${call.provider} | ${call.condition} | ${call.repo}\n`,
    );
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const runRoot = await validateRunRoot(options.runRoot);
  const plan = await buildRecoveryPlan(runRoot);
  printPlan(plan);
  const tasks = await loadTasks(5);
  if (!options.execute) {
    process.stdout.write(
      `Verified ${plan.zeroModelPreflightFailures.length} zero-model preflight failures and ${plan.priorActualModelCalls} prior actual model calls. Dry-run only; no provider command was invoked.\n`,
    );
    return;
  }
  await access(TEMP_PARENT, constants.R_OK | constants.W_OK);
  const [agy, codex] = await Promise.all([
    executableOnPath('agy'),
    executableOnPath('codex'),
  ]);
  if (!agy || !codex) {
    throw new Error(
      'Refusing --execute: agy and codex must be executable on PATH.',
    );
  }
  await writeFile(
    join(runRoot, 'recovery-plan.json'),
    `${JSON.stringify({ ...plan, createdAt: new Date().toISOString() }, null, 2)}\n`,
  );
  const relayBin = (await pathExists(join(runRoot, 'bin', 'relay')))
    ? join(runRoot, 'bin')
    : await createRelayWrapper(runRoot);
  const callById = new Map(
    makeRecoveryCallSpecs(runRoot).map((call) => [call.id, call]),
  );

  for (let index = 0; index < 3; index += 1) {
    const task = tasks[index];
    const taskRoot = join(runRoot, `task-${index + 1}-${task.id}`);
    const order =
      index % 2 === 0 ? ['baseline', 'treatment'] : ['treatment', 'baseline'];
    for (const condition of order) {
      await archiveAndResetPreflightCondition({
        runRoot,
        taskRoot,
        condition,
      });
    }
    const handoff = await readJson(
      join(taskRoot, 'logs', 'relay-handoff', 'stdout.log'),
    );
    await runSuccessors({
      runRoot,
      task,
      taskRoot,
      taskIndex: index,
      handoff,
      timeoutMs: options.timeoutMs,
      callById,
    });
  }

  const task4Root = join(runRoot, 'task-4-workspace-path');
  const task4Handoff = await ensureTask4Prepared(
    tasks[3],
    task4Root,
    relayBin,
    options.timeoutMs,
  );
  await runSuccessors({
    runRoot,
    task: tasks[3],
    taskRoot: task4Root,
    taskIndex: 3,
    handoff: task4Handoff,
    timeoutMs: options.timeoutMs,
    callById,
  });

  const task5Root = join(runRoot, 'task-5-event-reconciliation');
  const task5Handoff = await ensureTask5Prepared({
    runRoot,
    task: tasks[4],
    taskRoot: task5Root,
    relayBin,
    timeoutMs: options.timeoutMs,
    callById,
  });
  await runSuccessors({
    runRoot,
    task: tasks[4],
    taskRoot: task5Root,
    taskIndex: 4,
    handoff: task5Handoff,
    timeoutMs: options.timeoutMs,
    callById,
  });

  const finalPlan = await buildRecoveryPlan(runRoot);
  const taskResults = [];
  for (let index = 0; index < tasks.length; index += 1) {
    taskResults.push(
      await reconstructTaskResult({
        task: tasks[index],
        taskRoot: join(runRoot, `task-${index + 1}-${tasks[index].id}`),
        taskIndex: index,
        captureSucceeded: index !== 3,
      }),
    );
  }
  await writeFinalArtifacts(runRoot, taskResults, plan, finalPlan);
  process.stdout.write(`Complete: ${join(runRoot, 'report.md')}\n`);
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
