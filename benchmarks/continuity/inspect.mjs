import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  inspectCurrentContext,
  relativeInspectionPath,
} from '../../src/context/inspection.ts';
import { contextObservationSchema } from '../../src/context/schema.ts';
import {
  appendCapturedObservation,
  issueCaptureGrant,
  readContextJournal,
  setContextConsent,
} from '../../src/context/store.ts';
import { renderHandoffDocument } from '../../src/lifecycle.ts';
import { readState } from '../../src/state/store.ts';
import { installHistory, project } from './bidirectional.mjs';
import { boundedRead } from './runtime.mjs';
import { WORKFLOWS, workflowHash, writeFiles } from './workflows.mjs';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const sourceNames = [
  'src/context/inspection.ts',
  'src/context/inspection-code.ts',
  'src/context/inspection-schema.ts',
  'src/context/snapshot.ts',
  'src/context/render.ts',
  'src/context/briefing.ts',
  'src/context/verification.ts',
  'src/lifecycle.ts',
  'src/cli/context.ts',
  'benchmarks/continuity/inspect.mjs',
];
const here = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(here, '../..');
const containsRequirements = (output, task) =>
  task.requirements.filter(
    (text) =>
      output.includes(text) ||
      output.includes(JSON.stringify(text).slice(1, -1)),
  ).length;
const percentile = (samples, percent) =>
  [...samples].sort((a, b) => a - b)[Math.ceil(samples.length * percent) - 1];

export async function replayControl(control, base) {
  const manifestBytes = await boundedRead(
    path.join(control, 'control-manifest.json'),
  );
  const manifest = JSON.parse(manifestBytes);
  assert.equal(manifest.complete, true);
  assert.equal(manifest.controlId, 'requirement-first-receiver-retest');
  assert.equal(manifest.cases.length, 4);
  const rows = [];
  for (const row of manifest.cases) {
    assert.ok(
      Number.isSafeInteger(row.index) && row.index >= 0 && row.index < 4,
    );
    const task = WORKFLOWS.find((task) => task.id === row.task);
    assert.ok(task);
    assert.equal(workflowHash(task), row.fixtureHash);
    async function fixture(name) {
      const relative = `fixtures/${row.index}/${name}.json`;
      const entry = manifest.files.find((entry) => entry.path === relative);
      assert.ok(entry);
      const bytes = await boundedRead(path.join(control, relative));
      assert.equal(hash(bytes), entry.sha256);
      assert.equal(bytes.length, entry.bytes);
      return JSON.parse(bytes);
    }
    const files = await fixture('files');
    const events = await fixture('history');
    assert.ok(Object.keys(files).every(relativeInspectionPath));
    assert.equal(hash(JSON.stringify(files)), row.checkpointHash);
    assert.equal(
      hash(
        JSON.stringify(
          events.map((event) => contextObservationSchema.parse(event)),
        ),
      ),
      row.historyHash,
    );
    const workspace = path.join(base, `saved-${row.index}`);
    await mkdir(workspace);
    const state = await project(workspace, task.files, task.request);
    await writeFiles(workspace, files);
    await installHistory(workspace, state, events);
    const journal = await readContextJournal(workspace, state.sessionId);
    const handoff = await renderHandoffDocument(
      workspace,
      await readState(workspace),
    );
    assert.equal(
      handoff.continuity.submissionCoverage.requiredSourceIds.length,
      0,
    );
    assert.equal(containsRequirements(handoff.text, task), 6);
    const inspections = [];
    for (const format of ['text', 'json']) {
      const document = await inspectCurrentContext(workspace, workspace, {
        format,
        snapshot: handoff.inspection.snapshotId,
      });
      assert.equal(document.packet.requirements.status, 'retained-text-inline');
      assert.equal(containsRequirements(document.output, task), 6);
      assert.ok(document.output.length <= 6000);
      assert.equal(
        document.packet.items.filter((item) => item.kind === 'action').length,
        0,
      );
      inspections.push({
        format,
        characters: document.output.length,
        bytes: Buffer.byteLength(document.output),
        exactRequirementsInline: containsRequirements(document.output, task),
        excerpts: document.packet.items.filter((item) =>
          ['diff', 'current-file'].includes(item.kind),
        ).length,
      });
    }
    assert.equal(
      (await readContextJournal(workspace, state.sessionId)).digest,
      journal.digest,
    );
    rows.push({
      index: row.index,
      task: row.task,
      receiver: row.receiver,
      checkpointHash: row.checkpointHash,
      historyHash: row.historyHash,
      snapshotCoverage: handoff.coveredSnapshot.coverage.status,
      handoffCharacters: handoff.text.length,
      briefingCharacters: handoff.continuity.text.length,
      exactRequirementsInline: 6,
      submittedMessagesFullyInline:
        handoff.continuity.submissionCoverage.fullyInlined,
      inspections,
    });
  }
  assert.equal(
    hash(await boundedRead(path.join(control, 'control-manifest.json'))),
    hash(manifestBytes),
  );
  return {
    manifestSha256: hash(manifestBytes),
    sourceReportHash: manifest.sourceReportHash,
    rows,
  };
}

