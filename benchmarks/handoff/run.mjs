#!/usr/bin/env node
import {
  access,
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { constants } from 'node:fs';
import { Buffer } from 'node:buffer';
import { tmpdir } from 'node:os';
import {
  basename,
  delimiter,
  dirname,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';
import { fileURLToPath } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import {
  aggregateResults,
  parseProviderMetrics,
  summarizeHandoff,
} from './lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(HERE, '../..');
const FIXTURES = join(HERE, 'fixtures');
const RELAY_BUNDLE = join(PROJECT_ROOT, 'dist/index.cjs');
export const TEMP_PARENT = join(tmpdir(), 'opencode');
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const execFileAsync = promisify(execFile);
const ANTIGRAVITY_MODEL = 'gemini-3.6-flash-low';
const CODEX_MODEL = 'gpt-5.6-sol';

function parseArguments(argv) {
  const options = {
    execute: false,
    tasks: 5,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--execute') options.execute = true;
    else if (argument === '--dry-run') options.execute = false;
    else if (argument === '--tasks') options.tasks = Number(argv[++index]);
    else if (argument === '--timeout-ms')
      options.timeoutMs = Number(argv[++index]);
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (
    !Number.isInteger(options.tasks) ||
    options.tasks < 1 ||
    options.tasks > 5
  ) {
    throw new Error('--tasks must be an integer from 1 through 5.');
  }
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1_000) {
    throw new Error('--timeout-ms must be an integer of at least 1000.');
  }
  return options;
}

export function isWithin(parent, child) {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..');
}

export async function executableOnPath(
  name,
  pathValue = process.env.PATH ?? '',
) {
  for (const directory of pathValue.split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, name);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue searching PATH without invoking the executable.
    }
  }
  return null;
}

export async function loadTasks(count) {
  const manifest = JSON.parse(
    await readFile(join(FIXTURES, 'manifest.json'), 'utf8'),
  );
  const tasks = manifest.tasks.slice(0, count);
  for (const task of tasks) {
    if (typeof task.request !== 'string' || task.request.length > 800) {
      throw new Error(
        `${task.id}: full request must fit Relay's 800-character Goal item.`,
      );
    }
  }
  return tasks;
}

async function createRunRoot() {
  const approvedParent = await realpath(TEMP_PARENT);
  const root = await mkdtemp(join(approvedParent, 'handoff-benchmark-'));
  const canonicalRoot = await realpath(root);
  if (!isWithin(approvedParent, canonicalRoot)) {
    throw new Error(`Run root escaped approved parent: ${canonicalRoot}`);
  }
  return canonicalRoot;
}

export async function createRelayWrapper(runRoot) {
  const bin = join(runRoot, 'bin');
  await mkdir(bin);
  const wrapper = join(bin, 'relay');
  const source = `#!/usr/bin/env node
import { spawn } from 'node:child_process';
const child = spawn(process.execPath, [${JSON.stringify(RELAY_BUNDLE)}, ...process.argv.slice(2)], { stdio: 'inherit' });
child.on('exit', (code, signal) => signal ? process.kill(process.pid, signal) : process.exit(code ?? 1));
`;
  await writeFile(wrapper, source, { mode: 0o700 });
  await chmod(wrapper, 0o700);
  return bin;
}

async function createTaskRelayWrapper(repo) {
  const bin = join(repo, '.relay', 'benchmark-bin');
  await mkdir(bin);
  const bundle = join(bin, 'relay.cjs');
  const wrapper = join(bin, 'relay');
  await cp(RELAY_BUNDLE, bundle);
  await writeFile(
    wrapper,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(bundle)} "$@"\n`,
    { mode: 0o700 },
  );
  await chmod(wrapper, 0o700);
  return bin;
}

export async function runCommand({
  executable,
  args,
  cwd,
  timeoutMs,
  logDirectory,
  env = process.env,
  stdin = null,
}) {
  await mkdir(logDirectory, { recursive: true });
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const childEnv = { ...env };
  delete childEnv.NODE_TEST_CONTEXT;
  delete childEnv.NODE_TEST_NAME;
  const child = spawn(executable, args, {
    cwd,
    env: childEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', (chunk) => stdout.push(chunk));
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  if (stdin !== null) child.stdin.write(stdin);
  child.stdin.end();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGTERM');
    setTimeout(() => child.kill('SIGKILL'), 5_000).unref();
  }, timeoutMs);
  const outcome = await new Promise((resolveOutcome, reject) => {
    child.on('error', reject);
    child.on('close', (exitCode, signal) =>
      resolveOutcome({ exitCode, signal }),
    );
  }).finally(() => clearTimeout(timer));
  const stdoutText = Buffer.concat(stdout).toString('utf8');
  const stderrText = Buffer.concat(stderr).toString('utf8');
  const endedAt = new Date().toISOString();
  const wallTimeMs = Math.round(performance.now() - started);
  const metadata = {
    executable,
    args,
    cwd,
    startedAt,
    endedAt,
    wallTimeMs,
    exitCode: outcome.exitCode,
    signal: outcome.signal,
    timedOut,
    environment: null,
  };
  await Promise.all([
    writeFile(join(logDirectory, 'stdout.log'), stdoutText),
    writeFile(join(logDirectory, 'stderr.log'), stderrText),
    writeFile(join(logDirectory, 'output.jsonl'), stdoutText),
    writeFile(
      join(logDirectory, 'command.json'),
      `${JSON.stringify(metadata, null, 2)}\n`,
    ),
  ]);
  return { ...metadata, stdout: stdoutText, stderr: stderrText };
}

async function checkedCommand(options) {
  const result = await runCommand(options);
  if (result.exitCode !== 0) {
    throw new Error(
      `${options.executable} ${options.args[0] ?? ''} failed; inspect ${options.logDirectory}`,
    );
  }
  return result;
}

async function copyInitial(task, destination) {
  await cp(join(FIXTURES, task.id, 'initial'), destination, {
    recursive: true,
    errorOnExist: true,
  });
}

async function initializeGit(repo, runLogRoot, timeoutMs) {
  const commands = [
    ['init', '--initial-branch=main'],
    ['config', '--local', 'user.name', 'Rirei Handoff Benchmark'],
    ['config', '--local', 'user.email', 'benchmark@noreply.invalid'],
    ['add', '--all'],
    ['commit', '-m', 'Initial benchmark fixture'],
  ];
  for (let index = 0; index < commands.length; index += 1) {
    await checkedCommand({
      executable: 'git',
      args: commands[index],
      cwd: repo,
      timeoutMs,
      logDirectory: join(runLogRoot, `git-${index + 1}`),
    });
  }
}

export async function relayCommand({
  args,
  cwd,
  relayBin,
  timeoutMs,
  logDirectory,
  stdin = null,
}) {
  return checkedCommand({
    executable: join(relayBin, 'relay'),
    args,
    cwd,
    timeoutMs,
    logDirectory,
    env: {
      ...process.env,
      PATH: `${relayBin}${delimiter}${process.env.PATH ?? ''}`,
    },
    stdin,
  });
}

export async function setupTaskRepo(task, repo, logRoot, relayBin, timeoutMs) {
  await copyInitial(task, repo);
  await initializeGit(repo, logRoot, timeoutMs);
  await relayCommand({
    args: ['init'],
    cwd: repo,
    relayBin,
    timeoutMs,
    logDirectory: join(logRoot, 'relay-init'),
  });
  const statusAfterInit = await runCommand({
    executable: 'git',
    args: ['status', '--porcelain=v1', '--untracked-files=all'],
    cwd: repo,
    timeoutMs,
    logDirectory: join(logRoot, 'relay-init-status'),
  });
  if (/(?:^|[\s"])\.relay(?:\/|[\s"])/m.test(statusAfterInit.stdout)) {
    throw new Error(
      `${task.id}: relay init left .relay visible in git status.`,
    );
  }
  await relayCommand({
    args: ['start', task.request],
    cwd: repo,
    relayBin,
    timeoutMs,
    logDirectory: join(logRoot, 'relay-start'),
  });
  await checkedCommand({
    executable: 'git',
    args: ['check-ignore', '-q', '--', '.relay/state.json'],
    cwd: repo,
    timeoutMs,
    logDirectory: join(logRoot, 'relay-check-ignore'),
  });
  return createTaskRelayWrapper(repo);
}

async function injectHidden(task, repo) {
  const target = join(repo, 'test', 'hidden.test.js');
  try {
    await lstat(target);
    throw new Error(`Hidden test already exists before injection: ${target}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await cp(join(FIXTURES, task.id, 'hidden', 'hidden.test.js'), target);
}

