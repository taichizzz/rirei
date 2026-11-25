import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { contextObservationSchema } from '../../src/context/schema.ts';
import { readContextJournal } from '../../src/context/store.ts';
import { parseJsonLines } from '../handoff/lib.mjs';
import { providerMetrics } from './bidirectional.mjs';
import { fingerprint, WORKFLOWS } from './workflows.mjs';

const sum = (rows, key) =>
  rows.length && rows.every((row) => Number.isFinite(row[key]))
    ? rows.reduce((total, row) => total + row[key], 0)
    : null;
const percent = (before, after) =>
  Number.isFinite(before) && before > 0 && Number.isFinite(after)
    ? Math.round(((after - before) / before) * 10000) / 100
    : null;
const fields = [
  'promptCharacters',
  'inputTokens',
  'cachedInputTokens',
  'cacheCreationInputTokens',
  'outputTokens',
  'reasoningTokens',
  'nonCachedTokens',
  'toolCalls',
  'wallTimeMs',
];
const pathAliases = (value) =>
  !value
    ? []
    : value.startsWith('/var/')
      ? [value, '/private' + value]
      : value.startsWith('/private/var/')
        ? [value, value.slice('/private'.length)]
        : [value];

export function crossTraceObservations(
  provider,
  text,
  { otherWorkspaces = [], predecessorWorkspace } = {},
) {
  const records = parseJsonLines(text);
  const calls = new Map();
  let failedResults = 0;
  for (const record of records) {
    if (provider === 'codex') {
      if (
        ['item.started', 'item.completed'].includes(record.type) &&
        record.item?.type === 'command_execution'
      ) {
        calls.set(record.item.id, {
          command: record.item.command ?? '',
          file: '',
        });
        if (
          record.type === 'item.completed' &&
          typeof record.item.exit_code === 'number' &&
          record.item.exit_code !== 0
        )
          failedResults++;
      }
    } else if (
      record.type === 'assistant' &&
      Array.isArray(record.message?.content)
    ) {
      for (const block of record.message.content.filter(
        (block) => block.type === 'tool_use',
      ))
        calls.set(block.id, {
          command: block.name === 'Bash' ? (block.input?.command ?? '') : '',
          file: block.input?.file_path ?? '',
        });
    } else if (
      record.type === 'user' &&
      Array.isArray(record.message?.content)
    ) {
      failedResults += record.message.content.filter(
        (block) => block.type === 'tool_result' && block.is_error === true,
      ).length;
    }
  }
  const values = [...calls.values()];
  const lookup = (kind) =>
    values.filter((call) =>
      new RegExp(`relay\\s+context\\s+${kind}\\b`).test(call.command),
    ).length;
  return {
    failedToolResults: failedResults,
    taskLookupCommands: lookup('task'),
    historyLookupCommands: lookup('history'),
    evidenceLookupCommands: lookup('evidence'),
    sourceJournalReads: values.filter((call) =>
      /\.relay[\\/]context[\\/].*events\.jsonl/.test(call.command + call.file),
    ).length,
    verificationCommands: values.filter((call) =>
      /\bnpm\s+test\b|\bnode\s+--test\b/.test(call.command),
    ).length,
    toolCallsReferencingOtherWorkspaces: values.filter((call) =>
      otherWorkspaces.some((workspace) =>
        (call.command + call.file).includes(workspace),
      ),
    ).length,
    shellCallsReferencingPredecessor: predecessorWorkspace
      ? values.filter((call) => call.command.includes(predecessorWorkspace))
          .length
      : 0,
    fileCallsReferencingPredecessor: predecessorWorkspace
      ? values.filter((call) => call.file.includes(predecessorWorkspace)).length
      : 0,
  };
}

