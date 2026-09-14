import { describe, expect, it } from 'vitest';
import {
  contextCardsSchema,
  relayMessageSchema,
  threadsJournalSchema,
  LATEST_THREADS_SCHEMA,
  THREADS_MAX_BODY_BYTES,
  THREADS_MAX_CARDS_BYTES,
  THREADS_MAX_JOURNAL_BYTES,
  THREADS_MAX_PAYLOAD_BYTES,
  THREADS_MESSAGE_LIMIT,
  THREADS_THREAD_LIMIT,
  type RelayMessage,
} from '../../src/messages/schema.js';

const now = '2026-01-01T00:00:00.000Z';

function message(body = 'Valid message'): RelayMessage {
  const id = '11111111-1111-4111-8111-111111111111';
  return {
    id,
    sequence: 1,
    threadId: id,
    from: { kind: 'operator' },
    to: { kind: 'run', runId: 'run-1' },
    intent: 'request',
    body,
    contextCards: [],
    deliveryMode: 'inbox',
    createdAt: now,
    delivery: { state: 'queued', attemptCount: 0 },
    redactions: [],
  };
}

describe('threads schemas', () => {
  it('validates valid message and journal schemas', () => {
    const msgId = '11111111-1111-4111-8111-111111111111';
    const now = '2026-01-01T00:00:00.000Z';
    const msg: RelayMessage = {
      id: msgId,
      sequence: 1,
      threadId: msgId,
      from: { kind: 'operator' },
      to: { kind: 'run', runId: 'run-1' },
      intent: 'request',
      body: 'Please implement the new feature.',
      contextCards: [],
      deliveryMode: 'inbox',
      createdAt: now,
      delivery: {
        state: 'queued',
        attemptCount: 0,
      },
      redactions: [],
    };

    expect(() => relayMessageSchema.parse(msg)).not.toThrow();

    const journal = {
      schemaVersion: LATEST_THREADS_SCHEMA,
      sessionId: 'session-1',
      revision: 1,
      nextSequence: 2,
      recentOperations: [],
      messages: [msg],
    };

    expect(() => threadsJournalSchema.parse(journal)).not.toThrow();
  });

  it('rejects messages with invalid actors or body lengths', () => {
    const now = '2026-01-01T00:00:00.000Z';
    const invalidMsg = {
      id: 'invalid-uuid',
      sequence: 1,
      threadId: 'invalid-uuid',
      from: { kind: 'unknown' },
      to: { kind: 'run', runId: '' },
      intent: 'request',
      body: '',
      contextCards: [],
      deliveryMode: 'inbox',
      createdAt: now,
      delivery: {
        state: 'queued',
        attemptCount: 0,
      },
      redactions: [],
    };

    expect(() => relayMessageSchema.parse(invalidMsg)).toThrow();
  });

  it('enforces UTF-8 byte limits and rejects unsafe controls', () => {
    expect(() =>
      relayMessageSchema.parse(message('a'.repeat(THREADS_MAX_BODY_BYTES))),
    ).not.toThrow();
    expect(() =>
      relayMessageSchema.parse(message('a'.repeat(THREADS_MAX_BODY_BYTES + 1))),
    ).toThrow(/UTF-8 bytes/);
    expect(() =>
      relayMessageSchema.parse(message('😀'.repeat(2048))),
    ).not.toThrow();
    expect(() => relayMessageSchema.parse(message('😀'.repeat(2049)))).toThrow(
      /UTF-8 bytes/,
    );
    expect(() => relayMessageSchema.parse(message('unsafe\u001b[2J'))).toThrow(
      /control/i,
    );
    expect(() =>
      relayMessageSchema.parse({
        ...message(),
        from: { kind: 'run', runId: 'run\nspoof' },
      }),
    ).toThrow(/control/i);
    expect(() =>
      relayMessageSchema.parse({ ...message(), unexpected: true }),
    ).toThrow();
  });

  it('enforces combined card and configured aggregate limits', () => {
    const card = (sourceId: string, text: string) => ({
      kind: 'note' as const,
      sourceId,
      title: 'Context',
      text,
      capturedAt: now,
    });
    expect(() =>
      contextCardsSchema.parse([
        card('one', 'a'.repeat(8000)),
        card('two', 'b'.repeat(8000)),
      ]),
    ).not.toThrow();
    expect(() =>
      contextCardsSchema.parse([
        card('one', 'a'.repeat(8100)),
        card('two', 'b'.repeat(8100)),
      ]),
    ).toThrow(/Combined context cards/);

    expect(THREADS_THREAD_LIMIT).toBe(100);
    expect(THREADS_MESSAGE_LIMIT).toBe(1000);
    expect(THREADS_MAX_CARDS_BYTES).toBe(16 * 1024);
    expect(THREADS_MAX_PAYLOAD_BYTES).toBe(32 * 1024);
    expect(THREADS_MAX_JOURNAL_BYTES).toBe(5 * 1024 * 1024);
  });

  it('rejects duplicate sequences, broken replies, and excess threads', () => {
    const root = message();
    const duplicate = {
      ...message('Second'),
      id: '22222222-2222-4222-8222-222222222222',
      threadId: '22222222-2222-4222-8222-222222222222',
    };
    expect(() =>
      threadsJournalSchema.parse({
        schemaVersion: LATEST_THREADS_SCHEMA,
        sessionId: 'session-1',
        revision: 1,
        nextSequence: 2,
        recentOperations: [],
        messages: [root, duplicate],
      }),
    ).toThrow(/sequences/);

    const roots = Array.from({ length: 101 }, (_, index) => {
      const suffix = index.toString(16).padStart(12, '0');
      const id = `11111111-1111-4111-8111-${suffix}`;
      return {
        ...message(`Root ${index}`),
        id,
        threadId: id,
        sequence: index + 1,
      };
    });
    expect(() =>
      threadsJournalSchema.parse({
        schemaVersion: LATEST_THREADS_SCHEMA,
        sessionId: 'session-1',
        revision: 1,
        nextSequence: 102,
        recentOperations: [],
        messages: roots,
      }),
    ).toThrow(/thread limit/);
  });
});
