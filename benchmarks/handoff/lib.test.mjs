import assert from 'node:assert/strict';
import test from 'node:test';
import {
  aggregateResults,
  parseJsonLines,
  parseProviderMetrics,
  summarizeHandoff,
} from './lib.mjs';

test('parses JSONL without treating diagnostics as data', () => {
  assert.deepEqual(parseJsonLines('{"type":"turn.started"}\nnoise\n'), [
    { type: 'turn.started' },
  ]);
});

test('extracts only emitted Codex metrics', () => {
  const metrics = parseProviderMetrics(
    'codex',
    [
      JSON.stringify({ type: 'turn.started' }),
      JSON.stringify({
        type: 'item.started',
        item: { type: 'command_execution' },
      }),
      JSON.stringify({
        type: 'turn.completed',
        usage: {
          input_tokens: 100,
          cached_input_tokens: 20,
          output_tokens: 30,
          output_tokens_details: { reasoning_tokens: 7 },
        },
      }),
    ].join('\n'),
  );
  assert.deepEqual(metrics, {
    inputTokens: 100,
    cachedInputTokens: 20,
    outputTokens: 30,
    reasoningTokens: 7,
    modelTurns: 1,
    toolCalls: 1,
  });
  assert.equal(parseProviderMetrics('codex', 'not json').inputTokens, null);
  assert.equal(
    parseProviderMetrics(
      'codex',
      JSON.stringify({
        type: 'turn.completed',
        usage: { input_tokens: 10, output_tokens: 2 },
      }),
    ).cachedInputTokens,
    null,
  );
});

test('uses authoritative Antigravity result usage without double-counting steps', () => {
  const metrics = parseProviderMetrics(
    'antigravity',
    [
      {
        event: 'step_update',
        step_update: {
          state: 'DONE',
          step_type: 'agent_response',
          usage: {
            input_tokens: 40,
            output_tokens: 4,
            cache_read_tokens: 10,
            thinking_tokens: 1,
          },
        },
      },
      {
        event: 'step_update',
        step_update: { state: 'DONE', step_type: 'tool' },
      },
      {
        event: 'result',
        result: {
          usage: {
            input_tokens: 100,
            output_tokens: 12,
            cache_read_tokens: 30,
            thinking_tokens: 5,
            num_turns: 3,
          },
        },
      },
    ]
      .map(JSON.stringify)
      .join('\n'),
  );
  assert.deepEqual(metrics, {
    inputTokens: 100,
    cachedInputTokens: 30,
    outputTokens: 12,
    reasoningTokens: 5,
    modelTurns: 3,
    toolCalls: 1,
  });
});

test('summarizes handoff notes and omissions', () => {
  const summary = summarizeHandoff({
    text: 'abc',
    budget: { estimatedTokens: 1, omittedItems: 2 },
    capsule: {
      notes: [
        {
          type: 'next',
          freshness: 'current',
          provenance: { source: 'agent', agent: 'antigravity' },
        },
      ],
    },
  });
  assert.equal(summary.characters, 3);
  assert.deepEqual(summary.notes.byProvenance, { 'agent:antigravity': 1 });
});

test('aggregates paired deltas and applies the predeclared rule', () => {
  const condition = (wallTimeMs, inputTokens, passed = true) => ({
    wallTimeMs,
    metrics: { inputTokens, cachedInputTokens: 0, outputTokens: 0 },
    evaluation: { combined: { passed } },
  });
  const tasks = [0, 1, 2, 3, 4].map((index) => ({
    taskId: `t${index}`,
    order: ['baseline', 'treatment'],
    conditions: {
      baseline: condition(100, 100),
      treatment: condition(index < 3 ? 70 : 100, 100),
    },
  }));
  const analysis = aggregateResults(tasks);
  assert.equal(analysis.summary.improvedTasks, 3);
  assert.equal(analysis.summary.decisionRule.passed, true);
  assert.deepEqual(analysis.summary.totals, {
    wallTimeMs: { baseline: 500, treatment: 410, delta: -90 },
    nonCachedTokens: { baseline: 500, treatment: 500 },
  });
});
