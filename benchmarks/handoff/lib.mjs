import { readFile } from 'node:fs/promises';

const numberAt = (object, keys) => {
  for (const key of keys) {
    const value = object?.[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
};

export function parseJsonLines(text) {
  const records = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      // Provider diagnostics can be interleaved with JSONL. They remain in the raw log.
    }
  }
  return records;
}

export function parseProviderMetrics(provider, text) {
  const records = parseJsonLines(text);
  if (records.length === 0) {
    return {
      inputTokens: null,
      cachedInputTokens: null,
      outputTokens: null,
      reasoningTokens: null,
      modelTurns: null,
      toolCalls: null,
    };
  }

  if (provider === 'antigravity') {
    return parseAntigravityMetrics(records);
  }

  let usageEvents = 0;
  let inputEvents = 0;
  let cachedInputEvents = 0;
  let outputEvents = 0;
  let inputTokens = 0;
  let cachedInputTokens = 0;
  let outputTokens = 0;
  let reasoningTokens = 0;
  let reasoningSeen = false;
  let modelTurns = 0;
  let turnShapeSeen = false;
  let toolCalls = 0;
  let toolShapeSeen = false;

  for (const record of records) {
    const usage =
      record.type === 'turn.completed'
        ? record.usage
        : record.type === 'result'
          ? (record.usage_metadata ?? record.usage ?? record.stats)
          : null;
    if (usage && typeof usage === 'object') {
      const input = numberAt(usage, [
        'input_tokens',
        'inputTokenCount',
        'prompt_token_count',
      ]);
      const cached = numberAt(usage, [
        'cached_input_tokens',
        'cachedInputTokenCount',
        'cached_content_token_count',
      ]);
      const output = numberAt(usage, [
        'output_tokens',
        'outputTokenCount',
        'candidates_token_count',
      ]);
      const reasoning =
        numberAt(usage, ['reasoning_tokens', 'thoughts_token_count']) ??
        numberAt(usage.output_tokens_details, ['reasoning_tokens']);
      if (input !== null || cached !== null || output !== null)
        usageEvents += 1;
      if (input !== null) inputEvents += 1;
      if (cached !== null) cachedInputEvents += 1;
      if (output !== null) outputEvents += 1;
      inputTokens += input ?? 0;
      cachedInputTokens += cached ?? 0;
      outputTokens += output ?? 0;
      if (reasoning !== null) {
        reasoningSeen = true;
        reasoningTokens += reasoning;
      }
    }

    if (record.type === 'turn.started' || record.type === 'turn.completed') {
      turnShapeSeen = true;
      if (record.type === 'turn.completed') modelTurns += 1;
    }
    if (record.type === 'item.started' || record.type === 'item.completed') {
      const itemType = record.item?.type;
      if (typeof itemType === 'string') toolShapeSeen = true;
      if (
        record.type === 'item.started' &&
        ['command_execution', 'file_change', 'mcp_tool_call'].includes(itemType)
      ) {
        toolCalls += 1;
      }
    }
  }

  return {
    inputTokens:
      usageEvents > 0 && inputEvents === usageEvents ? inputTokens : null,
    cachedInputTokens:
      usageEvents > 0 && cachedInputEvents === usageEvents
        ? cachedInputTokens
        : null,
    outputTokens:
      usageEvents > 0 && outputEvents === usageEvents ? outputTokens : null,
    reasoningTokens: reasoningSeen ? reasoningTokens : null,
    modelTurns: turnShapeSeen ? modelTurns : null,
    toolCalls: toolShapeSeen ? toolCalls : null,
  };
}

