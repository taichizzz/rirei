import path from 'node:path';
import { createHash } from 'node:crypto';
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
const string = (value: unknown): string =>
  typeof value === 'string' ? value : '';

/** Only allow-listed visible hook fields enter memory; transcript paths are never read. */
export function normalizeClaudeHook(
  payload: unknown,
  expected: {
    workspace: string;
    providerSessionId?: string;
    launchPromptHash?: string;
  },
): ContextObservation {
  const input = object(payload);
  const session = string(input.session_id);
  if (
    !session ||
    (expected.providerSessionId && session !== expected.providerSessionId)
  )
    throw new Error('Context hook session does not match its capture grant.');
  const relative = path.relative(
    path.resolve(expected.workspace),
    path.resolve(string(input.cwd)),
  );
  if (
    !path.isAbsolute(string(input.cwd)) ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  )
    throw new Error('Context hook workspace does not match its capture grant.');
  const hook = string(input.hook_event_name);
  const tool = object(input.tool_input);
  const response = object(input.tool_response);
  const toolId = string(input.tool_use_id) || undefined;
  let kind: ContextObservation['kind'];
  let text = '';
  let outcome: ContextObservation['outcome'];
  let exitCode: number | null | undefined;
  let command: string | undefined;
  let filePath: string | undefined;
  switch (hook) {
    case 'SessionStart':
      kind = 'session_start';
      text = `Provider reported session start (${string(input.source) || 'unknown mode'}).`;
      break;
    case 'UserPromptSubmit':
      kind = 'prompt_submission';
      text = string(input.prompt);
      if (!text) throw new Error('Context prompt hook has no submitted text.');
      if (
        expected.launchPromptHash ===
        createHash('sha256').update(text).digest('hex')
      )
        kind = 'launch_prompt';
      break;
    case 'PreToolUse':
    case 'PostToolUse':
    case 'PostToolUseFailure': {
      kind = hook === 'PreToolUse' ? 'tool_start' : 'tool_result';
      command = string(tool.command) || undefined;
      filePath = string(tool.file_path) || undefined;
      if (!toolId || !string(input.tool_name))
        throw new Error('Context tool hook is missing its tool identity.');
      if (kind === 'tool_start') {
        text =
          string(tool.file_path) ||
          'Tool requested; completion not yet observed.';
      } else {
        outcome =
          hook === 'PostToolUseFailure'
            ? 'reported_failure'
            : 'reported_success';
        const reportedExit = response.exit_code ?? response.exitCode;
        exitCode =
          command && Number.isSafeInteger(reportedExit)
            ? (reportedExit as number)
            : null;
        text =
          hook === 'PostToolUseFailure'
            ? string(input.error)
            : [
                string(response.stdout),
                string(response.stderr),
                string(input.tool_response),
              ]
                .filter(Boolean)
                .join('\n');
        text ||= 'Provider reported a tool result without retained output.';
      }
      break;
    }
    case 'Stop':
      text = string(input.last_assistant_message);
      kind = text ? 'assistant_claim' : 'turn_end';
      text ||= 'Provider reported turn end without assistant text.';
      break;
    case 'SessionEnd':
      kind = 'session_end';
      text = `Provider reported session end (${string(input.reason) || 'unknown reason'}).`;
      break;
    default:
      kind = 'coverage_gap';
      text = 'A hook outside the supported capture contract was received.';
  }
  let redacted = false;
  let truncated = false;
  const sanitize = (value: string): string => {
    const cleaned = redactSecrets(
      stripVTControlCharacters(value).replace(/\r\n/g, '\n'),
    );
    redacted ||= cleaned.redactions.length > 0;
    truncated ||= cleaned.redactedText.length > CONTEXT_TEXT_LIMIT;
    let limited = cleaned.redactedText.slice(0, CONTEXT_TEXT_LIMIT);
    const last = limited.charCodeAt(limited.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) limited = limited.slice(0, -1);
    return limited;
  };
  text = sanitize(text);
  if (command) command = sanitize(command);
  if (filePath) filePath = sanitize(filePath);
  return contextObservationSchema.parse({
    kind,
    provider: 'claude',
    providerSessionId: session,
    hook,
    // Prompt hooks have no stable message ID. Identical prompt text may be intentional.
    sourceId: toolId ? `${hook}:${toolId}` : undefined,
    toolId,
    toolName: string(input.tool_name) || undefined,
    command,
    filePath,
    text,
    outcome,
    exitCode,
    redacted,
    truncated,
  });
}
