import { createHash } from 'node:crypto';
import {
  parseJsonLines,
  parseProviderMetrics,
  nonCachedTokens,
} from '../handoff/lib.mjs';

const digest = (value) => createHash('sha256').update(value).digest('hex');
const text = (value) =>
  typeof value === 'string' ? value : JSON.stringify(value ?? '');
const number = (object, key) =>
  Number.isFinite(object?.[key]) ? object[key] : null;

/** Keeps counters and bounded tool metadata; never retains message/command output bodies. */
export class ProviderMeasurement {
  constructor(provider, { maxTools = 4096 } = {}) {
    if (!['claude', 'codex'].includes(provider))
      throw new Error('Unsupported measured provider.');
    this.provider = provider;
    this.maxTools = maxTools;
    this.tools = new Map();
    this.toolIds = new Set();
    this.toolShapeSeen = false;
    this.turnShapeSeen = false;
    this.modelTurns = 0;
    this.usageCount = 0;
    this.sums = Object.fromEntries(
      [
        'inputTokens',
        'cachedInputTokens',
        'outputTokens',
        'reasoningTokens',
      ].map((key) => [key, { count: 0, total: 0 }]),
    );
    this.firstEventMs = null;
    this.lastEventMs = null;
    this.firstToolMs = null;
    this.firstEditMs = null;
    this.firstEditSeen = false;
    this.turnsBeforeFirstEdit = null;
    this.anonymousTools = false;
    this.final = null;
    this.actualModel = null;
    this.providerError = false;
    this.omittedTools = 0;
    this.recordSeen = false;
    this.seenPhases = new Set();
  }

  observe(record, elapsedMs = record._rirei?.elapsedMs ?? null) {
    this.recordSeen = true;
    if (this.firstEventMs === null && Number.isFinite(elapsedMs))
      this.firstEventMs = elapsedMs;
    if (Number.isFinite(elapsedMs)) this.lastEventMs = elapsedMs;
    if (record.type === 'system' && record.subtype === 'init')
      this.actualModel = record.model ?? null;
    if (record.type === 'result')
      this.final = {
        usage: record.usage,
        num_turns: record.num_turns,
        total_cost_usd: record.total_cost_usd,
        is_error: record.is_error,
      };
    if (['error', 'turn.failed'].includes(record.type))
      this.providerError = true;
    if (this.provider === 'codex') {
      if (record.type === 'turn.started' || record.type === 'turn.completed')
        this.turnShapeSeen = true;
      if (record.type === 'turn.completed') {
        this.modelTurns++;
        const metrics = parseProviderMetrics('codex', JSON.stringify(record));
        if (
          ['inputTokens', 'cachedInputTokens', 'outputTokens'].some(
            (key) => metrics[key] !== null,
          )
        ) {
          this.usageCount++;
          for (const key of Object.keys(this.sums))
            if (metrics[key] !== null) {
              this.sums[key].count++;
              this.sums[key].total += metrics[key];
            }
        } else if (metrics.reasoningTokens !== null) {
          this.sums.reasoningTokens.count++;
          this.sums.reasoningTokens.total += metrics.reasoningTokens;
        }
      }
      const item = record.item;
      if (
        ['item.started', 'item.completed'].includes(record.type) &&
        item?.type
      ) {
        this.toolShapeSeen = true;
        if (
          ['command_execution', 'file_change', 'mcp_tool_call'].includes(
            item.type,
          )
        ) {
          const phase = record.type === 'item.started' ? 'start' : 'end';
          this.tool(
            item.id,
            phase,
            {
              name: item.type,
              file: item.changes
                ?.map((change) => change.path)
                .filter(Boolean)
                .join(', '),
              input: item.command ?? item.changes,
              output: item.aggregated_output,
              exitCode: Number.isInteger(item.exit_code)
                ? item.exit_code
                : null,
              reportedFailure: item.status === 'failed',
              edit: item.type === 'file_change',
            },
            elapsedMs,
          );
        }
      }
    } else if (
      record.type === 'assistant' &&
      Array.isArray(record.message?.content)
    ) {
      for (const block of record.message.content.filter(
        (block) => block.type === 'tool_use',
      ))
        this.tool(
          block.id,
          'start',
          {
            name: block.name,
            file: block.input?.file_path,
            input: block.input,
            edit: ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(
              block.name,
            ),
          },
          elapsedMs,
        );
    } else if (
      record.type === 'user' &&
      Array.isArray(record.message?.content)
    ) {
      for (const block of record.message.content.filter(
        (block) => block.type === 'tool_result',
      ))
        this.tool(
          block.tool_use_id,
          'end',
          {
            output: block.content,
            reportedFailure: block.is_error === true,
            exitCode: ['Bash', 'PowerShell'].includes(
              this.tools.get(block.tool_use_id)?.name,
            )
              ? (number(record.tool_use_result, 'exit_code') ??
                number(record.tool_use_result, 'exitCode'))
              : null,
          },
          elapsedMs,
        );
    }
  }

