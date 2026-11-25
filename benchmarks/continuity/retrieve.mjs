import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
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
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import {
  appendCapturedObservation,
  issueCaptureGrant,
  readContextJournal,
  setContextConsent,
} from '../../src/context/store.ts';
import { project } from './bidirectional.mjs';
import { replayControl } from './inspect.mjs';

const execute = promisify(execFile);
const hash = (value) => createHash('sha256').update(value).digest('hex');
const repository = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const cli = path.join(repository, 'dist/index.cjs');
const sourceNames = [
  'src/cli/context.ts',
  'src/context/briefing.ts',
  'src/context/snapshot.ts',
  'src/context/retrieval.ts',
  'src/context/retrieval-schema.ts',
  'src/context/retrieval-cursor.ts',
  'src/context/retrieval-index.ts',
  'src/context/retrieval-file.ts',
  'src/context/retrieval-output.ts',
  'benchmarks/continuity/retrieve.mjs',
  'benchmarks/continuity/inspect.mjs',
];

async function workload(base) {
  const workspace = path.join(base, 'retrieval-workload');
  await mkdir(workspace);
  const files = Object.fromEntries(
    ['feed', 'ledger'].map((name) => [
      `src/${name}.mjs`,
      Array.from(
        { length: 1200 },
        (_, index) => `export const ${name}_${index} = ${index};\n`,
      ).join(''),
    ]),
  );
  const state = await project(
    workspace,
    files,
    'Inspect the reported feed failure and lines 601–602 in feed.mjs and ledger.mjs.',
  );
  await setContextConsent(workspace, state.sessionId, true);
  const issued = await issueCaptureGrant(workspace, {
    taskId: state.sessionId,
    runId: 'retrieval-workload',
    workspace,
    provider: 'claude',
    providerSessionId: 'fixture',
    launchGitFingerprint: 'fixture',
  });
  let target;
  for (let index = 0; index < 43; index++) {
    const selected = index === 31;
    const event = await appendCapturedObservation(
      workspace,
      state.sessionId,
      'retrieval-workload',
      issued.token,
      {
        provider: 'claude',
        providerSessionId: 'fixture',
        hook: 'fixture',
        sourceId: `fixture-${index}`,
        kind: 'tool_result',
        toolId: `tool-${index}`,
        filePath: selected ? 'src/feed.mjs' : `src/unrelated-${index}.mjs`,
        command: selected
          ? 'node --test feed.test.mjs'
          : `inspect-fixture-${index}`,
        text: selected
          ? 'FAIL: tenant isolation at the selected boundary.\n' +
            'Unrelated diagnostic detail.\n'.repeat(300)
          : `Historical output ${index}.\n` +
            'Background diagnostic detail.\n'.repeat(120),
        outcome: selected ? 'reported_failure' : 'reported_success',
        exitCode: selected ? 1 : 0,
        redacted: false,
        truncated: false,
      },
    );
    if (selected) target = event;
  }
  assert.ok(target);
  const beforeState = await readFile(path.join(workspace, '.relay/state.json'));
  const beforeJournal = await readContextJournal(workspace, state.sessionId);
  const env = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith('RIREI_')),
    ),
    RIREI_DATA_HOME: process.env.RIREI_DATA_HOME,
  };
  const relay = async (args) =>
    (
      await execute(process.execPath, [cli, 'context', ...args], {
        cwd: workspace,
        env,
        timeout: 30000,
        maxBuffer: 4 * 1024 * 1024,
      })
    ).stdout;
  const baseline = [];
  const targeted = [];
  const record = (results, kind, output) => {
    results.push({
      kind,
      characters: output.length,
      bytes: Buffer.byteLength(output),
    });
    return output;
  };
  let after = 0;
  const baselineEvents = [];
  do {
    const page = JSON.parse(
      record(
        baseline,
        'full-history-page',
        await relay(['history', '--after', String(after), '--limit', '20']),
      ),
    );
    baselineEvents.push(...page.events);
    if (page.nextAfter === null) break;
    after = page.nextAfter;
  } while (baselineEvents.length <= 43);
  assert.equal(baselineEvents.length, 43);
  assert.equal(
    baselineEvents.find((event) => event.id === target.id).text,
    target.text,
  );
  for (const [file, expected] of Object.entries(files)) {
    const output = (
      await execute(
        process.execPath,
        [
          '-e',
          'process.stdout.write(require("node:fs").readFileSync(process.argv[1], "utf8"))',
          file,
        ],
        { cwd: workspace, timeout: 10000 },
      )
    ).stdout;
    assert.equal(output, expected);
    record(baseline, 'full-file-read', output);
  }
  const found = JSON.parse(
    record(
      targeted,
      'exact-field-find',
      await relay([
        'find',
        '--file',
        'src/feed.mjs',
        '--kind',
        'tool_result',
        '--format',
        'json',
      ]),
    ),
  );
  assert.equal(found.result.matches.length, 1);
  assert.equal(found.result.matches[0].id, target.id);
  const request = {
    schemaVersion: 1,
    queries: [
      { id: 'failure', type: 'evidence', eventId: target.id, length: 200 },
      ...Object.entries(files).map(([file, content], index) => ({
        id: `file${index}`,
        type: 'read',
        file,
        startLine: 601,
        lineCount: 2,
        contentHash: hash(content),
      })),
    ],
  };
  await writeFile(
    path.join(workspace, 'queries.json'),
    JSON.stringify(request),
  );
  const batch = JSON.parse(
    record(
      targeted,
      'bounded-batch',
      await relay(['batch', '--request-file', 'queries.json']),
    ),
  );
  assert.equal(batch.results.length, 3);
  assert.ok(batch.results.every((item) => item.status === 'ok'));
  assert.equal(batch.results[0].result.text, target.text.slice(0, 200));
  Object.values(files).forEach((content, index) =>
    assert.equal(
      batch.results[index + 1].result.text,
      content.split('\n').slice(600, 602).join('\n') + '\n',
    ),
  );
  assert.equal(
    hash(await readFile(path.join(workspace, '.relay/state.json'))),
    hash(beforeState),
  );
  assert.equal(
    (await readContextJournal(workspace, state.sessionId)).digest,
    beforeJournal.digest,
  );
  const summarize = (calls) => ({
    calls: calls.length,
    returnedBytes: calls.reduce((sum, call) => sum + call.bytes, 0),
    returnedCharacters: calls.reduce((sum, call) => sum + call.characters, 0),
    responses: calls,
  });
  const broad = summarize(baseline);
  const focused = summarize(targeted);
  assert.ok(focused.calls < broad.calls);
  assert.ok(focused.returnedBytes < broad.returnedBytes);
  return {
    fixture: {
      events: 43,
      fileCount: 2,
      linesPerFile: 1200,
      filesSha256: hash(JSON.stringify(files)),
      requestedEvidenceCharacters: 200,
      requestedStartLine: 601,
      requestedLineCount: 2,
    },
    baseline: broad,
    targeted: focused,
    returnedByteReductionPercent: Number(
      ((1 - focused.returnedBytes / broad.returnedBytes) * 100).toFixed(2),
    ),
    exactSourceWindows: true,
    queryStatusesComplete: true,
    sourceStateAndJournalUnchanged: true,
  };
}