async function measure(base) {
  const task = WORKFLOWS[0];
  const measurements = [];
  for (const extraFiles of [0, 256]) {
    const files = {
      ...task.files,
      ...Object.fromEntries(
        Array.from({ length: extraFiles }, (_, index) => [
          `fixture-inputs/input-${String(index).padStart(3, '0')}.txt`,
          `${String(index).padStart(4, '0')}${'x'.repeat(2043)}\n`,
        ]),
      ),
    };
    const workspace = path.join(base, `timing-${extraFiles}`);
    await mkdir(workspace);
    const state = await project(workspace, files, task.request);
    await writeFiles(workspace, {
      [task.firstStage]: task.reference[task.firstStage],
    });
    await setContextConsent(workspace, state.sessionId, true);
    const issued = await issueCaptureGrant(workspace, {
      taskId: state.sessionId,
      runId: 'offline-timing',
      workspace,
      providerSessionId: 'fixture',
      launchGitFingerprint: 'fixture',
    });
    await appendCapturedObservation(
      workspace,
      state.sessionId,
      'offline-timing',
      issued.token,
      {
        provider: 'claude',
        providerSessionId: 'fixture',
        hook: 'fixture',
        kind: 'prompt_submission',
        text: [task.request, ...task.requirements].join('\n\n'),
        redacted: false,
        truncated: false,
      },
    );
    const handoffMs = [];
    const inspectionMs = [];
    let last;
    for (let index = 0; index < 12; index++) {
      let start = performance.now();
      const handoff = await renderHandoffDocument(
        workspace,
        await readState(workspace),
      );
      handoffMs.push(Number((performance.now() - start).toFixed(3)));
      assert.equal(handoff.coveredSnapshot.coverage.status, 'complete');
      start = performance.now();
      last = await inspectCurrentContext(workspace, workspace, {
        format: 'json',
        snapshot: handoff.inspection.snapshotId,
      });
      inspectionMs.push(Number((performance.now() - start).toFixed(3)));
      assert.equal(last.packet.requirements.status, 'retained-text-inline');
      assert.equal(containsRequirements(last.output, task), 6);
    }
    measurements.push({
      id: extraFiles ? 'ledger-plus-256-fixed-inputs' : 'tenant-ledger',
      files: Object.keys(files).length,
      fixtureBytes: Object.values(files).reduce(
        (total, text) => total + Buffer.byteLength(text),
        0,
      ),
      initialFilesSha256: hash(JSON.stringify(files)),
      handoffMs,
      inspectionMs,
      handoffP50Ms: percentile(handoffMs, 0.5),
      handoffP95Ms: percentile(handoffMs, 0.95),
      inspectionP50Ms: percentile(inspectionMs, 0.5),
      inspectionP95Ms: percentile(inspectionMs, 0.95),
      inspectionCharacters: last.output.length,
    });
  }
  return measurements;
}

export async function inspectionBenchmark({ control } = {}) {
  const base = await realpath(
    await mkdtemp(path.join(os.tmpdir(), 'rirei-inspection-offline-')),
  );
  const oldHome = process.env.RIREI_DATA_HOME;
  process.env.RIREI_DATA_HOME = path.join(base, 'data-home');
  try {
    return {
      schemaVersion: 1,
      mode: 'offline-inspection-qualification',
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
      ...(control
        ? { savedControl: await replayControl(path.resolve(control), base) }
        : {}),
      timings: await measure(base),
      limitations: [
        '12 sequential samples per local fixture; nearest-rank descriptive percentiles, warm filesystem cache. Node/CLI startup excluded.',
        'Handoff preparation includes legacy Git inspection and covered scans. Inspection includes live rescans and task/journal validation; eligible derived packets may be cached after the first call in the same process.',
        'No new model-quality, token, or continuation-time result. Saved histories are rebound only in disposable fixture repositories; source control archive is read-only.',
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
    JSON.stringify(await inspectionBenchmark(values), null, 2) + '\n',
  );
}