/** Export only whitelisted identifiers, measurements, hashes, and grading outcomes. */
export function analyzeCrossReport(
  report,
  audits = new Map(),
  priorFailedLaunches = 0,
) {
  const receivers = [];
  const predecessors = [];
  for (const row of report.cases) {
    assert.match(row.task, /^[a-z0-9-]+$/);
    assert.ok(['claude', 'codex'].includes(row.predecessor.provider));
    assert.ok(['claude', 'codex'].includes(row.receiver));
    const direction = `${row.predecessor.provider}-to-${row.receiver}`;
    predecessors.push({
      caseIndex: row.index,
      ...(row.predecessor.reused ? { reusedCheckpoint: true } : {}),
      task: row.task,
      direction,
      fixtureHash: row.fixtureHash,
      checkpointHash: row.checkpointHash,
      historyHash: row.historyHash,
      eventCount: row.eventCount,
      captureQualified: row.captureQualified,
      checkpointStillIncomplete: row.checkpointGrading?.passed === false,
      wallTimeMs: row.predecessor.wallTimeMs,
      interruptedByHarness: row.predecessor.interruptedByHarness,
      inputTokens: row.predecessor.metrics.inputTokens ?? null,
      outputTokens: row.predecessor.metrics.outputTokens ?? null,
      nonCachedTokens: row.predecessor.metrics.nonCachedTokens ?? null,
      audit: audits.get(`${row.index}/predecessor`) ?? null,
    });
    for (const arm of row.arms) {
      assert.ok(['rirei', 'full-history'].includes(arm.arm));
      const audit = audits.get(`${row.index}/${arm.arm}`);
      const metrics = audit?.metrics ?? arm.execution.metrics;
      const execution = arm.execution;
      receivers.push({
        caseIndex: row.index,
        task: row.task,
        direction,
        arm: arm.arm,
        ...(report.reusedCheckpointCount
          ? {
              acceptancePassed: arm.grading?.passed === true,
              infrastructureAffected: Boolean(
                arm.infrastructureAffected ||
                execution.captureError ||
                execution.timedOut ||
                audit?.filesystemErrorResults,
              ),
              filesystemErrorResults: audit?.filesystemErrorResults ?? null,
            }
          : {}),
        correct: Boolean(
          arm.grading?.passed &&
          arm.evidenceIntact &&
          !execution.failed &&
          !execution.timedOut &&
          execution.exitCode === 0,
        ),
        groupsPassed:
          arm.grading?.groups.filter((group) => group.passed).length ?? null,
        groupCount: arm.grading?.groups.length ?? null,
        failedGroups:
          arm.grading?.groups
            .filter((group) => !group.passed)
            .map((group) => group.name) ?? [],
        evidenceIntact: arm.evidenceIntact,
        promptHash: execution.promptHash,
        checkpointHash: arm.checkpointHash,
        historyHash: arm.historyHash,
        promptCharacters: execution.promptCharacters,
        preparationMs: arm.preparationMs,
        wallTimeMs: execution.wallTimeMs,
        inputTokens: metrics.inputTokens ?? null,
        cachedInputTokens: metrics.cachedInputTokens ?? null,
        cacheCreationInputTokens: metrics.cacheCreationInputTokens ?? null,
        outputTokens: metrics.outputTokens ?? null,
        reasoningTokens:
          audit?.reasoningTokens ?? metrics.reasoningTokens ?? null,
        nonCachedTokens: metrics.nonCachedTokens ?? null,
        toolCalls: metrics.toolCalls ?? null,
        actualModel: metrics.actualModel ?? null,
        exactRequirementStringsInPrompt:
          audit?.exactRequirementStringsInPrompt ?? null,
        requirementStringCount: audit?.requirementStringCount ?? null,
        trace: audit?.trace ?? null,
        traceHash: audit?.traceHash ?? null,
        historyAuditPassed: audit?.historyAuditPassed ?? null,
      });
    }
  }
  const summaries = [];
  for (const direction of [...new Set(receivers.map((row) => row.direction))]) {
    for (const arm of ['full-history', 'rirei']) {
      const rows = receivers.filter(
        (row) => row.direction === direction && row.arm === arm,
      );
      summaries.push({
        direction,
        arm,
        cases: rows.length,
        correct: rows.filter((row) => row.correct).length,
        ...(report.reusedCheckpointCount
          ? {
              acceptancePassed: rows.filter((row) => row.acceptancePassed)
                .length,
              cleanCases: rows.filter((row) => !row.infrastructureAffected)
                .length,
              cleanCorrect: rows.filter(
                (row) => !row.infrastructureAffected && row.correct,
              ).length,
            }
          : {}),
        ...Object.fromEntries(fields.map((key) => [key, sum(rows, key)])),
      });
    }
  }
  const paired = [...new Set(receivers.map((row) => row.caseIndex))].map(
    (index) => {
      const rows = receivers.filter((row) => row.caseIndex === index);
      const full = rows.find((row) => row.arm === 'full-history');
      const compact = rows.find((row) => row.arm === 'rirei');
      return {
        caseIndex: index,
        task: rows[0].task,
        direction: rows[0].direction,
        fullHistoryCorrect: full?.correct ?? null,
        rireiCorrect: compact?.correct ?? null,
        rireiVersusFullHistoryPercent: Object.fromEntries(
          [
            'promptCharacters',
            'inputTokens',
            'nonCachedTokens',
            'wallTimeMs',
            'toolCalls',
          ].map((key) => [key, percent(full?.[key], compact?.[key])]),
        ),
      };
    },
  );
  return {
    schemaVersion: 1,
    mode: report.mode,
    ...(report.reusedCheckpointCount
      ? {
          reusedCheckpointCount: report.reusedCheckpointCount,
          sourceReportHash: report.sourceReportHash,
        }
      : {}),
    priorFailedAuthenticationLaunches: priorFailedLaunches,
    completedExperimentLaunches: report.providerSessions,
    aggregateLaunchAttempts: priorFailedLaunches + report.providerSessions,
    predecessorSessions: report.predecessorSessions,
    receiverSessions: report.receiverSessions,
    automaticReruns: report.protocol.automaticReruns,
    versions: report.protocol.versions,
    requestedModels: report.protocol.models,
    fixtureHashes: report.protocol.fixtureHashes,
    sourceHashes: report.protocol.sourceHashes,
    totalPredecessorNonCachedTokens: sum(predecessors, 'nonCachedTokens'),
    humanPreparationMinutes: null,
    predecessors,
    receivers,
    summaries,
    paired,
    ...(report.reusedCheckpointCount
      ? {
          infrastructureIncidentCount:
            report.infrastructureIncidents?.length ?? 0,
          cleanPairSummaries: [
            ...new Set(receivers.map((row) => row.direction)),
          ].flatMap((direction) => {
            const matching = receivers.filter(
              (row) => row.direction === direction,
            );
            const validIndices = new Set(
              [...new Set(matching.map((row) => row.caseIndex))].filter(
                (index) => {
                  const pair = matching.filter(
                    (row) => row.caseIndex === index,
                  );
                  return (
                    pair.length === 2 &&
                    pair.every((row) => !row.infrastructureAffected)
                  );
                },
              ),
            );
            return ['full-history', 'rirei'].map((arm) => {
              const rows = matching.filter(
                (row) => row.arm === arm && validIndices.has(row.caseIndex),
              );
              return {
                direction,
                arm,
                matchedCases: rows.length,
                correct: rows.filter((row) => row.correct).length,
                ...Object.fromEntries(
                  fields.map((key) => [key, sum(rows, key)]),
                ),
              };
            });
          }),
        }
      : {}),
    limitations: [
      'Two authored tasks per direction, one receiver per arm/checkpoint; no statistical superiority claim.',
      'Controlled first-stage-only predecessors, not naturalistic interruptions or a full application switch-UI trial.',
      'Full history means all retained visible evidence, with the same capture bounds/redactions as Rirei.',
      'Predecessor usage counters are missing after interruption; total lifecycle cost and human effort are unknown.',
      'Token totals are compared within a receiver provider, not pooled into cross-provider bills or quota estimates.',
      'Cache reuse, tool-call counts, and path confusion vary; shorter prompts do not imply better continuation.',
      'Exact requirement-string presence is a lexical diagnostic, not a semantic compliance score.',
      'Lookup counts are command attempts; literal path-reference audits do not establish filesystem read isolation.',
      'No Orca runtime, agent-written handoff, reverse interactive capture integration, or Windows acceptance was compared.',
    ],
  };
}

