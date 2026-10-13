import assert from 'node:assert/strict';
import test from 'node:test';
import {
  aggregateResults,
  detectIdenticalPrompts,
  HANDOFF_BUDGETS,
  hashPrompt,
  nonAliasConditions,
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

test('HANDOFF_BUDGETS defines 300, 800, and 2000 token tiers', () => {
  assert.deepEqual(HANDOFF_BUDGETS, [300, 800, 2000]);
});

test('hashPrompt computes deterministic SHA-256 hex string', () => {
  const hash1 = hashPrompt('test prompt text');
  const hash2 = hashPrompt('test prompt text');
  const hash3 = hashPrompt('different text');
  assert.equal(hash1, hash2);
  assert.equal(typeof hash1, 'string');
  assert.equal(hash1.length, 64);
  assert.notEqual(hash1, hash3);
});

test('detectIdenticalPrompts detects identical prompts across budgets to prevent duplicate calls', () => {
  const commonText = 'Task: Fix bug\n\nGit: main@1234567\n\nInspect the tree.';
  const budgetHandoffs = {
    300: {
      text: commonText,
      budget: { estimatedTokens: 40, usedCharacters: commonText.length },
    },
    800: {
      text: commonText,
      budget: { estimatedTokens: 40, usedCharacters: commonText.length },
    },
    2000: {
      text: commonText,
      budget: { estimatedTokens: 40, usedCharacters: commonText.length },
    },
  };

  const results = detectIdenticalPrompts(budgetHandoffs);
  assert.equal(results[300].isDuplicate, false);
  assert.equal(results[300].identicalTo, null);
  assert.equal(results[300].maxTokens, 300);
  assert.equal(results[300].maxCharacters, 1200);

  assert.equal(results[800].isDuplicate, true);
  assert.equal(results[800].identicalTo, 300);
  assert.equal(results[800].maxTokens, 800);
  assert.equal(results[800].maxCharacters, 3200);

  assert.equal(results[2000].isDuplicate, true);
  assert.equal(results[2000].identicalTo, 300);
  assert.equal(results[2000].maxTokens, 2000);
  assert.equal(results[2000].maxCharacters, 8000);
});

test('detectIdenticalPrompts identifies distinct and duplicate prompts when handoffs diverge', () => {
  const prompt300 = 'Task: Fix bug\n\nNext: step 1';
  const prompt800 = 'Task: Fix bug\n\nNext: step 1; step 2; step 3';
  const prompt2000 = prompt800; // all notes fit in 800 so 2000 is identical to 800

  const budgetHandoffs = {
    300: {
      text: prompt300,
      budget: {
        estimatedTokens: 30,
        usedCharacters: prompt300.length,
        omittedItems: 2,
      },
    },
    800: {
      text: prompt800,
      budget: {
        estimatedTokens: 50,
        usedCharacters: prompt800.length,
        omittedItems: 0,
      },
    },
    2000: {
      text: prompt2000,
      budget: {
        estimatedTokens: 50,
        usedCharacters: prompt2000.length,
        omittedItems: 0,
      },
    },
  };

  const results = detectIdenticalPrompts(budgetHandoffs);
  assert.equal(results[300].isDuplicate, false);
  assert.equal(results[300].identicalTo, null);
  assert.equal(results[300].omittedItems, 2);

  assert.equal(results[800].isDuplicate, false);
  assert.equal(results[800].identicalTo, null);
  assert.equal(results[800].omittedItems, 0);

  assert.equal(results[2000].isDuplicate, true);
  assert.equal(results[2000].identicalTo, 800);
  assert.equal(results[2000].omittedItems, 0);
});

test('nonAliasConditions filters alias conditions based on order and key presence', () => {
  const condA = { name: 'baseline' };
  const condB = { name: 'handoff-no-notes' };
  const condC = { name: 'handoff-300' };
  const condD = { name: 'handoff-800' };
  const condE = { name: 'handoff-2000' };

  // Task with explicit order (5 arms)
  const taskWithOrder = {
    order: [
      'baseline',
      'handoff-no-notes',
      'handoff-300',
      'handoff-800',
      'handoff-2000',
    ],
    conditions: {
      baseline: condA,
      'handoff-no-notes': condB,
      'handoff-300': condC,
      'handoff-800': condD,
      'handoff-2000': condE,
      'handoff-with-notes': condC, // alias
    },
  };
  const resultWithOrder = nonAliasConditions(taskWithOrder);
  assert.equal(resultWithOrder.length, 5);
  assert.deepEqual(resultWithOrder, [condA, condB, condC, condD, condE]);

  // Task without order, containing handoff-300 and handoff-with-notes alias
  const taskWithoutOrder = {
    conditions: {
      baseline: condA,
      'handoff-300': condC,
      'handoff-with-notes': condC,
      'handoff-800': condD,
    },
  };
  const resultWithoutOrder = nonAliasConditions(taskWithoutOrder);
  assert.equal(resultWithoutOrder.length, 3);
  assert.deepEqual(resultWithoutOrder, [condA, condC, condD]);

  // Task with legacy baseline + treatment
  const legacyTask = {
    conditions: {
      baseline: condA,
      treatment: condC,
    },
  };
  const legacyResult = nonAliasConditions(legacyTask);
  assert.equal(legacyResult.length, 2);
  assert.deepEqual(legacyResult, [condA, condC]);
});

test('aggregateResults analyzes all three budget arms with pairwise comparisons and avoids double counting', () => {
  const makeCond = (
    wallTimeMs,
    inputTokens,
    outputTokens = 10,
    passed = true,
    extra = {},
  ) => ({
    wallTimeMs,
    metrics: {
      inputTokens,
      cachedInputTokens: 0,
      outputTokens,
      toolCalls: 4,
      distinctFilesRead: 2,
      timeToFirstEditMs: 500,
      turnsBeforeFirstEdit: 1,
      ...extra.metrics,
    },
    evaluation: { combined: { passed } },
    ...extra,
  });

  const cond300 = makeCond(100, 80, 10, true);
  const tasks = [
    {
      taskId: 'task-1',
      order: [
        'baseline',
        'handoff-no-notes',
        'handoff-300',
        'handoff-800',
        'handoff-2000',
      ],
      capture: { count: 3 },
      handoff: { estimatedTokens: 250 },
      conditions: {
        baseline: makeCond(200, 150, 10, true),
        'handoff-no-notes': makeCond(180, 120, 10, true),
        'handoff-300': cond300,
        'handoff-800': makeCond(80, 60, 10, true),
        'handoff-2000': makeCond(60, 40, 10, true),
        'handoff-with-notes': cond300, // alias pointing to handoff-300
      },
    },
  ];

  const analysis = aggregateResults(tasks);
  assert.equal(analysis.summary.taskCount, 1);

  // Correctness across all budget arms
  assert.equal(analysis.summary.successCounts.baseline, 1);
  assert.equal(analysis.summary.successCounts['handoff-no-notes'], 1);
  assert.equal(analysis.summary.successCounts['handoff-300'], 1);
  assert.equal(analysis.summary.successCounts['handoff-800'], 1);
  assert.equal(analysis.summary.successCounts['handoff-2000'], 1);

  // Totals include budget arms
  assert.equal(analysis.summary.totals.wallTimeMs['handoff-300'], 100);
  assert.equal(analysis.summary.totals.wallTimeMs['handoff-800'], 80);
  assert.equal(analysis.summary.totals.wallTimeMs['handoff-2000'], 60);

  assert.equal(analysis.summary.totals.nonCachedTokens['handoff-300'], 90);
  assert.equal(analysis.summary.totals.nonCachedTokens['handoff-800'], 70);
  assert.equal(analysis.summary.totals.nonCachedTokens['handoff-2000'], 50);

  // Per-budget summaries in summary.budgets
  assert.ok(analysis.summary.budgets[300]);
  assert.ok(analysis.summary.budgets[800]);
  assert.ok(analysis.summary.budgets[2000]);

  assert.equal(analysis.summary.budgets[300].successCount, 1);
  assert.equal(analysis.summary.budgets[800].successCount, 1);
  assert.equal(analysis.summary.budgets[2000].successCount, 1);

  // Pair comparisons between budgets
  assert.equal(
    analysis.summary.comparisons.handoff800VsBaseline.improvedTasks,
    1,
  );
  assert.equal(
    analysis.summary.comparisons.handoff2000VsBaseline.improvedTasks,
    1,
  );
  assert.ok(analysis.summary.comparisons.handoff800VsHandoff300);
  assert.ok(analysis.summary.comparisons.handoff2000VsHandoff300);
  assert.ok(analysis.summary.comparisons.handoff2000VsHandoff800);

  // Pair exploration metrics include all budget arms
  const pair = analysis.pairs[0];
  assert.equal(pair.correctness['handoff-300'], true);
  assert.equal(pair.correctness['handoff-800'], true);
  assert.equal(pair.correctness['handoff-2000'], true);
  assert.ok(pair.exploration['handoff-300']);
  assert.ok(pair.exploration['handoff-800']);
  assert.ok(pair.exploration['handoff-2000']);
  assert.ok(pair.budgets[300]);
  assert.ok(pair.budgets[800]);
  assert.ok(pair.budgets[2000]);
});
