import { describe, expect, it } from 'vitest';
import { normalizeCodexExec } from '../../src/context/codex.js';

const session = { providerSessionId: 'thread-1' };
describe('visible Codex exec capture', () => {
  it('ignores reasoning, hidden fields, and unsupported event types', () => {
    expect(
      normalizeCodexExec(
        {
          type: 'item.completed',
          item: { type: 'reasoning', text: 'private' },
        },
        session,
      ),
    ).toEqual([]);
    const result = normalizeCodexExec(
      {
        type: 'item.completed',
        item: {
          id: 'a',
          type: 'agent_message',
          text: 'Tests passed.',
          thinking: 'private',
        },
      },
      session,
    );
    expect(result[0]).toMatchObject({
      provider: 'codex',
      kind: 'assistant_claim',
      text: 'Tests passed.',
    });
    expect(JSON.stringify(result)).not.toContain('private');
  });
  it('preserves failed command exits and matches start/result identities', () => {
    const item = { id: 'cmd', type: 'command_execution', command: 'npm test' };
    const start = normalizeCodexExec(
      { type: 'item.started', item },
      session,
    )[0];
    const end = normalizeCodexExec(
      {
        type: 'item.completed',
        item: {
          ...item,
          status: 'completed',
          exit_code: 1,
          aggregated_output: 'Assertion failed',
        },
      },
      session,
    )[0];
    expect(start).toMatchObject({ kind: 'tool_start', toolId: 'cmd' });
    expect(end).toMatchObject({
      kind: 'tool_result',
      toolId: 'cmd',
      exitCode: 1,
      outcome: 'reported_failure',
    });
  });
  it('retains file-change paths without inventing a test result', () => {
    const [value] = normalizeCodexExec(
      {
        type: 'item.completed',
        item: {
          id: 'patch',
          type: 'file_change',
          status: 'completed',
          changes: [
            { path: 'src/feed.mjs', kind: 'update', diff: 'not retained' },
          ],
        },
      },
      session,
    );
    expect(value).toMatchObject({
      toolName: 'apply_patch',
      filePath: 'src/feed.mjs',
      outcome: 'reported_success',
    });
    expect(value?.exitCode).toBeUndefined();
    expect(JSON.stringify(value)).not.toContain('not retained');
  });
  it('validates thread binding and bounds/redacts retained text', () => {
    expect(() =>
      normalizeCodexExec(
        { type: 'thread.started', thread_id: 'other' },
        session,
      ),
    ).toThrow('thread');
    const [value] = normalizeCodexExec(
      {
        type: 'item.completed',
        item: {
          id: 'text',
          type: 'agent_message',
          text: `sk-ant-${'x'.repeat(40)} ${'😀'.repeat(16000)}`,
        },
      },
      session,
    );
    expect(value?.redacted).toBe(true);
    expect(value?.truncated).toBe(true);
    expect(value?.text.isWellFormed()).toBe(true);
    expect(value?.text.length).toBeLessThanOrEqual(16000);
  });
});
