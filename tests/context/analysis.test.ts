import { describe, expect, it } from 'vitest';
import {
  analyzeReport,
  traceObservations,
} from '../../benchmarks/continuity/analyze.mjs';

describe('pilot analysis', () => {
  it('separates raw-input reduction from a cache-driven non-cached increase and strips raw artifact fields', () => {
    const row = (
      arm: string,
      inputTokens: number,
      cachedInputTokens: number,
    ) => ({
      task: 'case',
      arm,
      promptHash: 'a'.repeat(64),
      codeInputHash: 'b'.repeat(64),
      historyHash: 'c'.repeat(64),
      promptCharacters: arm === 'rirei-v1' ? 1000 : 800,
      prompt: 'private prompt',
      cwd: '/Users/private',
      threadId: 'private-session',
      inlineTargetCount: 1,
      inlineTargetTotal: 1,
      evidenceIntact: true,
      grading: { passed: true },
      execution: {
        exitCode: 0,
        timedOut: false,
        wallTimeMs: 100,
        metrics: {
          inputTokens,
          cachedInputTokens,
          outputTokens: 10,
          toolCalls: 1,
        },
      },
    });
    const analysis = analyzeReport({
      rows: [row('rirei-v1', 100, 90), row('rirei-v2', 80, 40)],
      providerSessions: 2,
    });
    expect(analysis.beforeAfterPercent).toMatchObject({
      promptCharacters: -20,
      inputTokens: -20,
      nonCachedTokens: 150,
    });
    expect(JSON.stringify(analysis)).not.toMatch(
      /private prompt|\/Users\/|private-session/,
    );
    expect(analysis.predecessorCaptureCost).toBeNull();
  });

  it('does not turn missing reasoning, usage, or unexecuted correctness into zeros', () => {
    const analysis = analyzeReport({
      rows: [
        {
          task: 'case',
          arm: 'rirei-v1',
          promptCharacters: 100,
          execution: null,
        },
      ],
      providerSessions: 0,
    });
    expect(
      analysis.summary.find((row) => row.arm === 'rirei-v1'),
    ).toMatchObject({
      correct: null,
      inputTokens: null,
      nonCachedTokens: null,
      reasoningTokens: null,
    });
  });

  it('counts lookup attempts and flags parent searches without claiming successful retrieval or leakage', () => {
    const trace = [
      {
        type: 'item.started',
        item: { type: 'command_execution', command: 'relay context task' },
      },
      {
        type: 'item.completed',
        item: {
          type: 'command_execution',
          command: 'false && relay context task',
          exit_code: 1,
        },
      },
      {
        type: 'item.completed',
        item: {
          type: 'command_execution',
          command: 'find .. -name AGENTS.md',
          exit_code: 0,
        },
      },
    ]
      .map((item) => JSON.stringify(item))
      .join('\n');
    expect(traceObservations(trace)).toEqual({
      completedCommandItems: 2,
      failedCommandItems: 1,
      commandsContainingContextLookup: 1,
      parentDirectorySearchCommands: 1,
    });
  });
});