  tool(id, phase, value, elapsedMs) {
    // Stable IDs support deduplication; anonymous calls cannot be reconstructed reliably.
    if (typeof id !== 'string' || !id) {
      this.anonymousTools = true;
      return;
    }
    const phaseId = `${phase}:${id}`;
    if (this.seenPhases.has(phaseId)) return;
    if (!this.tools.has(id) && this.tools.size >= this.maxTools) {
      this.omittedTools++;
      return;
    }
    this.seenPhases.add(phaseId);
    let tool = this.tools.get(id);
    if (!tool) {
      tool = {
        id,
        name: null,
        file: null,
        startedMs: null,
        completedMs: null,
        outputBytes: null,
        outputDigest: null,
        inputDigest: null,
        exitCode: null,
        reportedFailure: false,
      };
      this.tools.set(id, tool);
    }
    if (phase === 'start') {
      this.toolIds.add(id);
      tool.name = value.name;
      tool.file = value.file ?? null;
      tool.inputDigest = digest(text(value.input));
      tool.startedMs = elapsedMs;
      if (this.firstToolMs === null && Number.isFinite(elapsedMs))
        this.firstToolMs = elapsedMs;
      if (value.edit && !this.firstEditSeen) {
        this.firstEditSeen = true;
        this.firstEditMs = Number.isFinite(elapsedMs) ? elapsedMs : null;
        this.turnsBeforeFirstEdit = this.turnShapeSeen ? this.modelTurns : null;
      }
    } else {
      tool.name ??= value.name ?? null;
      tool.file ??= value.file ?? null;
      tool.completedMs = elapsedMs;
      tool.exitCode = value.exitCode;
      tool.reportedFailure = value.reportedFailure;
      if (value.output !== undefined) {
        const output = text(value.output);
        tool.outputBytes = Buffer.byteLength(output);
        tool.outputDigest = digest(output);
      }
    }
  }

  metrics() {
    if (this.provider === 'claude') {
      const usage = this.final?.usage;
      const input = number(usage, 'input_tokens');
      const cached = number(usage, 'cache_read_input_tokens');
      const created = number(usage, 'cache_creation_input_tokens');
      const output = number(usage, 'output_tokens');
      const complete = [input, cached, created, output].every(
        (value) => value !== null,
      );
      return {
        inputTokens: complete ? input + cached + created : null,
        cachedInputTokens: cached,
        cacheCreationInputTokens: created,
        outputTokens: output,
        reasoningTokens: null,
        nonCachedTokens: complete ? input + created + output : null,
        toolCalls:
          !this.recordSeen || this.omittedTools || this.anonymousTools
            ? null
            : this.toolIds.size,
        modelTurns: this.final?.num_turns ?? null,
        usageCompleteness: usage ? 'final-result-counters' : 'unknown',
        actualModel: this.actualModel,
        providerEstimatedCostUsd: this.final?.total_cost_usd ?? null,
      };
    }
    const complete = (key) =>
      this.usageCount && this.sums[key].count === this.usageCount
        ? this.sums[key].total
        : null;
    const result = {
      inputTokens: complete('inputTokens'),
      cachedInputTokens: complete('cachedInputTokens'),
      outputTokens: complete('outputTokens'),
      reasoningTokens: this.sums.reasoningTokens.count
        ? this.sums.reasoningTokens.total
        : null,
      modelTurns: this.turnShapeSeen ? this.modelTurns : null,
      toolCalls:
        this.omittedTools || this.anonymousTools
          ? null
          : this.toolShapeSeen
            ? this.toolIds.size
            : null,
      distinctFilesRead: null,
      timeToFirstEditMs: null,
      turnsBeforeFirstEdit: this.turnsBeforeFirstEdit,
    };
    return {
      ...result,
      nonCachedTokens: nonCachedTokens(result),
      usageCompleteness:
        result.inputTokens === null ? 'unknown' : 'final-turn-counters',
      actualModel: null,
    };
  }

  timeline() {
    return {
      clock: 'host-monotonic-receipt',
      firstVisibleEventMs: this.firstEventMs,
      lastVisibleEventMs: this.lastEventMs,
      firstToolRequestedMs: this.firstToolMs,
      firstEditRequestedMs: this.firstEditMs,
      firstUsefulActionMs: null,
      redundantWork: null,
      omittedTools: this.omittedTools,
      tools: [...this.tools.values()].map((tool) => ({
        ...tool,
        observedDurationMs:
          Number.isFinite(tool.startedMs) &&
          Number.isFinite(tool.completedMs) &&
          tool.completedMs >= tool.startedMs
            ? tool.completedMs - tool.startedMs
            : null,
      })),
    };
  }
}

export function measuredProviderMetrics(provider, text) {
  const measurement = new ProviderMeasurement(provider);
  for (const record of parseJsonLines(text)) measurement.observe(record);
  return measurement.metrics();
}
