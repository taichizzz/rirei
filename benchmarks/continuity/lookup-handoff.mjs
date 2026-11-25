import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { URL, fileURLToPath } from 'node:url';
import { isDeepStrictEqual, promisify } from 'node:util';
import { readConfig, writeConfig } from '../../src/config/loader.ts';
import {
  appendCapturedObservation,
  issueCaptureGrant,
  readContextJournal,
  setContextConsent,
} from '../../src/context/store.ts';
import {
  beginVerification,
  completeVerification,
} from '../../src/context/verification.ts';
import { inspectGitSnapshot } from '../../src/git/repository.ts';
import { project, sourceFiles } from './bidirectional.mjs';
import {
  E1_CONTEXT_HELPER,
  installReadOnlyHelper,
  renderE1ReceiverPrompt,
} from './e1.mjs';
import { fingerprint } from './workflows.mjs';

const execute = promisify(execFile);
const cli = fileURLToPath(new URL('../../dist/index.cjs', import.meta.url));
const dependencies = fileURLToPath(
  new URL('../../node_modules/', import.meta.url),
);
const implementation = 'src/export.mjs';
const request =
  'Finish the partner export. Preserve the incoming row ID and use the ready label.';
const correction =
  'Correction: the ready label is obsolete. Use the exact EXPECTED_LABEL from the failed partner compatibility probe. Keep the incoming row ID unchanged.';
const testArgs = ['--test', '--test-reporter=tap', 'test/public.test.mjs'];
const testCommand = `node ${testArgs.join(' ')}`;
const shadowedExit = 73;
const exportSource = (label, idField = 'id') =>
  `export const exportRow = (row) => ({ id: row.${idField}, label: ${JSON.stringify(label)} });\n`;