function parseAntigravityMetrics(records) {
  const finalResult = records.findLast(
    (record) => record.event === 'result' && record.result,
  );
  const finalUsage = finalResult?.result?.usage;
  const usageRecords = finalUsage
    ? [finalUsage]
    : records
        .filter((record) => record.event === 'step_update')
        .map((record) => record.step_update?.usage)
        .filter((usage) => usage && typeof usage === 'object');
  const sumMetric = (key) => {
    if (usageRecords.length === 0) return null;
    const values = usageRecords.map((usage) => numberAt(usage, [key]));
    return values.every((value) => value !== null)
      ? values.reduce((total, value) => total + value, 0)
      : null;
  };
  const completedTools = records.filter(
    (record) =>
      record.event === 'step_update' &&
      record.step_update?.step_type === 'tool' &&
      record.step_update?.state === 'DONE',
  );
  const toolShapeSeen = records.some(
    (record) =>
      record.event === 'step_update' &&
      record.step_update?.step_type === 'tool',
  );
  const finalTurns = numberAt(finalUsage, ['num_turns']);
  return {
    inputTokens: sumMetric('input_tokens'),
    cachedInputTokens: sumMetric('cache_read_tokens'),
    outputTokens: sumMetric('output_tokens'),
    reasoningTokens: sumMetric('thinking_tokens'),
    modelTurns: finalTurns,
    toolCalls: toolShapeSeen ? completedTools.length : null,
  };
}

export function summarizeHandoff(handoff) {
  const notes = handoff?.capsule?.notes;
  if (!Array.isArray(notes)) {
    return {
      characters:
        typeof handoff?.text === 'string' ? handoff.text.length : null,
      estimatedTokens: handoff?.budget?.estimatedTokens ?? null,
      omissions: handoff?.budget?.omittedItems ?? null,
      notes: null,
    };
  }
  const byType = {};
  const byProvenance = {};
  const byFreshness = {};
  for (const note of notes) {
    byType[note.type] = (byType[note.type] ?? 0) + 1;
    const provenance =
      note.provenance?.source === 'agent'
        ? `agent:${note.provenance.agent ?? 'unknown'}`
        : (note.provenance?.source ?? 'unknown');
    byProvenance[provenance] = (byProvenance[provenance] ?? 0) + 1;
    const freshness = note.freshness ?? 'unknown';
    byFreshness[freshness] = (byFreshness[freshness] ?? 0) + 1;
  }
  return {
    characters: typeof handoff.text === 'string' ? handoff.text.length : null,
    estimatedTokens: handoff.budget?.estimatedTokens ?? null,
    omissions: handoff.budget?.omittedItems ?? null,
    notes: {
      count: notes.length,
      byType,
      byProvenance,
      byFreshness,
    },
  };
}

export function nonCachedTokens(metrics) {
  if (
    metrics?.inputTokens === null ||
    metrics?.inputTokens === undefined ||
    metrics?.cachedInputTokens === null ||
    metrics?.cachedInputTokens === undefined ||
    metrics?.outputTokens === null ||
    metrics?.outputTokens === undefined
  ) {
    return null;
  }
  return metrics.inputTokens - metrics.cachedInputTokens + metrics.outputTokens;
}

const mean = (values) =>
  values.length === 0
    ? null
    : values.reduce((total, value) => total + value, 0) / values.length;

const median = (values) => {
  if (values.length === 0) return null;
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2
    ? ordered[middle]
    : (ordered[middle - 1] + ordered[middle]) / 2;
};