export async function evaluate(task, repo, logRoot, timeoutMs) {
  const publicResult = await runCommand({
    executable: process.execPath,
    args: ['--test', 'test/public.test.js'],
    cwd: repo,
    timeoutMs,
    logDirectory: join(logRoot, 'public'),
  });
  await injectHidden(task, repo);
  const hiddenResult = await runCommand({
    executable: process.execPath,
    args: ['--test', 'test/hidden.test.js'],
    cwd: repo,
    timeoutMs,
    logDirectory: join(logRoot, 'hidden'),
  });
  const combinedResult = await runCommand({
    executable: 'npm',
    args: ['test'],
    cwd: repo,
    timeoutMs,
    logDirectory: join(logRoot, 'combined'),
  });
  const summarize = (result) => ({
    passed: result.exitCode === 0,
    exitCode: result.exitCode,
    signal: result.signal,
    wallTimeMs: result.wallTimeMs,
  });
  return {
    public: summarize(publicResult),
    hidden: summarize(hiddenResult),
    combined: summarize(combinedResult),
  };
}

export async function copyWorktree(
  source,
  destination,
  { includeRelay = false } = {},
) {
  await cp(source, destination, {
    recursive: true,
    errorOnExist: true,
    filter: (entry) => {
      const rel = relative(source, entry);
      if (!includeRelay && (rel === '.relay' || rel.startsWith(`.relay${sep}`)))
        return false;
      return true;
    },
  });
  const hidden = join(destination, 'test', 'hidden.test.js');
  await rm(hidden, { force: true });
}

