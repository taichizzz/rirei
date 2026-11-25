import { describe, expect, it } from 'vitest';
import {
  analyzeCrossReport,
  crossTraceObservations,
} from '../../benchmarks/continuity/analyze-cross.mjs';

const receiver = (
  arm: string,
  passed: boolean,
  inputTokens: number | null,
) => ({
  arm,
  correct: true,
  evidenceIntact: true,
  grading: { passed, groups: [{ name: 'constraint', passed }] },
  checkpointHash: 'a'.repeat(64),
  historyHash: 'b'.repeat(64),
  execution: {
    exitCode: 0,
    failed: false,
    timedOut: false,
    wallTimeMs: 100,
    promptCharacters: 500,
    promptHash: 'c'.repeat(64),
    prompt: 'private prompt',
    cwd: '/Users/private',
    threadId: 'private-thread',
    metrics: {
      inputTokens,
      cachedInputTokens: 10,
      outputTokens: 5,
      nonCachedTokens: inputTokens === null ? null : inputTokens - 5,
      toolCalls: 2,
    },
  },
});
const report = (cases: unknown[]) => ({
  mode: 'real-bidirectional-predecessor-pilot',
  providerSessions: cases.length * 3,
  predecessorSessions: cases.length,
  receiverSessions: cases.length * 2,
  protocol: {
    automaticReruns: 0,
    versions: {},
    models: {},
    fixtureHashes: {},
    sourceHashes: {},
  },
  cases,
});
const checkpoint = (
  index: number,
  provider: string,
  target: string,
  arms: unknown[],
) => ({
  index,
  task: 'case',
  receiver: target,
  arms,
  checkpointHash: 'a'.repeat(64),
  historyHash: 'b'.repeat(64),
  captureQualified: true,
  checkpointGrading: { passed: false },
  predecessor: {
    provider,
    wallTimeMs: 50,
    interruptedByHarness: true,
    metrics: { inputTokens: null, outputTokens: null, nonCachedTokens: null },
  },
});

describe('two-way trace analysis', () => {
  it('retains acceptance passes while excluding infrastructure-affected pairs from clean performance totals', () => {
    const full = receiver('full-history', true, 100);
    const compact = receiver('rirei', true, 80);
    compact.execution.failed = true;
    const data = {
      ...report([checkpoint(0, 'codex', 'claude', [full, compact])]),
      reusedCheckpointCount: 1,
      sourceReportHash: 'a'.repeat(64),
      infrastructureIncidents: [{ caseIndex: 0 }],
    };
    const analysis = analyzeCrossReport(data);
    expect(analysis.receivers.find((row) => row.arm === 'rirei')).toMatchObject(
      { acceptancePassed: true, correct: false },
    );
    const affected = { ...compact, infrastructureAffected: true };
    const audited = analyzeCrossReport({
      ...data,
      cases: [checkpoint(0, 'codex', 'claude', [full, affected])],
    });
    expect(audited.summaries.find((row) => row.arm === 'rirei')).toMatchObject({
      acceptancePassed: 1,
      correct: 0,
      cleanCases: 0,
    });
    expect(
      audited.cleanPairSummaries.every(
        (row) => row.matchedCases === 0 && row.inputTokens === null,
      ),
    ).toBe(true);
  });
  it('keeps behavioral failures despite successful exits and a stale success flag', () => {
    const analysis = analyzeCrossReport(
      report([
        checkpoint(0, 'codex', 'claude', [
          receiver('full-history', true, 100),
          receiver('rirei', false, 80),
        ]),
      ]),
    );
    expect(analysis.receivers.find((row) => row.arm === 'rirei')).toMatchObject(
      { correct: false, failedGroups: ['constraint'] },
    );
    expect(analysis.summaries.find((row) => row.arm === 'rirei')).toMatchObject(
      { cases: 1, correct: 0 },
    );
    expect(analysis.totalPredecessorNonCachedTokens).toBeNull();
    expect(analysis.humanPreparationMinutes).toBeNull();
  });
  it('separates receiving providers and includes the failed authorization attempt in the total', () => {
    const analysis = analyzeCrossReport(
      report([
        checkpoint(0, 'codex', 'claude', [
          receiver('full-history', true, 100),
          receiver('rirei', false, 80),
        ]),
        checkpoint(1, 'claude', 'codex', [
          receiver('full-history', true, 1000),
          receiver('rirei', true, 800),
        ]),
      ]),
      new Map(),
      1,
    );
    expect(analysis.aggregateLaunchAttempts).toBe(7);
    expect(analysis.summaries).toHaveLength(4);
    expect(
      analysis.summaries.find(
        (row) => row.direction === 'codex-to-claude' && row.arm === 'rirei',
      )?.inputTokens,
    ).toBe(80);
    expect(
      analysis.summaries.find(
        (row) => row.direction === 'claude-to-codex' && row.arm === 'rirei',
      )?.inputTokens,
    ).toBe(800);
    expect(JSON.stringify(analysis)).not.toMatch(
      /private prompt|\/Users\/|private-thread/,
    );
  });
  it('does not turn missing cached, reasoning, or token counters into zero', () => {
    const arm = receiver('rirei', true, null);
    const analysis = analyzeCrossReport(
      report([
        checkpoint(0, 'codex', 'claude', [
          receiver('full-history', true, 100),
          arm,
        ]),
      ]),
    );
    expect(analysis.summaries.find((row) => row.arm === 'rirei')).toMatchObject(
      {
        inputTokens: null,
        nonCachedTokens: null,
        reasoningTokens: null,
        cacheCreationInputTokens: null,
      },
    );
  });
  it('deduplicates streamed tool IDs and distinguishes task lookups from source retrieval and stale paths', () => {
    const call = {
      type: 'tool_use',
      id: 'one',
      name: 'Bash',
      input: {
        command: 'false && relay context task; cd /old/workspace && pwd',
      },
    };
    const text = [
      { type: 'assistant', message: { content: [call] } },
      { type: 'assistant', message: { content: [call] } },
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'two',
              name: 'Read',
              input: { file_path: '/old/workspace/src/file.mjs' },
            },
          ],
        },
      },
      {
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'two', is_error: true },
          ],
        },
      },
    ]
      .map((value) => JSON.stringify(value))
      .join('\n');
    expect(
      crossTraceObservations('claude', text, {
        otherWorkspaces: ['/old/workspace'],
        predecessorWorkspace: '/old/workspace',
      }),
    ).toMatchObject({
      taskLookupCommands: 1,
      historyLookupCommands: 0,
      evidenceLookupCommands: 0,
      failedToolResults: 1,
      toolCallsReferencingOtherWorkspaces: 2,
      shellCallsReferencingPredecessor: 1,
      fileCallsReferencingPredecessor: 1,
    });
  });
});