export function aggregateResults(taskResults) {
  const pairs = taskResults.map((task) => {
    const baseline = task.conditions.baseline;
    const treatment = task.conditions.treatment;
    const baselineTokens = nonCachedTokens(baseline.metrics);
    const treatmentTokens = nonCachedTokens(treatment.metrics);
    const timeReduction =
      baseline.wallTimeMs > 0
        ? (baseline.wallTimeMs - treatment.wallTimeMs) / baseline.wallTimeMs
        : null;
    const tokenReduction =
      baselineTokens !== null && baselineTokens > 0 && treatmentTokens !== null
        ? (baselineTokens - treatmentTokens) / baselineTokens
        : null;
    const treatmentCorrect = treatment.evaluation.combined.passed;
    const baselineCorrect = baseline.evaluation.combined.passed;
    return {
      taskId: task.taskId,
      order: task.order,
      correctness: { baseline: baselineCorrect, treatment: treatmentCorrect },
      wallTimeDeltaMs: treatment.wallTimeMs - baseline.wallTimeMs,
      timeReduction,
      nonCachedTokenDelta:
        baselineTokens === null || treatmentTokens === null
          ? null
          : treatmentTokens - baselineTokens,
      tokenReduction,
      reachesTwentyPercent:
        treatmentCorrect &&
        ((timeReduction !== null && timeReduction >= 0.2) ||
          (tokenReduction !== null && tokenReduction >= 0.2)),
      misleadingHandoffFailure: treatmentCorrect ? false : null,
      captureNotes: task.capture?.count ?? null,
      handoffTokens: task.handoff?.estimatedTokens ?? null,
      relayLeaks:
        task.conditions.baseline.relayStateAccessed ||
        task.conditions.treatment.relayStateAccessed
          ? 'yes'
          : 'no',
    };
  });
  const values = (selector) =>
    pairs.map(selector).filter((value) => typeof value === 'number');
  const successCounts = {
    baseline: pairs.filter((pair) => pair.correctness.baseline).length,
    treatment: pairs.filter((pair) => pair.correctness.treatment).length,
  };
  const improvedTasks = pairs.filter(
    (pair) => pair.reachesTwentyPercent,
  ).length;
  const correctnessMaintained = pairs.every(
    (pair) => pair.correctness.treatment,
  );
  const handoffFailureReviewClear = pairs.every(
    (pair) => pair.misleadingHandoffFailure === false,
  );
  const baselineTokenTotals = taskResults.map((task) =>
    nonCachedTokens(task.conditions.baseline.metrics),
  );
  const treatmentTokenTotals = taskResults.map((task) =>
    nonCachedTokens(task.conditions.treatment.metrics),
  );
  const baselineWallTimeTotal = taskResults.reduce(
    (total, task) => total + task.conditions.baseline.wallTimeMs,
    0,
  );
  const treatmentWallTimeTotal = taskResults.reduce(
    (total, task) => total + task.conditions.treatment.wallTimeMs,
    0,
  );
  return {
    pairs,
    summary: {
      taskCount: pairs.length,
      successCounts,
      wallTimeDeltaMs: {
        mean: mean(values((pair) => pair.wallTimeDeltaMs)),
        median: median(values((pair) => pair.wallTimeDeltaMs)),
      },
      nonCachedTokenDelta: {
        mean: mean(values((pair) => pair.nonCachedTokenDelta)),
        median: median(values((pair) => pair.nonCachedTokenDelta)),
      },
      totals: {
        wallTimeMs: {
          baseline: baselineWallTimeTotal,
          treatment: treatmentWallTimeTotal,
          delta: treatmentWallTimeTotal - baselineWallTimeTotal,
        },
        nonCachedTokens: {
          baseline: baselineTokenTotals.every((value) => value !== null)
            ? baselineTokenTotals.reduce((total, value) => total + value, 0)
            : null,
          treatment: treatmentTokenTotals.every((value) => value !== null)
            ? treatmentTokenTotals.reduce((total, value) => total + value, 0)
            : null,
        },
      },
      improvedTasks,
      decisionRule: {
        text: 'Treatment must maintain correctness and reduce non-cached tokens or wall time by at least 20% on at least 3/5 tasks, with no misleading handoff-caused failure.',
        correctnessMaintained,
        handoffFailureReviewClear,
        passed:
          correctnessMaintained &&
          improvedTasks >= 3 &&
          handoffFailureReviewClear,
      },
    },
  };
}

export async function analyzeResultFile(path) {
  const result = JSON.parse(await readFile(path, 'utf8'));
  return aggregateResults(result.tasks);
}