/** Hash the Git and working-tree state that must be identical across conditions. */
export async function repositoryFingerprint(repo) {
  const { createHash } = await import('node:crypto');
  const files = [];
  const walk = async (directory) => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(directory, entry.name);
      const rel = relative(repo, full);
      if (
        rel === '.git' ||
        rel.startsWith(`.git${sep}`) ||
        rel === '.relay' ||
        rel.startsWith(`.relay${sep}`) ||
        rel === join('test', 'hidden.test.js')
      )
        continue;
      if (entry.isDirectory()) {
        await walk(full);
      } else {
        files.push(rel);
      }
    }
  };
  await walk(repo);
  files.sort();
  const hash = createHash('sha256');
  for (const file of files) {
    const full = join(repo, file);
    const metadata = await lstat(full);
    hash
      .update('file\0')
      .update(file)
      .update('\0')
      .update(String(metadata.mode & 0o7777))
      .update('\0');
    if (metadata.isSymbolicLink()) {
      hash
        .update('symlink\0')
        .update(await readlink(full))
        .update('\0');
    } else if (metadata.isFile()) {
      hash
        .update('regular\0')
        .update(await readFile(full))
        .update('\0');
    } else {
      throw new Error(`Unsupported successor file type: ${full}`);
    }
  }
  const gitCommands = [
    ['rev-parse', '--verify', 'HEAD'],
    ['rev-parse', '--abbrev-ref', 'HEAD'],
    [
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=all',
      '--',
      '.',
      ':(exclude).relay/**',
      ':(exclude)test/hidden.test.js',
    ],
    ['ls-files', '--stage', '-z'],
    [
      'diff',
      '--binary',
      '--no-ext-diff',
      'HEAD',
      '--',
      '.',
      ':(exclude).relay/**',
      ':(exclude)test/hidden.test.js',
    ],
  ];
  for (const args of gitCommands) {
    const { stdout } = await execFileAsync('git', args, {
      cwd: repo,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
    hash
      .update('git\0')
      .update(args.join('\0'))
      .update('\0')
      .update(stdout)
      .update('\0');
  }
  return hash.digest('hex');
}

/**
 * Assert every successor-repository hygiene gate before a provider call.
 * Relay state must be physically absent and invisible to Git, hidden tests
 * must not exist, and both successor snapshots must be identical.
 */
export async function assertCleanSuccessor({
  repo,
  expectedFingerprint,
  condition,
  taskRoot,
  timeoutMs,
}) {
  let relayPresent = false;
  try {
    await lstat(join(repo, '.relay'));
    relayPresent = true;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  let hiddenTestPresent = false;
  try {
    await lstat(join(repo, 'test', 'hidden.test.js'));
    hiddenTestPresent = true;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const status = await runCommand({
    executable: 'git',
    args: ['status', '--porcelain=v1', '--untracked-files=all'],
    cwd: repo,
    timeoutMs,
    logDirectory: join(taskRoot, 'logs', condition, 'gates'),
  });
  if (status.exitCode !== 0)
    throw new Error(
      `${condition}: git status failed before the successor call.`,
    );
  const relayPathInGitStatus = /(?:^|[\s"])\.relay(?:\/|[\s"])/m.test(
    status.stdout,
  );
  const fingerprint = await repositoryFingerprint(repo);
  if (relayPresent)
    throw new Error(
      `${condition}: .relay/ must not exist before the successor call.`,
    );
  if (relayPathInGitStatus)
    throw new Error(
      `${condition}: .relay appears in git status before the successor call.`,
    );
  if (hiddenTestPresent)
    throw new Error(
      `${condition}: hidden test exists before the successor call.`,
    );
  if (fingerprint !== expectedFingerprint)
    throw new Error(
      `${condition}: successor repository differs from the pristine predecessor copy before the successor call.`,
    );
  return {
    relayStatePresentBeforeSuccessor: false,
    relayPathInGitStatus: false,
    conditionFingerprintEqual: true,
    fingerprint,
  };
}

/** Count task-request occurrences and detect successor note instructions. */
export function handoffContentChecks(handoff, task) {
  const text = handoff.text ?? '';
  const normalized = (value) =>
    String(value ?? '')
      .replace(/\s+/g, ' ')
      .trim();
  const needle = normalized(task.request);
  const normalizedText = normalized(text);
  let occurrences = 0;
  if (needle.length > 0) {
    let index = 0;
    while (index < normalizedText.length) {
      const found = normalizedText.indexOf(needle, index);
      if (found < 0) break;
      occurrences += 1;
      index = found + needle.length;
    }
  }
  return {
    duplicateTaskOccurrences: occurrences,
    containsNoteInstruction: /relay\s+note/i.test(text),
    characters: text.length,
    estimatedTokens: handoff.budget?.estimatedTokens ?? null,
  };
}

/**
 * Validate predecessor-captured notes against the fixture contract before any
 * successor call. Notes must be unresolved, agent-provenanced, current, and
 * cover every required type and text needle. Missing notes fail, never repair.
 */
export function validateCapturedNotes(handoff, task) {
  const expected = task.expectedNotes ?? {};
  const requiredTypes = expected.requiredTypes ?? [];
  const needles = expected.needles ?? {};
  const notes = handoff.capsule?.notes ?? [];
  const failures = [];
  for (const type of requiredTypes) {
    if (!notes.some((note) => note.type === type))
      failures.push(`missing note type: ${type}`);
  }
  for (const [type, needle] of Object.entries(needles)) {
    const lower = String(needle).toLowerCase();
    if (
      !notes.some(
        (note) =>
          note.type === type &&
          typeof note.text === 'string' &&
          note.text.toLowerCase().includes(lower),
      )
    )
      failures.push(`no ${type} note containing "${needle}"`);
  }
  const badProvenance = notes.filter(
    (note) =>
      note.provenance?.source !== 'agent' ||
      note.provenance?.agent !== 'antigravity',
  );
  if (badProvenance.length > 0)
    failures.push(
      `${badProvenance.length} note(s) lack antigravity agent provenance`,
    );
  const stale = notes.filter(
    (note) => note.freshness !== undefined && note.freshness !== 'current',
  );
  if (stale.length > 0)
    failures.push(`${stale.length} note(s) are not current`);
  if (notes.length !== requiredTypes.length)
    failures.push(
      `expected exactly ${requiredTypes.length} captured note(s); found ${notes.length}`,
    );
  const anchors = new Set(
    notes.map((note) =>
      JSON.stringify({
        createdAt: note.createdAt,
        commit: note.git?.commit,
        branch: note.git?.branch,
        fingerprint: note.git?.fingerprint,
      }),
    ),
  );
  if (
    notes.some(
      (note) =>
        typeof note.createdAt !== 'string' ||
        typeof note.git?.commit !== 'string' ||
        typeof note.git?.branch !== 'string' ||
        typeof note.git?.fingerprint !== 'string',
    ) ||
    anchors.size !== 1
  )
    failures.push('captured notes do not share one complete batch Git anchor');
  return {
    validated: failures.length === 0,
    failures,
    count: notes.length,
    noteTypes: [...new Set(notes.map((note) => note.type))].sort(),
  };
}

async function snapshotWorktree(repo, destination) {
  await cp(repo, destination, {
    recursive: true,
    filter: (source) => {
      const path = relative(repo, source);
      return !(
        path === '.git' ||
        path.startsWith(`.git${sep}`) ||
        path === '.relay' ||
        path.startsWith(`.relay${sep}`) ||
        path === join('test', 'hidden.test.js')
      );
    },
  });
}

async function changedLines(before, after, logRoot, timeoutMs) {
  const result = await runCommand({
    executable: 'git',
    args: ['diff', '--no-index', '--numstat', '--', before, after],
    cwd: dirname(before),
    timeoutMs,
    logDirectory: logRoot,
  });
  if (![0, 1].includes(result.exitCode)) return null;
  let additions = 0;
  let deletions = 0;
  for (const line of result.stdout.split(/\r?\n/)) {
    const [added, deleted] = line.split('\t');
    if (/^\d+$/.test(added) && /^\d+$/.test(deleted)) {
      additions += Number(added);
      deletions += Number(deleted);
    }
  }
  return { additions, deletions, total: additions + deletions };
}

function rejectedApproachRepeated(task, handoff, repoSource) {
  const rejectedNotes = handoff.capsule?.notes?.filter(
    (note) => note.type === 'rejected',
  );
  if (
    !rejectedNotes?.some((note) => note.text.includes(task.rejectedNoteNeedle))
  ) {
    return null;
  }
  return new RegExp(task.rejectedSourcePattern, 'm').test(repoSource);
}

export function providerCommands(prompt, cwd) {
  return {
    antigravity: {
      executable: 'agy',
      args: [
        '-p',
        prompt,
        '--output-format',
        'stream-json',
        '--model',
        ANTIGRAVITY_MODEL,
        '--sandbox',
        '--mode',
        'accept-edits',
        '--dangerously-skip-permissions',
      ],
      cwd,
      policy: {
        authentication: 'execute-mode preflight',
        output: 'stream-json',
        sandbox: true,
        mode: 'accept-edits',
        approval: 'bypass-permissions-inside-disposable-sandbox',
      },
    },
    codex: {
      executable: 'codex',
      args: [
        'exec',
        '--json',
        '--ephemeral',
        '--ignore-user-config',
        '--sandbox',
        'workspace-write',
        '--model',
        CODEX_MODEL,
        '-c',
        'model_reasoning_effort="low"',
        prompt,
      ],
      cwd,
      policy: {
        ephemeral: true,
        ignoreUserConfig: true,
        sandbox: 'workspace-write',
        webSearch: false,
      },
    },
  };
}

export async function preflightProviders(
  agy,
  codex,
  expectExecutable = 'expect',
) {
  const [agyModels, codexLogin, codexModels] = await Promise.all([
    execFileAsync(
      expectExecutable,
      [
        '-c',
        'set timeout 60; spawn $env(RELAY_AGY_EXECUTABLE) models; expect eof; set result [wait]; exit [lindex $result 3]',
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, RELAY_AGY_EXECUTABLE: agy },
        maxBuffer: 16 * 1024 * 1024,
        timeout: 60_000,
      },
    ),
    execFileAsync(codex, ['login', 'status'], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      timeout: 60_000,
    }),
    execFileAsync(codex, ['debug', 'models'], {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      timeout: 60_000,
    }),
  ]);
  if (!agyModels.stdout.includes(ANTIGRAVITY_MODEL))
    throw new Error(
      `Refusing --execute: Antigravity model ${ANTIGRAVITY_MODEL} is unavailable.`,
    );
  if (!codexModels.stdout.includes(CODEX_MODEL))
    throw new Error(
      `Refusing --execute: Codex model ${CODEX_MODEL} is unavailable.`,
    );
  if (!/logged in|authenticated/i.test(codexLogin.stdout + codexLogin.stderr))
    throw new Error(
      'Refusing --execute: Codex authentication was not confirmed.',
    );
  return {
    antigravity: {
      executable: agy,
      model: ANTIGRAVITY_MODEL,
      authenticationChecked: true,
      commandPolicy: providerCommands('', '.').antigravity.policy,
    },
    codex: {
      executable: codex,
      model: CODEX_MODEL,
      authenticationChecked: true,
      commandPolicy: providerCommands('', '.').codex.policy,
    },
  };
}

export async function runDryTask(task, taskRoot, relayBin, timeoutMs) {
  const repo = join(taskRoot, 'repo');
  await copyInitial(task, repo);
  await initializeGit(repo, join(taskRoot, 'logs', 'setup'), timeoutMs);
  const initial = await runCommand({
    executable: process.execPath,
    args: ['--test', 'test/public.test.js'],
    cwd: repo,
    timeoutMs,
    logDirectory: join(taskRoot, 'logs', 'initial-public'),
  });
  if (initial.exitCode === 0) {
    throw new Error(
      `${task.id}: initial implementation unexpectedly passed public tests.`,
    );
  }

  await relayCommand({
    args: ['init'],
    cwd: repo,
    relayBin,
    timeoutMs,
    logDirectory: join(taskRoot, 'logs', 'relay-init'),
  });
  const statusAfterInit = await runCommand({
    executable: 'git',
    args: ['status', '--porcelain=v1', '--untracked-files=all'],
    cwd: repo,
    timeoutMs,
    logDirectory: join(taskRoot, 'logs', 'relay-init-status'),
  });
  if (/(?:^|[\s"])\.relay(?:\/|[\s"])/m.test(statusAfterInit.stdout)) {
    throw new Error(
      `${task.id}: relay init left .relay visible in git status.`,
    );
  }
  await relayCommand({
    args: ['start', task.request],
    cwd: repo,
    relayBin,
    timeoutMs,
    logDirectory: join(taskRoot, 'logs', 'relay-start'),
  });
  await checkedCommand({
    executable: 'git',
    args: ['check-ignore', '-q', '--', '.relay/state.json'],
    cwd: repo,
    timeoutMs,
    logDirectory: join(taskRoot, 'logs', 'relay-check-ignore'),
  });

  const expectedNotes = task.expectedNotes ?? {};
  const requiredTypes = expectedNotes.requiredTypes ?? [];
  const needles = expectedNotes.needles ?? {};
  const notes = requiredTypes.map((type, index) => ({
    type,
    text: needles[type]
      ? `fixture ${type}: ${needles[type]}`
      : `fixture ${type} ${index}`,
  }));
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
    timeoutMs,
    logDirectory: join(taskRoot, 'logs', 'relay-note-import'),
    stdin: `${JSON.stringify({ schemaVersion: 1, notes })}\n`,
  });
  const handoff = await relayCommand({
    args: ['handoff', '--json'],
    cwd: repo,
    relayBin,
    timeoutMs,
    logDirectory: join(taskRoot, 'logs', 'relay-handoff'),
  });
  const rendered = JSON.parse(handoff.stdout);
  if ((rendered.budget?.estimatedTokens ?? null) > 300) {
    throw new Error(
      `${task.id}: handoff exceeds 300 estimated tokens (${rendered.budget.estimatedTokens}).`,
    );
  }
  if ((rendered.budget?.usedCharacters ?? null) > 1_200) {
    throw new Error(
      `${task.id}: handoff exceeds 1,200 characters (${rendered.budget.usedCharacters}).`,
    );
  }
  const checks = handoffContentChecks(rendered, task);
  if (checks.duplicateTaskOccurrences !== 1) {
    throw new Error(
      `${task.id}: task request must appear exactly once; found ${checks.duplicateTaskOccurrences}.`,
    );
  }
  if (checks.containsNoteInstruction) {
    throw new Error(`${task.id}: handoff must not instruct note recording.`);
  }
  const capture = validateCapturedNotes(rendered, task);
  if (!capture.validated)
    throw new Error(
      `${task.id}: dry-run note capture failed: ${capture.failures.join('; ')}`,
    );

  const baselineRepo = join(taskRoot, 'dry-baseline');
  const treatmentRepo = join(taskRoot, 'dry-treatment');
  await copyWorktree(repo, baselineRepo);
  await copyWorktree(repo, treatmentRepo);
  const [baselineFingerprint, treatmentFingerprint] = await Promise.all([
    repositoryFingerprint(baselineRepo),
    repositoryFingerprint(treatmentRepo),
  ]);
  if (baselineFingerprint !== treatmentFingerprint)
    throw new Error(
      `${task.id}: dry-run successor repositories are not identical.`,
    );
  const [baselineGates, treatmentGates] = await Promise.all([
    assertCleanSuccessor({
      repo: baselineRepo,
      expectedFingerprint: baselineFingerprint,
      condition: 'dry-baseline',
      taskRoot,
      timeoutMs,
    }),
    assertCleanSuccessor({
      repo: treatmentRepo,
      expectedFingerprint: baselineFingerprint,
      condition: 'dry-treatment',
      taskRoot,
      timeoutMs,
    }),
  ]);

  await cp(
    join(FIXTURES, task.id, 'reference', 'index.js'),
    join(repo, 'src', 'index.js'),
  );
  const publicReference = await runCommand({
    executable: process.execPath,
    args: ['--test', 'test/public.test.js'],
    cwd: repo,
    timeoutMs,
    logDirectory: join(taskRoot, 'logs', 'reference-public'),
  });
  await injectHidden(task, repo);
  const combinedReference = await runCommand({
    executable: 'npm',
    args: ['test'],
    cwd: repo,
    timeoutMs,
    logDirectory: join(taskRoot, 'logs', 'reference-combined'),
  });
  if (publicReference.exitCode !== 0 || combinedReference.exitCode !== 0) {
    throw new Error(`${task.id}: reference solution did not pass its tests.`);
  }
  return {
    taskId: task.id,
    initialPublicFailedAsExpected: true,
    referencePublicPassed: true,
    referencePublicAndHiddenPassed: true,
    relayHiddenAfterInit: !/(?:^|[\s"])\.relay(?:\/|[\s"])/m.test(
      statusAfterInit.stdout,
    ),
    relayExcludedAfterStart: true,
    captureValidated: true,
    successorGates: {
      baseline: baselineGates,
      treatment: treatmentGates,
    },
    handoff: {
      characters: checks.characters,
      estimatedTokens: checks.estimatedTokens,
      duplicateTaskOccurrences: checks.duplicateTaskOccurrences,
      containsNoteInstruction: checks.containsNoteInstruction,
    },
  };
}

