import assert from 'node:assert/strict';
import { mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { contextObservationSchema } from '../../src/context/schema.ts';
import { boundedRead, newBenchmarkRun } from './runtime.mjs';
import { fingerprint } from './workflows.mjs';
import { measuredProviderMetrics } from './measurement.mjs';

export const CONTROL_REPORT_HASH =
  '1e0bde884fdfb04f879e61d6708c2c189733b7bc458de9de90f4aa9fa2222862';

/** Freeze the retained, as-tested archive, never the moving active renderer. No provider is invoked. */
export async function freezeControl(
  source,
  output,
  expectedReportHash = CONTROL_REPORT_HASH,
  { readTimeoutMs = 30000, progress = () => {} } = {},
) {
  assert.ok(
    Number.isSafeInteger(readTimeoutMs) &&
      readTimeoutMs > 0 &&
      readTimeoutMs <= 30000,
  );
  const load = (file) => boundedRead(file, { timeoutMs: readTimeoutMs });
  progress('report');
  const reportBytes = await load(path.join(source, 'report.json'));
  assert.equal(
    fingerprint(reportBytes),
    expectedReportHash,
    'Control report changed.',
  );
  const report = JSON.parse(reportBytes);
  assert.equal(report.mode, 'frozen-checkpoint-receiver-retest');
  const root = await newBenchmarkRun(output);
  const entries = [];
  let copiedBytes = 0;
  async function store(name, bytes) {
    if (copiedBytes + bytes.length > 256 * 1024 ** 2 || entries.length >= 128)
      throw new Error('Control archive allowance exceeded.');
    const file = path.resolve(root, name);
    assert.ok(file.startsWith(root + path.sep));
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const handle = await open(file, 'wx', 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    const sha256 = fingerprint(bytes);
    assert.equal(fingerprint(await load(file)), sha256);
    entries.push({ path: name, sha256, bytes: bytes.length });
    copiedBytes += bytes.length;
  }
  await store('original/report.json', reportBytes);
  for (const name of ['protocol.json', 'sessions.json'])
    await store(`original/${name}`, await load(path.join(source, name)));
  const ledgerBytes = await load(
    path.join(source, 'session-ledger.snapshot.json'),
  ).catch((error) => {
    if (error.code === 'ENOENT')
      return load(path.join(source, 'sessions.json'));
    throw error;
  });
  const ledger = JSON.parse(ledgerBytes);
  await store('original/effective-sessions.json', ledgerBytes);
  assert.equal(ledger.length, report.providerSessions);
  assert.equal(new Set(ledger.map((entry) => entry.key)).size, ledger.length);
  const manifest = JSON.parse(
    await load(path.join(source, 'tested-source-manifest.json')),
  );
  assert.equal(
    manifest.length,
    Object.keys(report.protocol.sourceHashes).length,
  );
  for (const entry of manifest) {
    progress(`source ${entry.name}`);
    assert.equal(entry.sha256, report.protocol.sourceHashes[entry.name]);
    const archiveBase = path.join(source, 'tested-source');
    const file = path.resolve(archiveBase, 'benchmarks/continuity', entry.name);
    const relative = path.relative(archiveBase, file);
    assert.ok(!relative.startsWith('..') && !path.isAbsolute(relative));
    const bytes = await load(file);
    assert.equal(
      fingerprint(bytes),
      entry.sha256,
      `Archived source changed: ${entry.name}`,
    );
    await store(`tested-source/${relative.split(path.sep).join('/')}`, bytes);
  }
  const cases = [];
  for (const row of report.cases) {
    progress(`checkpoint ${row.index}`);
    assert.match(row.task, /^[a-z0-9-]+$/);
    assert.ok(['claude', 'codex'].includes(row.predecessor.provider));
    assert.ok(['claude', 'codex'].includes(row.receiver));
    assert.ok(Number.isSafeInteger(row.index) && row.index >= 0);
    const base = path.join(
      source,
      `case-${row.index}-${row.task}-${row.predecessor.provider}-to-${row.receiver}`,
    );
    const files = await load(path.join(base, 'frozen-files.json'));
    const history = await load(path.join(base, 'frozen-history.json'));
    assert.equal(
      fingerprint(JSON.stringify(JSON.parse(files))),
      row.checkpointHash,
    );
    assert.equal(
      fingerprint(
        JSON.stringify(
          JSON.parse(history).map((event) =>
            contextObservationSchema.parse(event),
          ),
        ),
      ),
      row.historyHash,
    );
    await store(`fixtures/${row.index}/files.json`, files);
    await store(`fixtures/${row.index}/history.json`, history);
    for (const arm of row.arms) {
      progress(`receiver ${row.index}/${arm.arm}`);
      assert.ok(['rirei', 'full-history'].includes(arm.arm));
      const artifacts =
        arm.artifacts ?? path.join(base, `${arm.arm}-artifacts`);
      for (const name of [
        'prompt.txt',
        'stdout.jsonl',
        'stderr.log',
        'command.json',
        'execution.json',
        'settings.json',
      ]) {
        const bytes = await load(path.join(artifacts, name));
        if (name === 'prompt.txt')
          assert.equal(fingerprint(bytes), arm.execution.promptHash);
        if (name === 'execution.json')
          assert.deepEqual(JSON.parse(bytes), arm.execution);
        if (name === 'stdout.jsonl')
          assert.deepEqual(
            measuredProviderMetrics(row.receiver, bytes.toString('utf8')),
            arm.execution.metrics,
          );
        await store(`receivers/${row.index}/${arm.arm}/${name}`, bytes);
      }
    }
    cases.push({
      index: row.index,
      task: row.task,
      receiver: row.receiver,
      fixtureHash: row.fixtureHash,
      checkpointHash: row.checkpointHash,
      historyHash: row.historyHash,
    });
  }
  const summary = {
    schemaVersion: 1,
    controlId: 'requirement-first-receiver-retest',
    sourceReportHash: expectedReportHash,
    complete: true,
    providerSessions: 0,
    recordedLaunches: ledger.length,
    versions: report.protocol.versions,
    models: report.protocol.models,
    sourceHashes: report.protocol.sourceHashes,
    cases,
    results: ['full-history', 'rirei'].map((arm) => {
      const rows = report.cases
        .flatMap((row) => row.arms)
        .filter((row) => row.arm === arm);
      return {
        arm,
        cases: rows.length,
        acceptancePasses: rows.filter((row) => row.grading?.passed).length,
        strictSuccesses: rows.filter((row) => row.correct).length,
      };
    }),
    environmentCoverage:
      'Recorded CLI/model/launch settings only; unrecorded historical host environment remains unknown.',
    files: [...entries],
    copiedBytes,
  };
  await store(
    'control-manifest.json',
    Buffer.from(JSON.stringify(summary, null, 2) + '\n'),
  );
  return { ...summary, archiveDirectory: root };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const { values } = parseArgs({
    options: { source: { type: 'string' }, output: { type: 'string' } },
  });
  assert.ok(
    values.source,
    'Use --source; --output optionally overrides the persistent local runtime directory.',
  );
  const result = await freezeControl(
    path.resolve(values.source),
    values.output,
    CONTROL_REPORT_HASH,
    {
      progress: (stage) => process.stderr.write(`Verifying control ${stage}\n`),
    },
  );
  process.stdout.write(
    JSON.stringify(
      {
        archiveDirectory: result.archiveDirectory,
        controlId: result.controlId,
        sourceReportHash: result.sourceReportHash,
        complete: result.complete,
        verifiedFiles: result.files.length,
        copiedBytes: result.copiedBytes,
        providerSessions: 0,
        results: result.results,
      },
      null,
      2,
    ) + '\n',
  );
}
