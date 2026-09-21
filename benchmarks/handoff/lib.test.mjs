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
    distinctFilesRead: null,
    timeToFirstEditMs: null,
    turnsBeforeFirstEdit: null,
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
    distinctFilesRead: null,
    timeToFirstEditMs: null,
    turnsBeforeFirstEdit: null,
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

test('extracts exploration metrics when exposed and leaves missing metrics null', () => {
  const codexLog = [
    JSON.stringify({ type: 'turn.started', timestamp: 1000 }),
    JSON.stringify({
      type: 'item.started',
      item: { type: 'file_read', path: 'src/index.js' },
      timestamp: 1200,
    }),
    JSON.stringify({
      type: 'item.started',
      item: { type: 'file_read', path: 'src/utils.js' },
      timestamp: 1400,
    }),
    JSON.stringify({
      type: 'item.started',
      item: { type: 'file_read', path: 'src/index.js' }, // duplicate read
      timestamp: 1500,
    }),
    JSON.stringify({
      type: 'turn.completed',
      usage: { input_tokens: 50, output_tokens: 10 },
      timestamp: 1600,
    }),
    JSON.stringify({
      type: 'turn.started',
      timestamp: 1700,
    }),
    JSON.stringify({
      type: 'item.started',
      item: { type: 'file_change' },
      timestamp: 2500,
    }),
    JSON.stringify({
      type: 'turn.completed',
      usage: { input_tokens: 60, output_tokens: 20 },
      timestamp: 3000,
    }),
  ].join('\n');

  const metrics = parseProviderMetrics('codex', codexLog);
  assert.equal(metrics.distinctFilesRead, 2);
  assert.equal(metrics.timeToFirstEditMs, 1500); // 2500 - 1000
  assert.equal(metrics.turnsBeforeFirstEdit, 1);
  assert.equal(metrics.toolCalls, 1); // 1 file_change

  // Missing exploration metrics stay null
  const bareLog = JSON.stringify({
    type: 'turn.completed',
    usage: { input_tokens: 10, output_tokens: 2 },
  });
  const bareMetrics = parseProviderMetrics('codex', bareLog);
  assert.equal(bareMetrics.distinctFilesRead, null);
  assert.equal(bareMetrics.timeToFirstEditMs, null);
  assert.equal(bareMetrics.turnsBeforeFirstEdit, null);
});

test('evaluates three arms separately with pairwise deltas without collapsing', () => {
  const condition = (wallTimeMs, inputTokens, filesRead, passed = true) => ({
    wallTimeMs,
    metrics: {
      inputTokens,
      cachedInputTokens: 0,
      outputTokens: 0,
      distinctFilesRead: filesRead,
      toolCalls: 2,
      timeToFirstEditMs: 500,
      turnsBeforeFirstEdit: 1,
    },
    evaluation: { combined: { passed } },
  });

  const tasks = [0, 1, 2].map((index) => ({
    taskId: `task-${index}`,
    order: ['baseline', 'handoff-no-notes', 'handoff-with-notes'],
    conditions: {
      baseline: condition(100, 200, 5, true),
      'handoff-no-notes': condition(95, 190, 4, true),
      'handoff-with-notes': condition(60, 100, 2, true),
    },
  }));

  const analysis = aggregateResults(tasks);
  assert.equal(analysis.summary.taskCount, 3);
  assert.equal(analysis.summary.successCounts.baseline, 3);
  assert.equal(analysis.summary.successCounts['handoff-no-notes'], 3);
  assert.equal(analysis.summary.successCounts['handoff-with-notes'], 3);

  // Pairwise comparisons exist separately
  const firstPair = analysis.pairs[0];
  assert.ok(firstPair.comparisons.withNotesVsBaseline);
  assert.ok(firstPair.comparisons.noNotesVsBaseline);
  assert.ok(firstPair.comparisons.withNotesVsNoNotes);

  // withNotes vs baseline
  assert.equal(
    firstPair.comparisons.withNotesVsBaseline.nonCachedTokenDelta,
    -100,
  );
  assert.equal(
    firstPair.comparisons.withNotesVsBaseline.distinctFilesReadDelta,
    -3,
  );
  assert.equal(
    firstPair.comparisons.withNotesVsBaseline.reachesTwentyPercent,
    true,
  );

  // noNotes vs baseline
  assert.equal(
    firstPair.comparisons.noNotesVsBaseline.nonCachedTokenDelta,
    -10,
  );
  assert.equal(
    firstPair.comparisons.noNotesVsBaseline.distinctFilesReadDelta,
    -1,
  );
  assert.equal(
    firstPair.comparisons.noNotesVsBaseline.reachesTwentyPercent,
    false,
  );

  // withNotes vs noNotes
  assert.equal(
    firstPair.comparisons.withNotesVsNoNotes.nonCachedTokenDelta,
    -90,
  );
  assert.equal(
    firstPair.comparisons.withNotesVsNoNotes.distinctFilesReadDelta,
    -2,
  );

  // Summary exploration metrics
  assert.equal(analysis.summary.exploration.baseline.distinctFilesRead.mean, 5);
  assert.equal(
    analysis.summary.exploration['handoff-no-notes'].distinctFilesRead.mean,
    4,
  );
  assert.equal(
    analysis.summary.exploration['handoff-with-notes'].distinctFilesRead.mean,
    2,
  );
});
