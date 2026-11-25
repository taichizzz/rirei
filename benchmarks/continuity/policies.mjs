import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderHandoffDocument } from '../../src/lifecycle.ts';
import { readState } from '../../src/state/store.ts';
import {
  appendCapturedObservation,
  issueCaptureGrant,
  readContextJournal,
  setContextConsent,
} from '../../src/context/store.ts';
import {
  HANDOFF_PROFILES,
  sharedPromptPrefix,
} from '../../src/context/prompt-policy.ts';
import { project, CASES } from './bidirectional.mjs';
import { WORKFLOWS, workflowHash, writeFiles } from './workflows.mjs';
import { replayControl } from './inspect.mjs';
import { boundedRead } from './runtime.mjs';
import {
  analyzePolicyExperiment,
  createPolicyExperiment,
} from './policy-experiment.mjs';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const repository = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const sourceNames = [
  'src/context/prompt-policy.ts',
  'src/context/briefing.ts',
  'src/context/render.ts',
  'src/context/schema.ts',
  'src/handoff.ts',
  'src/lifecycle.ts',
  'src/cli/handoff.ts',
  'benchmarks/continuity/policies.mjs',
  'benchmarks/continuity/policy-experiment.mjs',
  'benchmarks/continuity/measurement.mjs',
  'benchmarks/continuity/workflows.mjs',
  'benchmarks/continuity/bidirectional.mjs',
  'benchmarks/handoff/lib.mjs',
];
const requirementCount = (text, task) =>
  task.requirements.filter(
    (requirement) =>
      text.includes(requirement) ||
      text.includes(JSON.stringify(requirement).slice(1, -1)),
  ).length;

async function authoredCases(base) {
  for (const [index, row] of CASES.entries()) {
    const task = WORKFLOWS.find((task) => task.id === row.task);
    const workspace = path.join(base, `saved-${index}`);
    await mkdir(workspace);
    const state = await project(workspace, task.files, task.request);
    await writeFiles(workspace, {
      [task.firstStage]: task.reference[task.firstStage],
    });
    await setContextConsent(workspace, state.sessionId, true);
    const issued = await issueCaptureGrant(workspace, {
      taskId: state.sessionId,
      runId: 'authored-predecessor',
      workspace,
      provider: row.predecessor,
      providerSessionId: 'authored',
      launchGitFingerprint: 'pre-edit',
    });
    const record = (kind, text, fields = {}) =>
      appendCapturedObservation(
        workspace,
        state.sessionId,
        'authored-predecessor',
        issued.token,
        {
          kind,
          text,
          provider: row.predecessor,
          providerSessionId: 'authored',
          hook: 'fixture',
          redacted: false,
          truncated: false,
          ...fields,
        },
      );
    await record('session_start', 'Fixture start');
    await record(
      'prompt_submission',
      [
        task.request,
        ...task.requirements,
        `First stage only: edit ${task.firstStage}.`,
      ].join('\n\n'),
    );
    await record('tool_result', 'Verification failed before the edit.', {
      command: 'npm test',
      outcome: 'reported_failure',
      exitCode: 1,
    });
    await record('tool_result', 'Fixture source edited; not retested.', {
      toolName: 'Edit',
      filePath: task.firstStage,
      outcome: 'reported_success',
    });
    await record('tool_start', 'No completion observed.', {
      command: 'npm test',
      toolId: 'pending-verification',
    });
    await record('assistant_claim', 'The implementation is complete.');
  }
}