/** Materialize one disposable checkpoint. Only the caller holds the grading answer. */
export async function prepareLookupHandoffFixture(
  workspace,
  { cliPath = cli } = {},
) {
  const cliOptions = {
    cwd: workspace,
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          ([key]) =>
            !key.startsWith('RIREI_') && key !== 'BASH_ENV' && key !== 'ENV',
        ),
      ),
      RIREI_DATA_HOME: process.env.RIREI_DATA_HOME,
      NODE_PATH: dependencies,
    },
    timeout: 15000,
    maxBuffer: 512 * 1024,
  };
  const state = await project(
    workspace,
    {
      'package.json': '{"type":"module","private":true}\n',
      [implementation]: exportSource('ready'),
      'test/public.test.mjs': `import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { exportRow } from '../src/export.mjs';
test('export preserves the ID', () => {
  assert.equal(exportRow({ id: 'parcel-5' }).id, 'parcel-5');
  const source = readFileSync(new URL('../src/export.mjs', import.meta.url));
  console.log('verified-export-sha256 ' + createHash('sha256').update(source).digest('hex'));
});
`,
    },
    request,
  );
  const config = await readConfig(workspace);
  await writeConfig(workspace, {
    ...config,
    tests: { ...config.tests, command: testCommand },
  });
  const helpers = await installReadOnlyHelper(workspace, cliPath, dependencies);

  const verify = async () => {
    const sourceHash = fingerprint(
      await readFile(path.join(workspace, implementation)),
    );
    const checked = await execute(process.execPath, testArgs, cliOptions);
    assert.match(checked.stdout, /^# pass 1$/m);
    assert.ok(
      checked.stdout.includes(`# verified-export-sha256 ${sourceHash}\n`),
    );
  };
  const pending = await beginVerification(
    workspace,
    state.sessionId,
    testCommand,
  );
  const started = performance.now();
  await verify();
  const prior = await completeVerification(
    workspace,
    pending,
    0,
    performance.now() - started,
  );
  const oldSnapshot = await inspectGitSnapshot(workspace, 1);
  // Interrupt after a source edit that makes the last passing public check stale.
  await writeFile(
    path.join(workspace, implementation),
    exportSource('draft', 'key'),
  );

  const expectedLabel = `partner-${randomBytes(8).toString('hex')}`;
  await setContextConsent(workspace, state.sessionId, true);
  const runId = 'lookup-fixture';
  const issued = await issueCaptureGrant(workspace, {
    taskId: state.sessionId,
    runId,
    workspace,
    provider: 'claude',
    providerSessionId: 'lookup-fixture',
    launchGitFingerprint: oldSnapshot.fingerprint,
  });
  assert.ok(issued);
  const append = (event) =>
    appendCapturedObservation(workspace, state.sessionId, runId, issued.token, {
      provider: 'claude',
      providerSessionId: 'lookup-fixture',
      hook: 'fixture',
      truncated: false,
      redacted: false,
      ...event,
    });
  await append({ kind: 'prompt_submission', text: request });
  const evidence = await append({
    kind: 'tool_result',
    command: 'partner-compatibility-probe',
    filePath: implementation,
    exitCode: 1,
    outcome: 'reported_failure',
    // Preview suppression keeps the path (and the label on this record) out of the handoff.
    text: `Mismatch in /tmp/previous-partner-checkout.\nEXPECTED_LABEL=${expectedLabel}\n`,
  });
  await append({ kind: 'prompt_submission', text: correction });

  const renderStarted = performance.now();
  const rendered = await execute(
    process.execPath,
    [cliPath, 'handoff', '--json'],
    cliOptions,
  );
  const renderMs = performance.now() - renderStarted;
  const handoff = JSON.parse(rendered.stdout);
  const prompt = renderE1ReceiverPrompt(workspace, request, handoff.text);
  const latest = handoff.capsule.verification.at(-1);
  assert.equal(latest.freshness, 'stale');
  assert.equal(latest.receiptId, prior.id);
  assert.ok(evidence && handoff.continuity.partialEvents.includes(evidence.id));
  assert.ok(
    prompt.includes(correction),
    'The correction must reach the receiver.',
  );
  assert.ok(
    !prompt.includes(expectedLabel),
    'The inline prompt leaked the answer.',
  );
  const beforeFiles = await sourceFiles(workspace);
  assert.ok(
    Object.values(beforeFiles).every((text) => !text.includes(expectedLabel)),
  );
  const protectedFiles = [
    path.join(workspace, '.relay/state.json'),
    path.join(workspace, '.relay/config.json'),
    ...helpers,
  ];
  const protectedHashes = async () =>
    Promise.all(
      protectedFiles.map(async (file) => fingerprint(await readFile(file))),
    );
  const beforeProtected = await protectedHashes();
  const journal = () => readContextJournal(workspace, state.sessionId);
  const beforeJournal = (await journal()).digest;

  const grade = async () => {
    const evaluated = await execute(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { exportRow } from './${implementation}'; process.stdout.write(JSON.stringify(['parcel-7', 'parcel-9'].map(id => exportRow({ id }))));`,
      ],
      cliOptions,
    );
    return isDeepStrictEqual(JSON.parse(evaluated.stdout), [
      { id: 'parcel-7', label: expectedLabel },
      { id: 'parcel-9', label: expectedLabel },
    ]);
  };
  return {
    cliOptions,
    prompt,
    handoff,
    renderMs,
    evidence,
    beforeFiles,
    expectedLabel,
    priorTest: { exitCode: prior.exitCode, freshness: latest.freshness },
    verify,
    grade,
    protectedInputsUnchanged: async () =>
      isDeepStrictEqual(await protectedHashes(), beforeProtected) &&
      (await journal()).digest === beforeJournal,
  };
}

/** Uses only the given handoff plus the real CLI response; the expected value lives in the grader. */
async function receive(prompt, { login, workspace, verify }) {
  const helper = /^Context lookup: `([^`\s]+) context`\./m.exec(prompt)?.[1];
  const id =
    /^Execution "partner-compatibility-probe" \[(e-[a-f0-9]{32})\]: reported command exit 1\./m.exec(
      prompt,
    )?.[1];
  assert.ok(
    helper && id,
    'Handoff did not supply a helper and a cited failure.',
  );
  assert.ok(prompt.includes(correction), 'The correction is required.');
  assert.match(
    prompt,
    /^Verification: \[stale\].*does not verify current inputs/m,
  );
  let stdout;
  try {
    ({ stdout } = await login(
      helper,
      'context',
      'evidence',
      id,
      '--start',
      '0',
      '--length',
      '200',
    ));
  } catch (error) {
    if (error.code !== shadowedExit) throw error;
    return { lookupExitCode: shadowedExit, freshVerificationExitCode: null };
  }
  const { result } = JSON.parse(stdout);
  assert.equal(result.kind, 'evidence-window');
  assert.equal(result.source.id, id);
  assert.equal(result.source.reportedExitCode, 1);
  assert.equal(result.nextCursor, null);
  const label = /^EXPECTED_LABEL=(partner-[a-f0-9]{16})$/m.exec(
    result.text,
  )?.[1];
  assert.ok(label, 'The cited evidence did not contain the exact label.');
  await writeFile(path.join(workspace, implementation), exportSource(label));
  await verify();
  return {
    lookupExitCode: 0,
    freshVerificationExitCode: 0,
    evidenceDigest: result.source.recordDigest,
    evidenceTextDigest: fingerprint(result.text),
    returnedBytes: Buffer.byteLength(stdout),
  };
}

export async function lookupHandoffBenchmark() {
  assert.notEqual(
    process.platform,
    'win32',
    'The E1 helper uses a POSIX shell.',
  );
  const base = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "rirei lookup's $fixture-")),
  );
  const oldHome = process.env.RIREI_DATA_HOME;
  const dataHome = path.join(base, 'data');
  process.env.RIREI_DATA_HOME = dataHome;
  try {
    const workspace = path.join(base, 'work');
    const fixture = await prepareLookupHandoffFixture(workspace);
    const { prompt, beforeFiles, evidence, expectedLabel, verify, grade } =
      fixture;

    const shellHome = path.join(base, 'login');
    const decoyDir = path.join(base, 'installed');
    await Promise.all([mkdir(shellHome), mkdir(decoyDir)]);
    const decoy = path.join(decoyDir, 'relay');
    await writeFile(decoy, `#!/bin/sh\nexit ${shadowedExit}\n`, {
      mode: 0o700,
    });
    const zsh = process.platform === 'darwin';
    const shell = zsh ? '/bin/zsh' : '/bin/sh';
    const setShadowedPath = 'export PATH="$LOOKUP_FIXTURE_DECOY:$PATH"';
    await writeFile(path.join(shellHome, '.zprofile'), `${setShadowedPath}\n`, {
      mode: 0o600,
    });
    const cliOptions = {
      ...fixture.cliOptions,
      env: {
        ...fixture.cliOptions.env,
        HOME: shellHome,
        ZDOTDIR: shellHome,
        LOOKUP_FIXTURE_DECOY: decoyDir,
        PATH: `${path.join(workspace, '.benchmark-tools')}${path.delimiter}${process.env.PATH ?? ''}`,
      },
    };
    const login = (...args) =>
      execute(
        shell,
        [
          '-lc',
          zsh ? '"$@"' : `${setShadowedPath}\n"$@"`,
          'lookup-fixture',
          ...args,
        ],
        cliOptions,
      );
    const which = await login('command', '-v', 'relay');
    assert.equal(
      which.stdout.trim(),
      decoy,
      'Fixture did not reproduce PATH shadowing.',
    );

    const receiverInput = { login, workspace, verify };
    const barePrompt = prompt.replace(
      `Context lookup: \`${E1_CONTEXT_HELPER} context\``,
      'Context lookup: `relay context`',
    );
    const bare = await receive(barePrompt, receiverInput);
    assert.equal(bare.lookupExitCode, shadowedExit);
    assert.deepEqual(await sourceFiles(workspace), beforeFiles);
    const barePassed = await grade();
    assert.equal(barePassed, false);

    const explicit = await receive(prompt, receiverInput);
    assert.equal(explicit.evidenceDigest, evidence.hash);
    assert.equal(explicit.evidenceTextDigest, fingerprint(evidence.text));
    assert.ok(explicit.returnedBytes > 0 && explicit.returnedBytes <= 2000);
    const explicitPassed = await grade();
    assert.equal(explicitPassed, true);
    const afterFiles = await sourceFiles(workspace);
    assert.deepEqual(afterFiles, {
      ...beforeFiles,
      [implementation]: exportSource(expectedLabel),
    });
    assert.ok(await fixture.protectedInputsUnchanged());

    return {
      mode: 'offline-lookup-dependent-handoff',
      providerSessions: 0,
      shell: `${shell} -lc`,
      bareRelayShadowed: true,
      lateCorrectionInline: true,
      exactLabelInline: false,
      priorTest: fixture.priorTest,
      bareRelay: { ...bare, acceptancePassed: barePassed },
      explicitHelper: {
        lookupExitCode: explicit.lookupExitCode,
        returnedBytes: explicit.returnedBytes,
        exactCitedRecord: true,
        freshVerificationExitCode: explicit.freshVerificationExitCode,
        acceptancePassed: explicitPassed,
      },
      sourceStateAndJournalUnchanged: true,
      bundleSha256: fingerprint(await readFile(cli)),
    };
  } finally {
    if (oldHome === undefined) delete process.env.RIREI_DATA_HOME;
    else process.env.RIREI_DATA_HOME = oldHome;
    await rm(base, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.stdout.write(
    `${JSON.stringify(await lookupHandoffBenchmark(), null, 2)}\n`,
  );
}
