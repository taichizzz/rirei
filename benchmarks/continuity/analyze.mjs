import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  nonCachedTokens,
  parseJsonLines,
  parseProviderMetrics,
} from '../handoff/lib.mjs';

const ARMS = ['request-repository', 'full-history', 'rirei-v1', 'rirei-v2'];
const measuredSum = (rows, read) =>
  rows.length && rows.every((row) => Number.isFinite(read(row)))
    ? rows.reduce((sum, row) => sum + read(row), 0)
    : null;
const percent = (before, after) =>
  Number.isFinite(before) && before > 0 && Number.isFinite(after)
    ? Math.round(((after - before) / before) * 10000) / 100
    : null;

export function traceObservations(text) {
  const commands = parseJsonLines(text)
    .filter(
      (record) =>
        record.type === 'item.completed' &&
        record.item?.type === 'command_execution',
    )
    .map((record) => record.item);
  return {
    completedCommandItems: commands.length,
    failedCommandItems: commands.filter(
      (item) => typeof item.exit_code === 'number' && item.exit_code !== 0,
    ).length,
    commandsContainingContextLookup: commands.filter((item) =>
      /relay\s+context\s+(?:task|history|evidence)/.test(item.command ?? ''),
    ).length,
    parentDirectorySearchCommands: commands.filter((item) =>
      /\bfind\s+\.\.(?:\s|\/|$)/.test(item.command ?? ''),
    ).length,
  };
}

/** Whitelist numeric results and hashes; prompts, commands, paths, and thread IDs stay private. */
export function analyzeReport(report, traces = new Map()) {
  const rows = report.rows.map((row) => {
    if (!/^[a-z0-9-]+$/.test(row.task) || !ARMS.includes(row.arm))
      throw new Error('Invalid comparison row identifier.');
    const trace = traces.get(`${row.task}/${row.arm}`);
    const metrics =
      trace !== undefined
        ? parseProviderMetrics('codex', trace)
        : row.execution?.metrics;
    return {
      task: row.task,
      arm: row.arm,
      promptHash: row.promptHash,
      codeInputHash: row.codeInputHash,
      historyHash: row.historyHash,
      promptCharacters: row.promptCharacters,
      executed: Boolean(row.execution),
      correct: row.execution
        ? Boolean(
            row.grading?.passed &&
            row.evidenceIntact &&
            row.execution.exitCode === 0 &&
            !row.execution.timedOut,
          )
        : null,
      exitCode: row.execution?.exitCode ?? null,
      timedOut: row.execution?.timedOut ?? null,
      wallTimeMs: row.execution?.wallTimeMs ?? null,
      inputTokens: metrics?.inputTokens ?? null,
      cachedInputTokens: metrics?.cachedInputTokens ?? null,
      outputTokens: metrics?.outputTokens ?? null,
      reasoningTokens: metrics?.reasoningTokens ?? null,
      nonCachedTokens: metrics ? nonCachedTokens(metrics) : null,
      toolCalls: metrics?.toolCalls ?? null,
      inlineTargetCount: row.inlineTargetCount,
      inlineTargetTotal: row.inlineTargetTotal,
      trace: trace !== undefined ? traceObservations(trace) : null,
    };
  });
  const summary = ARMS.map((arm) => {
    const matching = rows.filter((row) => row.arm === arm);
    const executed = matching.filter((row) => row.executed);
    const inputTokens = measuredSum(executed, (row) => row.inputTokens);
    const cachedInputTokens = measuredSum(
      executed,
      (row) => row.cachedInputTokens,
    );
    return {
      arm,
      cases: matching.length,
      executed: executed.length,
      correct: executed.length
        ? executed.filter((row) => row.correct).length
        : null,
      failures: executed.length
        ? executed.filter((row) => !row.correct).length
        : null,
      promptCharacters: measuredSum(matching, (row) => row.promptCharacters),
      inputTokens,
      cachedInputTokens,
      outputTokens: measuredSum(executed, (row) => row.outputTokens),
      reasoningTokens: measuredSum(executed, (row) => row.reasoningTokens),
      nonCachedTokens: measuredSum(executed, (row) => row.nonCachedTokens),
      toolCalls: measuredSum(executed, (row) => row.toolCalls),
      wallTimeMs: measuredSum(executed, (row) => row.wallTimeMs),
      cacheHitFraction:
        inputTokens && cachedInputTokens !== null
          ? cachedInputTokens / inputTokens
          : null,
    };
  });
  const before = summary.find((row) => row.arm === 'rirei-v1');
  const after = summary.find((row) => row.arm === 'rirei-v2');
  return {
    schemaVersion: 1,
    mode: report.mode,
    sourceHistory: 'synthetic',
    providerSessions: report.providerSessions,
    provider: report.provider
      ? {
          cliVersion: report.provider.cliVersion,
          model: report.provider.model,
          effort: report.provider.effort,
          timeoutMs: report.provider.timeoutMs,
          automaticReruns: report.provider.automaticReruns,
        }
      : null,
    baselineBlob: report.baselineBlob,
    predecessorCaptureCost: null,
    humanPreparationCost: null,
    summary,
    rows,
    beforeAfterPercent: Object.fromEntries(
      [
        'promptCharacters',
        'inputTokens',
        'nonCachedTokens',
        'wallTimeMs',
        'toolCalls',
      ].map((key) => [key, percent(before[key], after[key])]),
    ),
    limitations: [
      'One successor per case and arm; no confidence intervals or causal attribution.',
      'These small tasks have a correctness ceiling and do not demonstrate a memory advantage.',
      'Cache reuse varies; non-cached tokens are not an authoritative bill or subscription-quota measure.',
      'Capture and human effort are unmeasured, not zero.',
      'Context-lookup command counts are attempts and can include short-circuited shell chains.',
      'Parent-directory searches are audit flags, not proof of answer leakage; filesystem read isolation was not adversarial.',
      'No real Claude predecessor, agent-written handoff, or Orca runtime was compared.',
    ],
  };
}