export function crossMarkdown(analysis) {
  const display = (value) =>
    value === null ? 'Unknown' : value.toLocaleString('en-US');
  return [
    analysis.reusedCheckpointCount
      ? '# Frozen-checkpoint receiver retest'
      : '# Real two-way successor pilot',
    '',
    analysis.reusedCheckpointCount
      ? `Receiver launches: ${analysis.receiverSessions}; new predecessors: ${analysis.predecessorSessions}; reused checkpoints: ${analysis.reusedCheckpointCount}; total attempts in this retest: ${analysis.aggregateLaunchAttempts}.`
      : `Experiment launches: ${analysis.completedExperimentLaunches} (${analysis.predecessorSessions} predecessors + ${analysis.receiverSessions} receivers). Including the prior failed authentication launch: ${analysis.aggregateLaunchAttempts}.`,
    '',
    '| Direction | Arm | Correct | Prompt chars | Input | Cached input | Output | Non-cached input + output | Tool calls | Receiver time (ms) |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...analysis.summaries.map(
      (row) =>
        `| ${row.direction} | ${row.arm} | ${row.correct}/${row.cases} | ${display(row.promptCharacters)} | ${display(row.inputTokens)} | ${display(row.cachedInputTokens)} | ${display(row.outputTokens)} | ${display(row.nonCachedTokens)} | ${display(row.toolCalls)} | ${display(row.wallTimeMs)} |`,
    ),
    ...(analysis.reusedCheckpointCount
      ? [
          '',
          'Strict correctness above includes the execution/capture validity gate. Acceptance passes are tracked separately.',
          '',
          '| Direction | Arm | Acceptance passes | Clean runs | Strict successes |',
          '| --- | --- | ---: | ---: | ---: |',
          ...analysis.summaries.map(
            (row) =>
              `| ${row.direction} | ${row.arm} | ${row.acceptancePassed}/${row.cases} | ${row.cleanCases}/${row.cases} | ${row.correct}/${row.cases} |`,
          ),
          '',
          '## Clean matched pairs only',
          '',
          '| Direction | Arm | Matched cases | Correct | Non-cached input + output | Receiver time (ms) |',
          '| --- | --- | ---: | ---: | ---: | ---: |',
          ...analysis.cleanPairSummaries.map(
            (row) =>
              `| ${row.direction} | ${row.arm} | ${row.matchedCases} | ${row.correct} | ${display(row.nonCachedTokens)} | ${display(row.wallTimeMs)} |`,
          ),
        ]
      : []),
    '',
    '## Paired task outcomes',
    '',
    ...analysis.paired.map(
      (row) =>
        `- ${row.direction} / ${row.task}: full history ${row.fullHistoryCorrect ? 'pass' : 'fail'}, Rirei ${row.rireiCorrect ? 'pass' : 'fail'}. Rirei versus full history: ${JSON.stringify(row.rireiVersusFullHistoryPercent)}.`,
    ),
    '',
    '## Limitations',
    '',
    ...analysis.limitations.map((value) => `- ${value}`),
    '',
  ].join('\n');
}