async function profileCases(base) {
  const rows = [];
  for (const [index, row] of CASES.entries()) {
    const task = WORKFLOWS.find((task) => task.id === row.task);
    const workspace = path.join(base, `saved-${index}`);
    const state = await readState(workspace);
    const frames = new Map();
    for (const profile of HANDOFF_PROFILES)
      frames.set(
        profile,
        await renderHandoffDocument(workspace, state, workspace, undefined, {
          profile,
        }),
      );
    const baseline = frames.get('control');
    const profileRows = [];
    for (const [profile, frame] of frames) {
      assert.deepEqual(frame.capsule, baseline.capsule);
      assert.deepEqual(frame.continuity, baseline.continuity);
      assert.equal(frame.coveredSnapshot.id, baseline.coveredSnapshot.id);
      assert.equal(
        requirementCount(frame.text, task),
        task.requirements.length,
      );
      assert.ok(frame.text.length <= frame.budget.maxCharacters);
      assert.equal(
        frame.continuity.submissionCoverage.requiredSourceIds.length,
        0,
      );
      if (frame.policy?.applied)
        assert.ok(
          frame.policy.legacyUsedCharacters <= frame.policy.legacyMaxCharacters,
        );
      profileRows.push({
        profile,
        applied: frame.policy?.applied ?? true,
        effectiveProfile: frame.policy?.effective ?? 'control',
        fallbackReason: frame.policy?.fallbackReason ?? null,
        promptSha256: hash(frame.text),
        characters: frame.text.length,
        utf8Bytes: Buffer.byteLength(frame.text),
        addedCharacters: frame.policy?.addedCharacters ?? 0,
        exactRequirementsInline: task.requirements.length,
        selectedEvidenceUnchanged: true,
        coverageWarningsUnchanged: true,
        staticPrefix: frame.policy?.staticPrefix ?? null,
        cacheReadTokens: null,
        cacheCreationTokens: null,
        outputTokens: null,
        reasoningTokens: null,
        nonCachedTokens: null,
        receiverWallTimeMs: null,
      });
    }
    const beforeJournal = await readContextJournal(workspace, state.sessionId);
    const issued = await issueCaptureGrant(workspace, {
      taskId: state.sessionId,
      runId: 'offline-runtime-probe',
      workspace,
      provider: row.predecessor,
      providerSessionId: 'runtime-probe',
      launchGitFingerprint: 'probe-only',
    });
    await appendCapturedObservation(
      workspace,
      state.sessionId,
      'offline-runtime-probe',
      issued.token,
      {
        provider: row.predecessor,
        providerSessionId: 'runtime-probe',
        hook: 'fixture',
        kind: 'session_end',
        text: 'Offline synthetic runtime-metadata probe in the disposable copy only.',
        redacted: false,
        truncated: false,
      },
    );
    const prefixProbe = [];
    for (const [profile, frame] of frames) {
      const next = await renderHandoffDocument(
        workspace,
        state,
        workspace,
        undefined,
        { profile },
      );
      const sameSelectedEvidence = isDeepStrictEqual(
        frame.continuity.selectedEvidence,
        next.continuity.selectedEvidence,
      );
      if (frame.policy?.staticPrefix && next.policy?.staticPrefix)
        assert.deepEqual(frame.policy.staticPrefix, next.policy.staticPrefix);
      prefixProbe.push({
        profile,
        sameSelectedEvidence,
        captureMetadataChanged: frame.continuity.text !== next.continuity.text,
        sharedPromptPrefix: sameSelectedEvidence
          ? sharedPromptPrefix(frame.text, next.text)
          : null,
      });
    }
    assert.equal(
      (await readContextJournal(workspace, state.sessionId)).events.length,
      beforeJournal.events.length + 1,
    );
    rows.push({
      index,
      task: task.id,
      receiver: row.receiver,
      fixtureHash: workflowHash(task),
      source: 'same checkpoint and retained history for every profile',
      profiles: profileRows,
      runtimeMetadataProbe: prefixProbe,
    });
  }
  return rows;
}

export async function policyBenchmark({
  control,
  contrast = 'output',
  repetitions = 1,
  observations,
} = {}) {
  const base = await realpath(
    await mkdtemp(path.join(os.tmpdir(), 'rirei-policy-offline-')),
  );
  const oldHome = process.env.RIREI_DATA_HOME;
  process.env.RIREI_DATA_HOME = path.join(base, 'data-home');
  try {
    const sourceHashes = Object.fromEntries(
      await Promise.all(
        sourceNames.map(async (name) => [
          name,
          hash(await boundedRead(path.join(repository, name))),
        ]),
      ),
    );
    const savedControl = control
      ? await replayControl(path.resolve(control), base)
      : null;
    if (!control) await authoredCases(base);
    const protocol = createPolicyExperiment({
      contrast,
      repetitions,
      sourceHashes,
    });
    const recorded = observations
      ? JSON.parse(await boundedRead(path.resolve(observations)))
      : [];
    const profileRows = await profileCases(base);
    return {
      schemaVersion: 1,
      mode: 'offline-output-layout-qualification',
      providerSessions: 0,
      capturedAt: new Date().toISOString(),
      sourceHashes,
      inputKind: control
        ? 'verified-saved-control-copies'
        : 'authored-workflow-histories',
      ...(savedControl ? { savedControl } : {}),
      profiles: profileRows,
      proposedExperiment: protocol,
      analysis: analyzePolicyExperiment(protocol, recorded),
      limitations: [
        'No provider process is launched by this command. The proposed schedule is not a session authorization.',
        'The runtime-metadata probe appends one synthetic session-end event only in a disposable copy; original control inputs are read-only.',
        'Common UTF-8 prefix bytes are a layout diagnostic, not tokenization, provider cache counters, or measured cache reuse.',
        'Policy profiles preserve control selection and can fall back to control when existing budget headroom is insufficient.',
        'The layout/output ablation remains separate from the M2–M4 inspection/retrieval candidate and its live quality gate.',
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
  const { values } = parseArgs({
    options: {
      control: { type: 'string' },
      contrast: { type: 'string', default: 'output' },
      repetitions: { type: 'string', default: '1' },
      observations: { type: 'string' },
      report: { type: 'string' },
    },
  });
  const report = await policyBenchmark({
    ...values,
    repetitions: Number(values.repetitions),
  });
  const serialized = JSON.stringify(report, null, 2) + '\n';
  if (values.report) {
    await writeFile(path.resolve(values.report), serialized, {
      flag: 'wx',
      mode: 0o600,
    });
    process.stdout.write(
      JSON.stringify(
        {
          mode: report.mode,
          providerSessions: report.providerSessions,
          reportFile: path.resolve(values.report),
          cases: report.profiles.length,
          plannedLaunches: report.proposedExperiment.plannedLaunches,
          authorizedLaunches: 0,
          recordedObservations: report.analysis.recordedObservations,
        },
        null,
        2,
      ) + '\n',
    );
  } else process.stdout.write(serialized);
}