export function analysisMarkdown(analysis) {
  const display = (value) =>
    value === null ? 'Unknown' : value.toLocaleString('en-US');
  const lines = [
    '# Synthetic successor pilot',
    '',
    `Provider sessions: ${analysis.providerSessions}. Model: ${analysis.provider?.model ?? 'none'}; effort: ${analysis.provider?.effort ?? 'none'}.`,
    '',
    '| Arm | Correct / executed | Input tokens | Cached input | Output | Non-cached input + output | Tool calls | Wall time (ms) |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...analysis.summary.map(
      (row) =>
        `| ${row.arm} | ${row.correct ?? 'Unknown'} / ${row.executed} | ${display(row.inputTokens)} | ${display(row.cachedInputTokens)} | ${display(row.outputTokens)} | ${display(row.nonCachedTokens)} | ${display(row.toolCalls)} | ${display(row.wallTimeMs)} |`,
    ),
    '',
    '## V2 versus frozen V1',
    '',
    ...Object.entries(analysis.beforeAfterPercent).map(
      ([name, value]) =>
        `- ${name}: ${value === null ? 'Unknown' : `${value > 0 ? '+' : ''}${value}%`}.`,
    ),
    '',
    '## Limitations',
    '',
    ...analysis.limitations.map((value) => `- ${value}`),
    '',
  ];
  return lines.join('\n');
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const { values } = parseArgs({
    options: {
      'run-root': { type: 'string' },
      'output-directory': { type: 'string' },
    },
  });
  if (!values['run-root']) throw new Error('--run-root is required.');
  const root = path.resolve(values['run-root']);
  const report = JSON.parse(
    await readFile(path.join(root, 'report.json'), 'utf8'),
  );
  const traces = new Map();
  for (const row of report.rows) {
    if (!/^[a-z0-9-]+$/.test(row.task) || !ARMS.includes(row.arm))
      throw new Error('Invalid comparison row identifier.');
    const text = await readFile(
      path.join(root, row.task, `${row.arm}-artifacts`, 'stdout.jsonl'),
      'utf8',
    ).catch(() => undefined);
    if (text !== undefined) traces.set(`${row.task}/${row.arm}`, text);
  }
  const analysis = analyzeReport(report, traces);
  const destination = values['output-directory']
    ? path.resolve(values['output-directory'])
    : root;
  const serialized = JSON.stringify(analysis, null, 2) + '\n';
  if (/\/Users\/|\/private\/var\/|\/home\/|[A-Za-z]:\\/.test(serialized))
    throw new Error(
      'Analysis contains a private host path; review before export.',
    );
  if (values['output-directory'])
    await mkdir(destination, { recursive: false, mode: 0o700 });
  await writeFile(path.join(destination, 'analysis.json'), serialized, {
    mode: 0o600,
  });
  await writeFile(
    path.join(destination, 'analysis.md'),
    analysisMarkdown(analysis),
    {
      mode: 0o600,
    },
  );
  process.stdout.write(analysisMarkdown(analysis));
}
