import { stripVTControlCharacters } from 'node:util';
import { redactSecrets } from '../safety/redaction.js';
import {
  CONTEXT_TEXT_LIMIT,
  contextObservationSchema,
  type ContextObservation,
} from './schema.js';

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const string = (value: unknown) => (typeof value === 'string' ? value : '');

/** Visible exec JSON only. Reasoning, encrypted content, and unknown records are excluded. */
export function normalizeCodexExec(
  payload: unknown,
  expected: { providerSessionId: string },
): ContextObservation[] {
  const record = object(payload);
  const type = string(record.type);
  if (
    type === 'thread.started' &&
    record.thread_id !== expected.providerSessionId
  )
    throw new Error('Codex thread does not match its capture grant.');
  const item = object(record.item);
  const id = string(item.id);
  let kind: ContextObservation['kind'];
  let text = '';
  let command: string | undefined;
  let filePath: string | undefined;
  let toolName: string | undefined;
  let outcome: ContextObservation['outcome'];
  let exitCode: number | null | undefined;
  if (type === 'thread.started') {
    kind = 'session_start';
    text = 'Codex exec reported thread start.';
  } else if (type === 'turn.completed') {
    kind = 'turn_end';
    text = 'Codex exec reported turn completion.';
  } else if (
    ['item.started', 'item.completed'].includes(type) &&
    ['command_execution', 'file_change'].includes(string(item.type))
  ) {
    if (!id) throw new Error('Codex tool item has no source identity.');
    kind = type === 'item.started' ? 'tool_start' : 'tool_result';
    toolName =
      item.type === 'file_change' ? 'apply_patch' : 'command_execution';
    command = string(item.command) || undefined;
    if (item.type === 'file_change') {
      const changes = Array.isArray(item.changes)
        ? item.changes.map(object)
        : [];
      filePath =
        changes
          .map((change) => string(change.path))
          .filter(Boolean)
          .join(', ') || undefined;
      text = filePath
        ? `Reported file changes: ${filePath}`
        : 'File change reported without retained paths.';
    } else {
      text =
        kind === 'tool_start'
          ? 'Command requested; completion not yet observed.'
          : string(item.aggregated_output) ||
            'Command completed without retained output.';
      if (kind === 'tool_result')
        exitCode = Number.isSafeInteger(item.exit_code)
          ? (item.exit_code as number)
          : null;
    }
    if (kind === 'tool_result')
      outcome =
        item.status === 'failed' ||
        (typeof exitCode === 'number' && exitCode !== 0)
          ? 'reported_failure'
          : 'reported_success';
  } else if (type === 'item.completed' && item.type === 'agent_message') {
    kind = 'assistant_claim';
    text = string(item.text);
  } else {
    return [];
  }
  let redacted = false;
  let truncated = false;
  const sanitize = (value: string) => {
    const cleaned = redactSecrets(
      stripVTControlCharacters(value).replace(/\r\n/g, '\n'),
    );
    redacted ||= cleaned.redactions.length > 0;
    truncated ||= cleaned.redactedText.length > CONTEXT_TEXT_LIMIT;
    let result = cleaned.redactedText.slice(0, CONTEXT_TEXT_LIMIT);
    const last = result.charCodeAt(result.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) result = result.slice(0, -1);
    return result;
  };
  return [
    contextObservationSchema.parse({
      kind,
      provider: 'codex',
      providerSessionId: expected.providerSessionId,
      hook: `exec.${type}`,
      sourceId: id ? `${type}:${id}` : undefined,
      toolId: toolName ? id : undefined,
      toolName,
      command: command ? sanitize(command) : undefined,
      filePath: filePath ? sanitize(filePath) : undefined,
      text: sanitize(text),
      outcome,
      exitCode,
      redacted,
      truncated,
    }),
  ];
}
