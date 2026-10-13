import { createHash } from 'node:crypto';
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

function recordTimestampMs(record) {
  const candidate =
    record?.timestamp ??
    record?.created_at ??
    record?.item?.created_at ??
    record?.time;
  if (typeof candidate === 'number' && Number.isFinite(candidate)) {
    if (candidate >= 1e9 && candidate < 2e10) {
      return candidate * 1000;
    }
    return candidate;
  }
  if (typeof candidate === 'string') {
    const ms = Date.parse(candidate);
    if (!Number.isNaN(ms)) return ms;
  }
  return null;
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
      distinctFilesRead: null,
      timeToFirstEditMs: null,
      turnsBeforeFirstEdit: null,
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

  // Exploration metrics
  const filesReadSet = new Set();
  let fileReadShapeSeen = false;
  let timeToFirstEditMs = null;
  let turnsBeforeFirstEdit = null;
  let firstTimestampMs = null;
  let firstEditSeen = false;

  for (const record of records) {
    const recordMs = recordTimestampMs(record);
    if (recordMs !== null && firstTimestampMs === null) {
      firstTimestampMs = recordMs;
    }

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

      if (['file_read', 'read_file', 'view_file'].includes(itemType)) {
        fileReadShapeSeen = true;
        const filePath =
          record.item?.path ??
          record.item?.file_path ??
          record.item?.filePath ??
          record.item?.file;
        if (typeof filePath === 'string' && filePath.length > 0) {
          filesReadSet.add(filePath);
        }
      }

      const isEdit =
        record.type === 'item.started' &&
        ['file_change', 'write_to_file', 'file_edit', 'edit_file'].includes(
          itemType,
        );
      if (isEdit && !firstEditSeen) {
        firstEditSeen = true;
        turnsBeforeFirstEdit = turnShapeSeen ? modelTurns : null;
        if (firstTimestampMs !== null && recordMs !== null) {
          timeToFirstEditMs = Math.max(0, recordMs - firstTimestampMs);
        }
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
    distinctFilesRead: fileReadShapeSeen ? filesReadSet.size : null,
    timeToFirstEditMs,
    turnsBeforeFirstEdit,
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

  const filesReadSet = new Set();
  let fileReadShapeSeen = false;
  let timeToFirstEditMs = null;
  let turnsBeforeFirstEdit = null;
  let firstTimestampMs = null;
  let firstEditSeen = false;
  let completedTurns = 0;
  let turnShapeSeen = false;

  for (const record of records) {
    const recordMs = recordTimestampMs(record);
    if (recordMs !== null && firstTimestampMs === null) {
      firstTimestampMs = recordMs;
    }
    if (record.event === 'step_update') {
      const step = record.step_update;
      if (step?.step_type === 'agent_response' && step?.state === 'DONE') {
        completedTurns += 1;
        turnShapeSeen = true;
      }
      if (step?.step_type === 'tool') {
        const toolName = step?.tool_call?.name ?? step?.tool_name;
        if (['view_file', 'read_file', 'file_read'].includes(toolName)) {
          fileReadShapeSeen = true;
          const args = step?.tool_call?.args ?? step?.args;
          const filePath = args?.AbsolutePath ?? args?.path ?? args?.file_path;
          if (typeof filePath === 'string' && filePath.length > 0) {
            filesReadSet.add(filePath);
          }
        }
        const isEdit = [
          'write_to_file',
          'replace_file_content',
          'file_change',
          'edit_file',
        ].includes(toolName);
        if (isEdit && !firstEditSeen) {
          firstEditSeen = true;
          turnsBeforeFirstEdit =
            finalTurns ?? (turnShapeSeen ? completedTurns : null);
          if (firstTimestampMs !== null && recordMs !== null) {
            timeToFirstEditMs = Math.max(0, recordMs - firstTimestampMs);
          }
        }
      }
    }
  }

  return {
    inputTokens: sumMetric('input_tokens'),
    cachedInputTokens: sumMetric('cache_read_tokens'),
    outputTokens: sumMetric('output_tokens'),
    reasoningTokens: sumMetric('thinking_tokens'),
    modelTurns: finalTurns ?? (turnShapeSeen ? completedTurns : null),
    toolCalls: toolShapeSeen ? completedTools.length : null,
    distinctFilesRead: fileReadShapeSeen ? filesReadSet.size : null,
    timeToFirstEditMs,
    turnsBeforeFirstEdit,
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

export const HANDOFF_BUDGETS = [300, 800, 2000];

export function hashPrompt(text) {
  return createHash('sha256')
    .update(text ?? '')
    .digest('hex');
}

export function detectIdenticalPrompts(budgetHandoffs) {
  const entries = (
    Array.isArray(budgetHandoffs)
      ? budgetHandoffs
      : Object.entries(budgetHandoffs).map(([budget, handoff]) => ({
          budget: Number(budget),
          handoff,
        }))
  ).sort((a, b) => a.budget - b.budget);

  const seenHashes = new Map();
  const results = {};

  for (const entry of entries) {
    const budget = entry.budget;
    const handoff = entry.handoff ?? entry;
    const text = typeof handoff === 'string' ? handoff : (handoff?.text ?? '');
    const sha256 = handoff?.sha256 ?? hashPrompt(text);
    const characters =
      typeof handoff?.characters === 'number'
        ? handoff.characters
        : text.length;
    const estimatedTokens =
      handoff?.estimatedTokens ?? handoff?.budget?.estimatedTokens ?? null;
    const omittedItems =
      handoff?.omissions ??
      handoff?.omittedItems ??
      handoff?.budget?.omittedItems ??
      null;

    let isDuplicate = false;
    let identicalTo = null;

    if (seenHashes.has(sha256)) {
      isDuplicate = true;
      identicalTo = seenHashes.get(sha256);
    } else {
      seenHashes.set(sha256, budget);
    }

    results[budget] = {
      budget,
      maxTokens: budget,
      maxCharacters: 4 * budget,
      characters,
      estimatedTokens,
      omittedItems,
      sha256,
      isDuplicate,
      identicalTo,
    };
  }

  return results;
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

function compareArms(referenceArm, testArm) {
  if (!referenceArm || !testArm) return null;
  const refTokens = nonCachedTokens(referenceArm.metrics);
  const testTokens = nonCachedTokens(testArm.metrics);
  const timeReduction =
    referenceArm.wallTimeMs > 0
      ? (referenceArm.wallTimeMs - testArm.wallTimeMs) / referenceArm.wallTimeMs
      : null;
  const tokenReduction =
    refTokens !== null && refTokens > 0 && testTokens !== null
      ? (refTokens - testTokens) / refTokens
      : null;
  const testCorrect = testArm.evaluation?.combined?.passed ?? false;
  const delta = (getter) => {
    const valA = getter(referenceArm);
    const valB = getter(testArm);
    return valA !== null &&
      valA !== undefined &&
      valB !== null &&
      valB !== undefined
      ? valB - valA
      : null;
  };

  return {
    wallTimeDeltaMs: testArm.wallTimeMs - referenceArm.wallTimeMs,
    timeReduction,
    nonCachedTokenDelta:
      refTokens === null || testTokens === null ? null : testTokens - refTokens,
    tokenReduction,
    reachesTwentyPercent:
      testCorrect &&
      ((timeReduction !== null && timeReduction >= 0.2) ||
        (tokenReduction !== null && tokenReduction >= 0.2)),
    toolCallsDelta: delta((arm) => arm.metrics?.toolCalls),
    distinctFilesReadDelta: delta((arm) => arm.metrics?.distinctFilesRead),
    timeToFirstEditDeltaMs: delta((arm) => arm.metrics?.timeToFirstEditMs),
    turnsBeforeFirstEditDelta: delta(
      (arm) => arm.metrics?.turnsBeforeFirstEdit,
    ),
  };
}

export function nonAliasConditions(task) {
  if (Array.isArray(task.order) && task.order.length > 0) {
    return task.order.map((c) => task.conditions?.[c]).filter(Boolean);
  }
  return Object.entries(task.conditions ?? {})
    .filter(([name]) => {
      if (
        (name === 'handoff-with-notes' || name === 'treatment') &&
        task.conditions?.['handoff-300']
      ) {
        return false;
      }
      if (name === 'treatment' && task.conditions?.['handoff-with-notes']) {
        return false;
      }
      return true;
    })
    .map(([, condition]) => condition);
}

export function aggregateResults(taskResults) {
  const hasLegacyTreatment = taskResults.some(
    (task) =>
      task.conditions?.treatment !== undefined &&
      task.conditions?.['handoff-with-notes'] === undefined,
  );
  const hasNoNotes = taskResults.some(
    (task) => task.conditions?.['handoff-no-notes'] !== undefined,
  );
  const hasBudgetArms = taskResults.some(
    (task) =>
      task.conditions?.['handoff-300'] !== undefined ||
      task.conditions?.['handoff-800'] !== undefined ||
      task.conditions?.['handoff-2000'] !== undefined,
  );

  const pairs = taskResults.map((task) => {
    const baseline = task.conditions.baseline;
    const withNotes =
      task.conditions['handoff-with-notes'] ??
      task.conditions.treatment ??
      task.conditions?.['handoff-300'];
    const noNotes = task.conditions['handoff-no-notes'] ?? null;
    const handoff300 = task.conditions?.['handoff-300'] ?? withNotes;
    const handoff800 = task.conditions?.['handoff-800'] ?? null;
    const handoff2000 = task.conditions?.['handoff-2000'] ?? null;

    const baselineCorrect = baseline?.evaluation?.combined?.passed ?? false;
    const withNotesCorrect = withNotes?.evaluation?.combined?.passed ?? false;
    const noNotesCorrect = noNotes
      ? (noNotes.evaluation?.combined?.passed ?? false)
      : null;
    const handoff300Correct = handoff300?.evaluation?.combined?.passed ?? false;
    const handoff800Correct = handoff800
      ? (handoff800.evaluation?.combined?.passed ?? false)
      : null;
    const handoff2000Correct = handoff2000
      ? (handoff2000.evaluation?.combined?.passed ?? false)
      : null;

    const withNotesVsBaseline = compareArms(baseline, withNotes);
    const noNotesVsBaseline = noNotes ? compareArms(baseline, noNotes) : null;
    const withNotesVsNoNotes = noNotes ? compareArms(noNotes, withNotes) : null;

    const handoff300VsBaseline = compareArms(baseline, handoff300);
    const handoff800VsBaseline = handoff800
      ? compareArms(baseline, handoff800)
      : null;
    const handoff2000VsBaseline = handoff2000
      ? compareArms(baseline, handoff2000)
      : null;

    const handoff300VsNoNotes =
      noNotes && handoff300 ? compareArms(noNotes, handoff300) : null;
    const handoff800VsNoNotes =
      noNotes && handoff800 ? compareArms(noNotes, handoff800) : null;
    const handoff2000VsNoNotes =
      noNotes && handoff2000 ? compareArms(noNotes, handoff2000) : null;

    const handoff800VsHandoff300 =
      handoff300 && handoff800 ? compareArms(handoff300, handoff800) : null;
    const handoff2000VsHandoff300 =
      handoff300 && handoff2000 ? compareArms(handoff300, handoff2000) : null;
    const handoff2000VsHandoff800 =
      handoff800 && handoff2000 ? compareArms(handoff800, handoff2000) : null;

    const primaryComparison = withNotesVsBaseline ?? {};

    const correctness = {
      baseline: baselineCorrect,
      treatment: withNotesCorrect,
    };
    if (!hasLegacyTreatment) {
      correctness['handoff-with-notes'] = withNotesCorrect;
    }
    if (hasNoNotes) {
      correctness['handoff-no-notes'] = noNotesCorrect;
    }
    if (hasBudgetArms) {
      correctness['handoff-300'] = handoff300Correct;
      if (handoff800) {
        correctness['handoff-800'] = handoff800Correct;
      }
      if (handoff2000) {
        correctness['handoff-2000'] = handoff2000Correct;
      }
    }

    const pair = {
      taskId: task.taskId,
      order: task.order,
      correctness,
      wallTimeDeltaMs: primaryComparison.wallTimeDeltaMs ?? null,
      timeReduction: primaryComparison.timeReduction ?? null,
      nonCachedTokenDelta: primaryComparison.nonCachedTokenDelta ?? null,
      tokenReduction: primaryComparison.tokenReduction ?? null,
      reachesTwentyPercent: primaryComparison.reachesTwentyPercent ?? false,
      misleadingHandoffFailure: withNotesCorrect ? false : null,
      captureNotes: task.capture?.count ?? null,
      handoffTokens: task.handoff?.estimatedTokens ?? null,
      relayLeaks: nonAliasConditions(task).some((c) => c?.relayStateAccessed)
        ? 'yes'
        : 'no',
    };

    pair.comparisons = {
      withNotesVsBaseline,
      noNotesVsBaseline,
      withNotesVsNoNotes,
      ...(hasBudgetArms
        ? {
            handoff300VsBaseline,
            handoff800VsBaseline,
            handoff2000VsBaseline,
            handoff300VsNoNotes,
            handoff800VsNoNotes,
            handoff2000VsNoNotes,
            handoff800VsHandoff300,
            handoff2000VsHandoff300,
            handoff2000VsHandoff800,
            'handoff-300VsBaseline': handoff300VsBaseline,
            'handoff-800VsBaseline': handoff800VsBaseline,
            'handoff-2000VsBaseline': handoff2000VsBaseline,
            'handoff-300VsNoNotes': handoff300VsNoNotes,
            'handoff-800VsNoNotes': handoff800VsNoNotes,
            'handoff-2000VsNoNotes': handoff2000VsNoNotes,
            budgets: {
              300: {
                vsBaseline: handoff300VsBaseline,
                vsNoNotes: handoff300VsNoNotes,
              },
              800: {
                vsBaseline: handoff800VsBaseline,
                vsNoNotes: handoff800VsNoNotes,
                vsHandoff300: handoff800VsHandoff300,
              },
              2000: {
                vsBaseline: handoff2000VsBaseline,
                vsNoNotes: handoff2000VsNoNotes,
                vsHandoff300: handoff2000VsHandoff300,
                vsHandoff800: handoff2000VsHandoff800,
              },
            },
          }
        : {}),
    };

    if (hasBudgetArms) {
      pair.budgets = {
        300: {
          correct: handoff300Correct,
          wallTimeMs: handoff300?.wallTimeMs ?? null,
          nonCachedTokens: nonCachedTokens(handoff300?.metrics),
          skippedProviderCall: Boolean(handoff300?.skippedProviderCall),
          duplicateOf: handoff300?.duplicateOf ?? null,
          vsBaseline: handoff300VsBaseline,
          vsNoNotes: handoff300VsNoNotes,
        },
        800: handoff800
          ? {
              correct: handoff800Correct,
              wallTimeMs: handoff800.wallTimeMs ?? null,
              nonCachedTokens: nonCachedTokens(handoff800.metrics),
              skippedProviderCall: Boolean(handoff800.skippedProviderCall),
              duplicateOf: handoff800.duplicateOf ?? null,
              vsBaseline: handoff800VsBaseline,
              vsNoNotes: handoff800VsNoNotes,
              vsHandoff300: handoff800VsHandoff300,
            }
          : null,
        2000: handoff2000
          ? {
              correct: handoff2000Correct,
              wallTimeMs: handoff2000.wallTimeMs ?? null,
              nonCachedTokens: nonCachedTokens(handoff2000.metrics),
              skippedProviderCall: Boolean(handoff2000.skippedProviderCall),
              duplicateOf: handoff2000.duplicateOf ?? null,
              vsBaseline: handoff2000VsBaseline,
              vsNoNotes: handoff2000VsNoNotes,
              vsHandoff300: handoff2000VsHandoff300,
              vsHandoff800: handoff2000VsHandoff800,
            }
          : null,
      };
    }

    pair.exploration = {
      baseline: baseline?.metrics
        ? {
            toolCalls: baseline.metrics.toolCalls,
            distinctFilesRead: baseline.metrics.distinctFilesRead,
            timeToFirstEditMs: baseline.metrics.timeToFirstEditMs,
            turnsBeforeFirstEdit: baseline.metrics.turnsBeforeFirstEdit,
          }
        : null,
      'handoff-with-notes': withNotes?.metrics
        ? {
            toolCalls: withNotes.metrics.toolCalls,
            distinctFilesRead: withNotes.metrics.distinctFilesRead,
            timeToFirstEditMs: withNotes.metrics.timeToFirstEditMs,
            turnsBeforeFirstEdit: withNotes.metrics.turnsBeforeFirstEdit,
          }
        : null,
      'handoff-no-notes': noNotes?.metrics
        ? {
            toolCalls: noNotes.metrics.toolCalls,
            distinctFilesRead: noNotes.metrics.distinctFilesRead,
            timeToFirstEditMs: noNotes.metrics.timeToFirstEditMs,
            turnsBeforeFirstEdit: noNotes.metrics.turnsBeforeFirstEdit,
          }
        : null,
      ...(hasBudgetArms
        ? {
            'handoff-300': handoff300?.metrics
              ? {
                  toolCalls: handoff300.metrics.toolCalls,
                  distinctFilesRead: handoff300.metrics.distinctFilesRead,
                  timeToFirstEditMs: handoff300.metrics.timeToFirstEditMs,
                  turnsBeforeFirstEdit: handoff300.metrics.turnsBeforeFirstEdit,
                }
              : null,
            'handoff-800': handoff800?.metrics
              ? {
                  toolCalls: handoff800.metrics.toolCalls,
                  distinctFilesRead: handoff800.metrics.distinctFilesRead,
                  timeToFirstEditMs: handoff800.metrics.timeToFirstEditMs,
                  turnsBeforeFirstEdit: handoff800.metrics.turnsBeforeFirstEdit,
                }
              : null,
            'handoff-2000': handoff2000?.metrics
              ? {
                  toolCalls: handoff2000.metrics.toolCalls,
                  distinctFilesRead: handoff2000.metrics.distinctFilesRead,
                  timeToFirstEditMs: handoff2000.metrics.timeToFirstEditMs,
                  turnsBeforeFirstEdit:
                    handoff2000.metrics.turnsBeforeFirstEdit,
                }
              : null,
          }
        : {}),
    };

    return pair;
  });

  const values = (selector) =>
    pairs.map(selector).filter((value) => typeof value === 'number');

  const successCounts = {
    baseline: pairs.filter((pair) => pair.correctness.baseline).length,
  };
  if (hasLegacyTreatment) {
    successCounts.treatment = pairs.filter(
      (pair) => pair.correctness.treatment,
    ).length;
  } else {
    successCounts['handoff-with-notes'] = pairs.filter(
      (pair) =>
        pair.correctness['handoff-with-notes'] ?? pair.correctness.treatment,
    ).length;
    successCounts.treatment = successCounts['handoff-with-notes'];
  }
  if (hasNoNotes) {
    successCounts['handoff-no-notes'] = pairs.filter(
      (pair) => pair.correctness['handoff-no-notes'],
    ).length;
  }
  if (hasBudgetArms) {
    for (const budget of HANDOFF_BUDGETS) {
      const condName = `handoff-${budget}`;
      if (
        taskResults.some(
          (t) =>
            t.conditions?.[condName] !== undefined ||
            (budget === 300 &&
              (t.conditions?.['handoff-with-notes'] ||
                t.conditions?.treatment)),
        )
      ) {
        successCounts[condName] = pairs.filter(
          (pair) => pair.correctness[condName],
        ).length;
      }
    }
  }

  const improvedTasks = pairs.filter(
    (pair) => pair.reachesTwentyPercent,
  ).length;
  const correctnessMaintained = pairs.every(
    (pair) => pair.correctness.treatment,
  );
  const handoffFailureReviewClear = pairs.every(
    (pair) => pair.misleadingHandoffFailure === false,
  );

  const sumTokens = (arr) =>
    arr && arr.every((value) => value !== null)
      ? arr.reduce((total, value) => total + value, 0)
      : null;

  const baselineTokenTotals = taskResults.map((task) =>
    nonCachedTokens(task.conditions.baseline?.metrics),
  );
  const withNotesTokenTotals = taskResults.map((task) =>
    nonCachedTokens(
      (
        task.conditions['handoff-with-notes'] ??
        task.conditions.treatment ??
        task.conditions?.['handoff-300']
      )?.metrics,
    ),
  );
  const noNotesTokenTotals = hasNoNotes
    ? taskResults.map((task) =>
        nonCachedTokens(task.conditions['handoff-no-notes']?.metrics),
      )
    : null;

  const baselineWallTimeTotal = taskResults.reduce(
    (total, task) => total + (task.conditions.baseline?.wallTimeMs ?? 0),
    0,
  );
  const withNotesWallTimeTotal = taskResults.reduce(
    (total, task) =>
      total +
      ((
        task.conditions['handoff-with-notes'] ??
        task.conditions.treatment ??
        task.conditions?.['handoff-300']
      )?.wallTimeMs ?? 0),
    0,
  );
  const noNotesWallTimeTotal = hasNoNotes
    ? taskResults.reduce(
        (total, task) =>
          total + (task.conditions['handoff-no-notes']?.wallTimeMs ?? 0),
        0,
      )
    : null;

  const budgetWallTimeTotals = {};
  const budgetTokenTotals = {};
  if (hasBudgetArms) {
    for (const budget of HANDOFF_BUDGETS) {
      const condName = `handoff-${budget}`;
      budgetWallTimeTotals[condName] = taskResults.reduce((sum, task) => {
        const cond =
          task.conditions?.[condName] ??
          (budget === 300
            ? (task.conditions?.['handoff-with-notes'] ??
              task.conditions?.treatment)
            : null);
        return sum + (cond?.wallTimeMs ?? 0);
      }, 0);
      const tokenList = taskResults.map((task) => {
        const cond =
          task.conditions?.[condName] ??
          (budget === 300
            ? (task.conditions?.['handoff-with-notes'] ??
              task.conditions?.treatment)
            : null);
        return nonCachedTokens(cond?.metrics);
      });
      budgetTokenTotals[condName] = sumTokens(tokenList);
    }
  }

  const wallTimeTotals = {
    baseline: baselineWallTimeTotal,
    ...budgetWallTimeTotals,
  };
  if (hasLegacyTreatment) {
    wallTimeTotals.treatment = withNotesWallTimeTotal;
  } else {
    wallTimeTotals['handoff-with-notes'] = withNotesWallTimeTotal;
    wallTimeTotals.treatment = withNotesWallTimeTotal;
  }
  if (hasNoNotes) {
    wallTimeTotals['handoff-no-notes'] = noNotesWallTimeTotal;
  }
  wallTimeTotals.delta = withNotesWallTimeTotal - baselineWallTimeTotal;

  const nonCachedTokenTotals = {
    baseline: sumTokens(baselineTokenTotals),
    ...budgetTokenTotals,
  };
  if (hasLegacyTreatment) {
    nonCachedTokenTotals.treatment = sumTokens(withNotesTokenTotals);
  } else {
    nonCachedTokenTotals['handoff-with-notes'] =
      sumTokens(withNotesTokenTotals);
    nonCachedTokenTotals.treatment = sumTokens(withNotesTokenTotals);
  }
  if (hasNoNotes) {
    nonCachedTokenTotals['handoff-no-notes'] = sumTokens(noNotesTokenTotals);
  }

  const summarizeExplorationForArm = (armName) => {
    const list = taskResults
      .map((t) =>
        armName === 'handoff-with-notes'
          ? (t.conditions['handoff-with-notes'] ?? t.conditions.treatment)
          : (t.conditions?.[armName] ??
            (armName === 'handoff-300'
              ? (t.conditions?.['handoff-with-notes'] ??
                t.conditions?.treatment)
              : null)),
      )
      .filter(Boolean);
    const extractNums = (key) =>
      list
        .map((arm) => arm?.metrics?.[key])
        .filter((v) => typeof v === 'number');
    const toolVals = extractNums('toolCalls');
    const fileVals = extractNums('distinctFilesRead');
    const timeVals = extractNums('timeToFirstEditMs');
    const turnVals = extractNums('turnsBeforeFirstEdit');
    return {
      toolCalls: {
        mean: mean(toolVals),
        median: median(toolVals),
        total: toolVals.length > 0 ? toolVals.reduce((a, b) => a + b, 0) : null,
      },
      distinctFilesRead: {
        mean: mean(fileVals),
        median: median(fileVals),
      },
      timeToFirstEditMs: {
        mean: mean(timeVals),
        median: median(timeVals),
      },
      turnsBeforeFirstEdit: {
        mean: mean(turnVals),
        median: median(turnVals),
      },
    };
  };

  const summarizePairComparison = (key) => {
    const list = pairs.map((p) => p.comparisons?.[key]).filter(Boolean);
    if (list.length === 0) return null;
    const timeDeltas = list
      .map((c) => c.wallTimeDeltaMs)
      .filter((v) => typeof v === 'number');
    const tokenDeltas = list
      .map((c) => c.nonCachedTokenDelta)
      .filter((v) => typeof v === 'number');
    const improved = list.filter((c) => c.reachesTwentyPercent).length;
    return {
      wallTimeDeltaMs: { mean: mean(timeDeltas), median: median(timeDeltas) },
      nonCachedTokenDelta: {
        mean: mean(tokenDeltas),
        median: median(tokenDeltas),
      },
      improvedTasks: improved,
    };
  };

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
        wallTimeMs: wallTimeTotals,
        nonCachedTokens: nonCachedTokenTotals,
      },
      improvedTasks,
      comparisons: {
        withNotesVsBaseline: summarizePairComparison('withNotesVsBaseline'),
        noNotesVsBaseline: summarizePairComparison('noNotesVsBaseline'),
        withNotesVsNoNotes: summarizePairComparison('withNotesVsNoNotes'),
        ...(hasBudgetArms
          ? {
              handoff300VsBaseline: summarizePairComparison(
                'handoff300VsBaseline',
              ),
              handoff800VsBaseline: summarizePairComparison(
                'handoff800VsBaseline',
              ),
              handoff2000VsBaseline: summarizePairComparison(
                'handoff2000VsBaseline',
              ),
              handoff300VsNoNotes: summarizePairComparison(
                'handoff300VsNoNotes',
              ),
              handoff800VsNoNotes: summarizePairComparison(
                'handoff800VsNoNotes',
              ),
              handoff2000VsNoNotes: summarizePairComparison(
                'handoff2000VsNoNotes',
              ),
              handoff800VsHandoff300: summarizePairComparison(
                'handoff800VsHandoff300',
              ),
              handoff2000VsHandoff300: summarizePairComparison(
                'handoff2000VsHandoff300',
              ),
              handoff2000VsHandoff800: summarizePairComparison(
                'handoff2000VsHandoff800',
              ),
            }
          : {}),
      },
      exploration: {
        baseline: summarizeExplorationForArm('baseline'),
        'handoff-with-notes': summarizeExplorationForArm('handoff-with-notes'),
        ...(hasNoNotes
          ? {
              'handoff-no-notes':
                summarizeExplorationForArm('handoff-no-notes'),
            }
          : {}),
        ...(hasBudgetArms
          ? {
              'handoff-300': summarizeExplorationForArm('handoff-300'),
              'handoff-800': summarizeExplorationForArm('handoff-800'),
              'handoff-2000': summarizeExplorationForArm('handoff-2000'),
            }
          : {}),
      },
      ...(hasBudgetArms
        ? {
            budgets: {
              300: {
                successCount: successCounts['handoff-300'],
                wallTimeMs: wallTimeTotals['handoff-300'],
                nonCachedTokens: nonCachedTokenTotals['handoff-300'],
                vsBaseline: summarizePairComparison('handoff300VsBaseline'),
                vsNoNotes: summarizePairComparison('handoff300VsNoNotes'),
                exploration: summarizeExplorationForArm('handoff-300'),
              },
              800: {
                successCount: successCounts['handoff-800'],
                wallTimeMs: wallTimeTotals['handoff-800'],
                nonCachedTokens: nonCachedTokenTotals['handoff-800'],
                vsBaseline: summarizePairComparison('handoff800VsBaseline'),
                vsNoNotes: summarizePairComparison('handoff800VsNoNotes'),
                vsHandoff300: summarizePairComparison('handoff800VsHandoff300'),
                exploration: summarizeExplorationForArm('handoff-800'),
              },
              2000: {
                successCount: successCounts['handoff-2000'],
                wallTimeMs: wallTimeTotals['handoff-2000'],
                nonCachedTokens: nonCachedTokenTotals['handoff-2000'],
                vsBaseline: summarizePairComparison('handoff2000VsBaseline'),
                vsNoNotes: summarizePairComparison('handoff2000VsNoNotes'),
                vsHandoff300: summarizePairComparison(
                  'handoff2000VsHandoff300',
                ),
                vsHandoff800: summarizePairComparison(
                  'handoff2000VsHandoff800',
                ),
                exploration: summarizeExplorationForArm('handoff-2000'),
              },
            },
          }
        : {}),
      decisionRule: {
        text: 'Treatment must maintain correctness and reduce non-cached tokens or wall time by at least 20% on at least 3/5 tasks, with no misleading handoff-caused failure.',
        correctnessMaintained,
        handoffFailureReviewClear,
        passed:
          correctnessMaintained &&
          improvedTasks >= Math.ceil(pairs.length * 0.6) &&
          handoffFailureReviewClear,
      },
    },
  };
}

export async function analyzeResultFile(path) {
  const result = JSON.parse(await readFile(path, 'utf8'));
  return aggregateResults(result.tasks);
}