export async function retrievalBenchmark({ control } = {}) {
  const base = await realpath(
    await mkdtemp(path.join(os.tmpdir(), 'rirei-retrieval-offline-')),
  );
  const oldHome = process.env.RIREI_DATA_HOME;
  process.env.RIREI_DATA_HOME = path.join(base, 'data-home');
  try {
    return {
      schemaVersion: 1,
      mode: 'offline-targeted-retrieval',
      providerSessions: 0,
      capturedAt: new Date().toISOString(),
      host: {
        nodeVersion: process.version,
        platform: process.platform,
        arch: process.arch,
      },
      sourceHashes: Object.fromEntries(
        await Promise.all(
          sourceNames.map(async (name) => [
            name,
            hash(await readFile(path.join(repository, name))),
          ]),
        ),
      ),
      bundleSha256: hash(await readFile(cli)),
      workload: await workload(base),
      ...(control
        ? { savedControl: await replayControl(path.resolve(control), base) }
        : {}),
      limitations: [
        'Authored, preselected retrieval workload; query fields and desired source ranges are known to both comparisons. This is not a best-possible shell baseline or a model behavior experiment.',
        'Calls count executed read commands, not model turns or provider tokens. Bytes are returned UTF-8 output, not tokenization or subscription usage.',
        'The targeted caller stops after the requested windows; non-null cursors truthfully expose remaining source content. No provider was launched.',
      ],
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
  const { values } = parseArgs({ options: { control: { type: 'string' } } });
  process.stdout.write(
    JSON.stringify(await retrievalBenchmark(values), null, 2) + '\n',
  );
}