async function tree(directory) {
  const files = {};
  async function visit(current, prefix = '') {
    for (const item of await readdir(current, { withFileTypes: true })) {
      if (
        ['.git', '.relay', '.benchmark-tools', 'node_modules'].includes(
          item.name,
        )
      )
        continue;
      const name = prefix ? `${prefix}/${item.name}` : item.name;
      const file = path.join(current, item.name);
      assert.equal(item.isSymbolicLink(), false);
      if (item.isDirectory()) await visit(file, name);
      else files[name] = await readFile(file, 'utf8');
    }
  }
  await visit(directory);
  return Object.fromEntries(
    Object.entries(files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
}

export async function auditCrossRun(runRoot, priorFailedLaunches = 0) {
  const source = await readFile(path.join(runRoot, 'report.json'));
  const report = JSON.parse(source);
  const ledger = JSON.parse(
    await readFile(
      path.join(runRoot, 'session-ledger.snapshot.json'),
      'utf8',
    ).catch((error) => {
      if (error.code === 'ENOENT')
        return readFile(path.join(runRoot, 'sessions.json'), 'utf8');
      throw error;
    }),
  );
  assert.equal(ledger.length, report.providerSessions);
  assert.equal(new Set(ledger.map((row) => row.key)).size, ledger.length);
  assert.ok(ledger.length <= report.protocol.sessionLimit);
  const caseRoot = (row) =>
    path.join(
      runRoot,
      `case-${row.index}-${row.task}-${row.predecessor.provider}-to-${row.receiver}`,
    );
  const allWorkspaces = report.cases.flatMap((row) =>
    ['predecessor', ...row.arms.map((arm) => arm.arm)].map((name) =>
      path.join(caseRoot(row), name),
    ),
  );
  for (const row of report.cases)
    for (const arm of row.arms)
      allWorkspaces.push(...[arm.workspace, arm.liveWorkspace].filter(Boolean));
  if (report.protocol.sourceRun) {
    for (const row of report.cases)
      for (const name of ['predecessor', 'rirei', 'full-history'])
        allWorkspaces.push(
          path.join(
            report.protocol.sourceRun,
            `case-${row.index}-${row.task}-${row.predecessor.provider}-to-${row.receiver}`,
            name,
          ),
        );
  }
  const knownWorkspaces = [...new Set(allWorkspaces.flatMap(pathAliases))];
  const audits = new Map();
  for (const row of report.cases) {
    const base = caseRoot(row);
    const predecessor =
      row.predecessor.workspace ?? path.join(base, 'predecessor');
    const frozen = JSON.parse(
      await readFile(path.join(base, 'frozen-files.json'), 'utf8'),
    );
    assert.equal(fingerprint(JSON.stringify(frozen)), row.checkpointHash);
    const unchanged =
      fingerprint(JSON.stringify(await tree(predecessor))) ===
      row.checkpointHash;
    audits.set(`${row.index}/predecessor`, {
      frozenCheckpointStillUnchanged: unchanged,
    });
    const task = WORKFLOWS.find((task) => task.id === row.task);
    for (const arm of row.arms) {
      assert.equal(arm.checkpointHash, row.checkpointHash);
      assert.equal(arm.historyHash, row.historyHash);
      const directory = arm.workspace ?? path.join(base, arm.arm);
      const artifacts =
        arm.artifacts ?? path.join(base, `${arm.arm}-artifacts`);
      const currentAliases = new Set([
        ...pathAliases(directory),
        ...pathAliases(arm.liveWorkspace),
      ]);
      const state = JSON.parse(
        await readFile(path.join(directory, '.relay/state.json'), 'utf8'),
      );
      const journal = await readContextJournal(directory, state.sessionId);
      const historyAuditPassed =
        fingerprint(
          JSON.stringify(
            journal.events.map((event) =>
              contextObservationSchema.parse(event),
            ),
          ),
        ) === row.historyHash;
      assert.equal(historyAuditPassed, true);
      const traceText = await readFile(
        path.join(artifacts, 'stdout.jsonl'),
        'utf8',
      );
      const prompt = await readFile(path.join(artifacts, 'prompt.txt'), 'utf8');
      assert.equal(fingerprint(prompt), arm.execution.promptHash);
      const metrics = providerMetrics(row.receiver, traceText);
      for (const key of [
        'inputTokens',
        'cachedInputTokens',
        'outputTokens',
        'nonCachedTokens',
        'toolCalls',
      ])
        assert.equal(
          metrics[key],
          arm.execution.metrics[key],
          `Metric replay mismatch: ${key}`,
        );
      const final = parseJsonLines(traceText).findLast(
        (record) => record.type === 'result',
      );
      const filesystemErrorResults = parseJsonLines(traceText).reduce(
        (count, record) => {
          const messages =
            record.type === 'item.completed' &&
            record.item?.type === 'command_execution'
              ? [record.item.aggregated_output ?? '']
              : record.type === 'user' && Array.isArray(record.message?.content)
                ? record.message.content
                    .filter((block) => block.type === 'tool_result')
                    .map((block) =>
                      typeof block.content === 'string'
                        ? block.content
                        : JSON.stringify(block.content),
                    )
                : [];
          return (
            count +
            messages.filter((text) =>
              /ENOSPC|ETIMEDOUT|Operation timed out|no space left on device/i.test(
                text,
              ),
            ).length
          );
        },
        0,
      );
      audits.set(`${row.index}/${arm.arm}`, {
        metrics,
        historyAuditPassed,
        filesystemErrorResults,
        reasoningTokens:
          row.receiver === 'claude'
            ? (final?.usage?.output_tokens_details?.thinking_tokens ?? null)
            : metrics.reasoningTokens,
        exactRequirementStringsInPrompt: task.requirements.filter(
          (text) =>
            prompt.includes(text) ||
            prompt.includes(JSON.stringify(text).slice(1, -1)),
        ).length,
        requirementStringCount: task.requirements.length,
        traceHash: fingerprint(traceText),
        trace: crossTraceObservations(row.receiver, traceText, {
          otherWorkspaces: knownWorkspaces.filter(
            (workspace) => !currentAliases.has(workspace),
          ),
          predecessorWorkspace: report.protocol.sourceRun
            ? path.join(
                report.protocol.sourceRun,
                `case-${row.index}-${row.task}-${row.predecessor.provider}-to-${row.receiver}`,
                'predecessor',
              )
            : predecessor,
        }),
      });
    }
  }
  return {
    ...analyzeCrossReport(report, audits, priorFailedLaunches),
    privateReportHash: fingerprint(source),
  };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const { values } = parseArgs({
    options: {
      'run-root': { type: 'string' },
      'output-directory': { type: 'string' },
      'prior-failed-launches': { type: 'string', default: '0' },
    },
  });
  if (!values['run-root']) throw new Error('--run-root is required.');
  const prior = Number(values['prior-failed-launches']);
  assert.ok(Number.isSafeInteger(prior) && prior >= 0);
  const analysis = await auditCrossRun(path.resolve(values['run-root']), prior);
  const serialized = JSON.stringify(analysis, null, 2) + '\n';
  assert.doesNotMatch(
    serialized,
    /\/Users\/|\/private\/var\/|\/home\/|[A-Za-z]:\\/,
  );
  if (values['output-directory']) {
    const destination = path.resolve(values['output-directory']);
    await mkdir(destination, { mode: 0o700 });
    await writeFile(path.join(destination, 'analysis.json'), serialized, {
      mode: 0o600,
    });
    await writeFile(
      path.join(destination, 'analysis.md'),
      crossMarkdown(analysis),
      { mode: 0o600 },
    );
  }
  process.stdout.write(crossMarkdown(analysis));
}
