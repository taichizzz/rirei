import path from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  parseThreadsIpcRequest,
  scopeThreadsIpcRequest,
} from '../../desktop/threads-ipc.mjs';

const project = path.resolve('/tmp/rirei-project');
const threadId = '11111111-1111-4111-8111-111111111111';
const messageId = '22222222-2222-4222-8222-222222222222';
const operationId = '33333333-3333-4333-8333-333333333333';

describe('desktop Threads IPC policy', () => {
  test('accepts only exact, bounded list and identity payloads', () => {
    expect(
      parseThreadsIpcRequest('list', { project, filter: ' review ' }),
    ).toEqual({ project, filter: 'review' });
    expect(
      parseThreadsIpcRequest('list', { project, filter: 'x'.repeat(201) }),
    ).toBeNull();
    expect(
      parseThreadsIpcRequest('thread', { project, threadId, extra: true }),
    ).toBeNull();
    expect(
      parseThreadsIpcRequest('read', { project, messageId: '../state.json' }),
    ).toBeNull();
  });

  test('bounds message bodies and rejects unsupported payload shapes', () => {
    const valid = {
      project,
      to: `run:${messageId}`,
      intent: 'request',
      delivery: 'inbox',
      text: 'Please review the patch.',
      redact: true,
      operationId,
    };
    expect(parseThreadsIpcRequest('send', valid)).toMatchObject(valid);
    expect(
      parseThreadsIpcRequest('send', { ...valid, text: 'a'.repeat(5000) }),
    ).not.toBeNull();
    expect(
      parseThreadsIpcRequest('send', { ...valid, text: '🙂'.repeat(2050) }),
    ).toBeNull();
    expect(
      parseThreadsIpcRequest('send', {
        ...valid,
        contextNotes: [messageId, messageId, messageId],
        contextCheckpoints: ['checkpoint-1'],
      }),
    ).toBeNull();
    expect(
      parseThreadsIpcRequest('send', { ...valid, operationId: 'retry' }),
    ).toBeNull();
    expect(
      parseThreadsIpcRequest('send', { ...valid, text: 'unsafe\u001b[31m' }),
    ).toBeNull();
    expect(
      parseThreadsIpcRequest('send', { ...valid, inherited: 'value' }),
    ).toBeNull();
  });

  test('scopes requests to the canonical active repository root', () => {
    const child = path.join(project, 'packages', 'desktop');
    const resolveRoot = (value: string) =>
      value === child || value === project
        ? project
        : path.resolve('/tmp/other');
    expect(
      scopeThreadsIpcRequest(
        'thread',
        { project: child, threadId },
        project,
        resolveRoot,
      ),
    ).toMatchObject({ project: child, projectRoot: project, threadId });
    expect(
      scopeThreadsIpcRequest(
        'thread',
        { project: path.resolve('/tmp/other'), threadId },
        project,
        resolveRoot,
      ),
    ).toBeNull();
    expect(
      scopeThreadsIpcRequest(
        'thread',
        { project, threadId },
        undefined,
        resolveRoot,
      ),
    ).toBeNull();
  });
});