export async function runCondition({
  task,
  condition,
  repo,
  expectedFingerprint,
  prompt,
  handoff,
  taskRoot,
  timeoutMs,
}) {
  const gates = await assertCleanSuccessor({
    repo,
    expectedFingerprint,
    condition,
    taskRoot,
    timeoutMs,
  });
  const promptSha256 = await sha256(prompt);
  let treatmentPromptHashEqual = null;
  if (condition === 'treatment') {
    const capturedHandoffSha256 = await sha256(handoff.text);
    treatmentPromptHashEqual = promptSha256 === capturedHandoffSha256;
    if (prompt !== handoff.text || !treatmentPromptHashEqual)
      throw new Error(
        'treatment: launched prompt differs from the captured handoff.',
      );
    if (/relay\s+note/i.test(prompt))
      throw new Error('treatment: launched prompt instructs note recording.');
  }
  const snapshot = join(taskRoot, `${condition}-predecessor-snapshot`);
  await snapshotWorktree(repo, snapshot);
  const command = providerCommands(prompt, repo).codex;
  const providerLog = join(taskRoot, 'logs', condition, 'provider');
  const providerResult = await runCommand({
    executable: command.executable,
    args: command.args,
    cwd: command.cwd,
    timeoutMs,
    logDirectory: providerLog,
  });
  const evaluation = await evaluate(
    task,
    repo,
    join(taskRoot, 'logs', condition, 'evaluation'),
    timeoutMs,
  );
  const finalSnapshot = join(taskRoot, `${condition}-final-snapshot`);
  await snapshotWorktree(repo, finalSnapshot);
  const changes = await changedLines(
    snapshot,
    finalSnapshot,
    join(taskRoot, 'logs', condition, 'changed-lines'),
    timeoutMs,
  );
  const source = await readFile(join(repo, 'src', 'index.js'), 'utf8');
  return {
    condition,
    prompt: {
      kind:
        condition === 'baseline'
          ? 'full-request-plus-inspection'
          : 'exact-handoff',
      characters: prompt.length,
      sha256: promptSha256,
      matchesCapturedHandoff: treatmentPromptHashEqual,
    },
    command: {
      executable: command.executable,
      args: command.args,
      cwd: command.cwd,
      policy: command.policy,
    },
    wallTimeMs: providerResult.wallTimeMs,
    exitCode: providerResult.exitCode,
    signal: providerResult.signal,
    timedOut: providerResult.timedOut,
    metrics: parseProviderMetrics('codex', providerResult.stdout),
    evaluation,
    changedLines: changes,
    rejectedApproachRepeated: rejectedApproachRepeated(task, handoff, source),
    relayStateAccessed: /(?:^|[\s"'])\.relay(?:\/|[\s"'])/m.test(
      providerResult.stdout,
    ),
    ...gates,
  };
}

export async function sha256(text) {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(text).digest('hex');
}

function publicCommand(command) {
  const modelIndex = command.args?.indexOf('--model') ?? -1;
  const { authenticated: _authenticated, ...policy } = command.policy ?? {};
  return {
    executable: command.executable,
    model: modelIndex >= 0 ? command.args[modelIndex + 1] : null,
    policy,
  };
}

/** Remove private paths and raw prompts before a result is published. */
export function publicationResult(result) {
  const {
    runRoot: _runRoot,
    relayBundle: _relayBundle,
    preflight,
    ...safe
  } = result;
  return {
    ...safe,
    publication: {
      privatePathsRedacted: true,
      rawPromptsExcluded: true,
      rawProviderLogsExcluded: true,
      rawArtifacts: 'retained only in the disposable run root',
    },
    preflight: preflight
      ? Object.fromEntries(
          Object.entries(preflight).map(([provider, value]) => [
            provider,
            { ...value, executable: basename(value.executable) },
          ]),
        )
      : undefined,
    tasks: result.tasks.map((task) => ({
      ...task,
      predecessor: task.predecessor
        ? {
            ...task.predecessor,
            command: publicCommand(task.predecessor.command),
          }
        : task.predecessor,
      conditions: Object.fromEntries(
        Object.entries(task.conditions ?? {}).map(([condition, value]) => [
          condition,
          { ...value, command: publicCommand(value.command) },
        ]),
      ),
    })),
  };
}

async function runExecuteTask(task, taskRoot, relayBin, timeoutMs, taskIndex) {
  const predecessorRepo = join(taskRoot, 'predecessor');
  if (!isWithin(taskRoot, predecessorRepo)) {
    throw new Error(
      `Predecessor repo escaped disposable task root: ${predecessorRepo}`,
    );
  }
  const taskRelayBin = await setupTaskRepo(
    task,
    predecessorRepo,
    join(taskRoot, 'logs', 'setup'),
    relayBin,
    timeoutMs,
  );
  const phase = await readFile(join(FIXTURES, task.id, 'phase.md'), 'utf8');
  const predecessorPrompt = `${task.request}\n\n${phase}\n\nRepository safety requirement: the actual repository is exactly ${predecessorRepo}. Use only that repository and never use ~/.gemini/antigravity-cli/scratch. Every file edit, test command, and Relay note command must target this absolute path or first cd to ${predecessorRepo}. Do not create or modify task files or Relay notes anywhere else.`;
  const predecessorCommand = providerCommands(
    predecessorPrompt,
    predecessorRepo,
  ).antigravity;
  const predecessor = await runCommand({
    executable: predecessorCommand.executable,
    args: predecessorCommand.args,
    cwd: predecessorCommand.cwd,
    timeoutMs,
    logDirectory: join(taskRoot, 'logs', 'predecessor-provider'),
    env: {
      ...process.env,
      PATH: `${taskRelayBin}${delimiter}${process.env.PATH ?? ''}`,
    },
  });
  if (predecessor.exitCode !== 0) {
    throw new Error(
      `${task.id}: Antigravity predecessor failed; inspect ${join(taskRoot, 'logs', 'predecessor-provider')}`,
    );
  }
  const predecessorPublic = await runCommand({
    executable: process.execPath,
    args: ['--test', 'test/public.test.js'],
    cwd: predecessorRepo,
    timeoutMs,
    logDirectory: join(taskRoot, 'logs', 'predecessor-public'),
  });
  if (predecessorPublic.exitCode !== 0) {
    throw new Error(
      `${task.id}: predecessor did not complete the controlled public phase.`,
    );
  }
  const interruptedValidation = join(taskRoot, 'interrupted-validation');
  await copyWorktree(predecessorRepo, interruptedValidation);
  await injectHidden(task, interruptedValidation);
  const predecessorHidden = await runCommand({
    executable: process.execPath,
    args: ['--test', 'test/hidden.test.js'],
    cwd: interruptedValidation,
    timeoutMs,
    logDirectory: join(taskRoot, 'logs', 'predecessor-hidden'),
  });
  if (predecessorHidden.exitCode === 0) {
    throw new Error(
      `${task.id}: predecessor completed hidden work, so no interruption remained to benchmark.`,
    );
  }
  const checkpoint = await relayCommand({
    args: [
      'checkpoint',
      '--message',
      'Interrupted after controlled first phase',
    ],
    cwd: predecessorRepo,
    relayBin,
    timeoutMs,
    logDirectory: join(taskRoot, 'logs', 'relay-checkpoint'),
  });
  const handoffResult = await relayCommand({
    args: ['handoff', '--json'],
    cwd: predecessorRepo,
    relayBin,
    timeoutMs,
    logDirectory: join(taskRoot, 'logs', 'relay-handoff'),
  });
  const handoff = JSON.parse(handoffResult.stdout);
  const capture = validateCapturedNotes(handoff, task);
  if (!capture.validated) {
    throw new Error(
      `${task.id}: predecessor capture validation failed before successor calls: ${capture.failures.join('; ')}`,
    );
  }
  const contentChecks = handoffContentChecks(handoff, task);
  if (contentChecks.duplicateTaskOccurrences !== 1) {
    throw new Error(
      `${task.id}: task request must appear exactly once in the handoff; found ${contentChecks.duplicateTaskOccurrences}.`,
    );
  }
  if (contentChecks.containsNoteInstruction) {
    throw new Error(`${task.id}: handoff must not instruct note recording.`);
  }
  const baselineRepo = join(taskRoot, 'baseline');
  const treatmentRepo = join(taskRoot, 'treatment');
  if (!isWithin(taskRoot, baselineRepo) || !isWithin(taskRoot, treatmentRepo)) {
    throw new Error('Successor repo escaped disposable task root.');
  }
  await copyWorktree(predecessorRepo, baselineRepo);
  await copyWorktree(predecessorRepo, treatmentRepo);
  const [expectedFingerprint, treatmentFingerprint] = await Promise.all([
    repositoryFingerprint(baselineRepo),
    repositoryFingerprint(treatmentRepo),
  ]);
  if (expectedFingerprint !== treatmentFingerprint)
    throw new Error(
      `${task.id}: successor repositories differ before provider calls.`,
    );
  const baselinePrompt = `${task.request}\n\nInspect the working tree and preserve existing changes. Finish the implementation and run all public tests.`;
  const prompts = { baseline: baselinePrompt, treatment: handoff.text };
  const repos = { baseline: baselineRepo, treatment: treatmentRepo };
  const order =
    taskIndex % 2 === 0 ? ['baseline', 'treatment'] : ['treatment', 'baseline'];
  const conditions = {};
  for (const condition of order) {
    conditions[condition] = await runCondition({
      task,
      condition,
      repo: repos[condition],
      expectedFingerprint,
      prompt: prompts[condition],
      handoff,
      taskRoot,
      timeoutMs,
    });
  }
  return {
    taskId: task.id,
    title: task.title,
    order,
    capture: {
      validated: true,
      count: capture.count,
      noteTypes: capture.noteTypes,
    },
    handoff: {
      ...summarizeHandoff(handoff),
      ...contentChecks,
    },
    predecessor: {
      command: {
        executable: predecessorCommand.executable,
        args: predecessorCommand.args,
        cwd: predecessorCommand.cwd,
        policy: predecessorCommand.policy,
      },
      wallTimeMs: predecessor.wallTimeMs,
      exitCode: predecessor.exitCode,
      signal: predecessor.signal,
      timedOut: predecessor.timedOut,
      metrics: parseProviderMetrics('antigravity', predecessor.stdout),
      checkpointExitCode: checkpoint.exitCode,
      publicPhasePassed: true,
      hiddenWorkRemained: true,
    },
    conditions,
  };
}

export function markdownReport(result, analysis) {
  const lines = [
    '# Rirei handoff benchmark report',
    '',
    `Mode: ${result.mode}`,
    `Tasks: ${result.taskCount}`,
    `Provider commands: ${result.providerCommandCount}`,
    '',
  ];
  if (result.mode === 'dry-run') {
    lines.push(
      '## Validation',
      '',
      ...result.tasks.map(
        (task) =>
          `- ${task.taskId}: initial public failure expected; reference public+hidden pass; capture valid; handoff ${task.handoff?.estimatedTokens ?? 'n/a'} est. tokens / ${task.handoff?.characters ?? 'n/a'} chars, request once, no note instruction; both successors fingerprint-equal with .relay and hidden tests absent.`,
      ),
      '',
      'No provider command was invoked.',
    );
    return `${lines.join('\n')}\n`;
  }
  const providerFailures = result.tasks.reduce(
    (count, task) =>
      count +
      Number(task.predecessor?.exitCode !== 0) +
      Object.values(task.conditions ?? {}).filter(
        (condition) => condition.exitCode !== 0 || condition.timedOut,
      ).length,
    0,
  );
  const missingMetricFields = result.tasks.reduce(
    (count, task) =>
      count +
      Object.values(task.conditions ?? {}).reduce(
        (conditionCount, condition) =>
          conditionCount +
          ['inputTokens', 'cachedInputTokens', 'outputTokens'].filter(
            (field) => condition.metrics?.[field] == null,
          ).length,
        0,
      ),
    0,
  );
  lines.push(
    '## Verdict',
    '',
    analysis.summary.decisionRule.passed
      ? 'The predeclared directional decision rule passed.'
      : 'The predeclared directional decision rule did not pass.',
    '',
    '## Paired results',
    '',
    '| Task | Order | Baseline pass | Treatment pass | Time delta ms | Non-cached token delta | >=20% | Handoff chars | Est. tokens | Captured note types | Relay absent |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: |',
    ...analysis.pairs.map((pair, index) => {
      const task = result.tasks[index];
      const relayAbsent = Object.values(task.conditions ?? {}).every(
        (condition) =>
          condition.relayStatePresentBeforeSuccessor === false &&
          condition.relayPathInGitStatus === false,
      );
      return `| ${pair.taskId} | ${pair.order.join(' then ')} | ${pair.correctness.baseline} | ${pair.correctness.treatment} | ${pair.wallTimeDeltaMs} | ${pair.nonCachedTokenDelta ?? 'unavailable'} | ${pair.reachesTwentyPercent} | ${task.handoff?.characters ?? 'n/a'} | ${pair.handoffTokens} | ${(task.capture?.noteTypes ?? []).join(', ')} | ${relayAbsent} |`;
    }),
    '',
    '## Totals',
    '',
    `- Non-cached successor tokens (input minus cached input plus output): baseline ${analysis.summary.totals.nonCachedTokens.baseline ?? 'unavailable'}; treatment ${analysis.summary.totals.nonCachedTokens.treatment ?? 'unavailable'}.`,
    `- Successor wall time: baseline ${analysis.summary.totals.wallTimeMs.baseline} ms; treatment ${analysis.summary.totals.wallTimeMs.treatment} ms; delta ${analysis.summary.totals.wallTimeMs.delta} ms.`,
    `- Paired non-cached-token delta: mean ${analysis.summary.nonCachedTokenDelta.mean ?? 'unavailable'}; median ${analysis.summary.nonCachedTokenDelta.median ?? 'unavailable'}.`,
    `- Paired wall-time delta: mean ${analysis.summary.wallTimeDeltaMs.mean ?? 'unavailable'} ms; median ${analysis.summary.wallTimeDeltaMs.median ?? 'unavailable'} ms.`,
    '',
    '## Correctness',
    '',
    `- Baseline: ${analysis.summary.successCounts.baseline}/${result.taskCount}.`,
    `- Treatment: ${analysis.summary.successCounts.treatment}/${result.taskCount}.`,
    `- Tasks reaching the 20% threshold: ${analysis.summary.improvedTasks}/${result.taskCount}.`,
    `- Decision rule passed: ${analysis.summary.decisionRule.passed}.`,
    '',
    '## Capture and integrity',
    '',
    `- Predecessor captures validated: ${result.tasks.filter((task) => task.capture?.validated).length}/${result.taskCount}.`,
    `- Handoff task-request occurrences: ${result.tasks.map((task) => task.handoff?.duplicateTaskOccurrences ?? 'n/a').join(', ')}.`,
    `- Handoffs containing successor note instructions: ${result.tasks.filter((task) => task.handoff?.containsNoteInstruction).length}.`,
    `- Successor gate failures: ${result.tasks.reduce((count, task) => count + Object.values(task.conditions ?? {}).filter((condition) => condition.relayStatePresentBeforeSuccessor || condition.relayPathInGitStatus || !condition.conditionFingerprintEqual).length, 0)}.`,
    `- Treatment prompt hashes matched the captured handoff before launch: ${result.tasks.filter((task) => task.conditions?.treatment?.prompt?.matchesCapturedHandoff === true).length}/${result.taskCount}.`,
    `- Dry-run reference validations completed before execution: ${result.dryRunValidation?.length ?? 0}/${result.taskCount}.`,
    '',
    '## Provider execution',
    '',
    `- Intended provider calls: ${result.providerCommandCount}; failures or timeouts: ${providerFailures}; retries: 0.`,
    `- Missing required successor metric fields: ${missingMetricFields}. Missing metrics remain null and are never inferred.`,
    '- No manual causal review was required when both conditions were correct; treatment failures would require one.',
    '',
    '## Limitations',
    '',
    '- These are five fixed synthetic tasks and do not establish statistical significance.',
    '- The experiment measures successor continuation cost; incremental predecessor note-capture cost is excluded from paired deltas.',
    '- Machine load, provider releases, authentication state, and JSONL schema changes can affect results.',
    '- Raw prompts, provider logs, Relay state, credentials, and private paths are excluded from publication artifacts.',
    ...(result.integrityVersion === 'v2-pre-hardening'
      ? [
          '- This historical run predates full HEAD/index/diff equality and pre-call hash gates; it is not final V2 integrity evidence.',
        ]
      : []),
  );
  return `${lines.join('\n')}\n`;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  await access(TEMP_PARENT, constants.R_OK | constants.W_OK);
  const tasks = await loadTasks(options.tasks);
  let preflight = null;
  if (options.execute) {
    await access(RELAY_BUNDLE, constants.R_OK);
    const [agy, codex, expectExecutable] = await Promise.all([
      executableOnPath('agy'),
      executableOnPath('codex'),
      executableOnPath('expect'),
    ]);
    if (!agy || !codex || !expectExecutable) {
      throw new Error(
        'Refusing --execute: agy, codex, and expect must be executable on PATH.',
      );
    }
    preflight = await preflightProviders(agy, codex, expectExecutable);
    process.stdout.write(
      `Provider preflight passed: agy=${agy} model=${ANTIGRAVITY_MODEL}; codex=${codex} model=${CODEX_MODEL}.\n`,
    );
  }
  const runRoot = await createRunRoot();
  const relayBin = await createRelayWrapper(runRoot);
  await writeFile(
    join(runRoot, 'preflight.json'),
    `${JSON.stringify(preflight, null, 2)}\n`,
  );
  process.stdout.write(`Run root: ${runRoot}\n`);
  process.stdout.write(
    `${options.execute ? 'Execute' : 'Dry-run'} mode; ${tasks.length} task(s); expected provider commands: ${options.execute ? tasks.length * 3 : 0}\n`,
  );
  const dryRunValidation = [];
  if (options.execute) {
    process.stdout.write(
      'Running all zero-provider dry-run gates before execution.\n',
    );
    for (let index = 0; index < tasks.length; index += 1) {
      const task = tasks[index];
      const preflightTaskRoot = join(
        runRoot,
        `preflight-task-${index + 1}-${task.id}`,
      );
      await mkdir(preflightTaskRoot);
      dryRunValidation.push(
        await runDryTask(task, preflightTaskRoot, relayBin, options.timeoutMs),
      );
    }
  }
  const taskResults = [];
  for (let index = 0; index < tasks.length; index += 1) {
    const task = tasks[index];
    process.stdout.write(`[${index + 1}/${tasks.length}] ${task.id}\n`);
    const taskRoot = join(runRoot, `task-${index + 1}-${task.id}`);
    if (!isWithin(runRoot, taskRoot)) {
      throw new Error(`Task path escaped approved run root: ${taskRoot}`);
    }
    await mkdir(taskRoot);
    taskResults.push(
      options.execute
        ? await runExecuteTask(
            task,
            taskRoot,
            relayBin,
            options.timeoutMs,
            index,
          )
        : await runDryTask(task, taskRoot, relayBin, options.timeoutMs),
    );
  }
  const result = {
    schemaVersion: 1,
    integrityVersion: 'v2-full-git-state-v1',
    mode: options.execute ? 'execute' : 'dry-run',
    createdAt: new Date().toISOString(),
    runRoot,
    taskCount: tasks.length,
    providerCommandCount: options.execute ? tasks.length * 3 : 0,
    relayBundle: RELAY_BUNDLE,
    preflight,
    dryRunValidation,
    tasks: taskResults,
  };
  const analysis = options.execute ? aggregateResults(taskResults) : null;
  const publishable = publicationResult(result);
  await Promise.all([
    writeFile(
      join(runRoot, 'result.json'),
      `${JSON.stringify(result, null, 2)}\n`,
    ),
    writeFile(
      join(runRoot, 'analysis.json'),
      `${JSON.stringify(analysis, null, 2)}\n`,
    ),
    writeFile(join(runRoot, 'report.md'), markdownReport(result, analysis)),
    writeFile(
      join(runRoot, 'public-result.json'),
      `${JSON.stringify(publishable, null, 2)}\n`,
    ),
    writeFile(
      join(runRoot, 'public-report.md'),
      markdownReport(publishable, analysis),
    ),
  ]);
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
