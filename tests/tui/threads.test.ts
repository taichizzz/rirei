import { describe, expect, it } from 'vitest';
import type { ThreadsJournal } from '../../src/messages/schema.js';
import {
  buildThreadsData,
  canActOnReceipt,
  filterThreadSummaries,
  parseCanonicalActorRef,
  receiptLabel,
} from '../../src/tui/threads.js';

const threadId = '11111111-1111-4111-8111-111111111111';
const messageId = '22222222-2222-4222-8222-222222222222';
const journal: ThreadsJournal = {
  schemaVersion: 1,
  sessionId: 'session-1',
  revision: 2,
  nextSequence: 3,
  recentOperations: [],
  messages: [
    {
      id: threadId,
      sequence: 1,
      threadId,
      from: { kind: 'operator' },
      to: { kind: 'run', runId: 'worker-1' },
      intent: 'request',
      body: 'Review the state model.',
      contextCards: [],
      deliveryMode: 'inbox',
      createdAt: '2026-08-30T12:00:00.000Z',
      delivery: { state: 'delivered', attemptCount: 1 },
      redactions: [],
    },
    {
      id: messageId,
      sequence: 2,
      threadId,
      replyToId: threadId,
      from: { kind: 'run', runId: 'worker-1' },
      to: { kind: 'operator' },
      intent: 'inform',
      body: 'State model review is complete.',
      contextCards: [],
      deliveryMode: 'inbox',
      createdAt: '2026-08-30T12:01:00.000Z',
      delivery: {
        state: 'acknowledged',
        attemptCount: 1,
        deliveredAt: '2026-08-30T12:01:01.000Z',
        readAt: '2026-08-30T12:02:00.000Z',
        acknowledgedAt: '2026-08-30T12:03:00.000Z',
      },
      redactions: [],
    },
  ],
};

describe('TUI thread model', () => {
  it('builds canonical inbox-only peers and attention counts', () => {
    const data = buildThreadsData({
      journal: {
        ...journal,
        messages: [
          journal.messages[0]!,
          {
            ...journal.messages[1]!,
            delivery: { state: 'delivered', attemptCount: 1 },
          },
        ],
      },
      actor: { kind: 'operator' },
      peerRuns: [{ runId: 'worker-1', agent: 'claude' }],
    });

    expect(data.actorRef).toBe('operator');
    expect(data.unreadCount).toBe(1);
    expect(data.peers).toEqual([
      {
        actor: { kind: 'run', runId: 'worker-1' },
        ref: 'run:worker-1',
        agent: 'claude',
        deliveryModes: ['inbox'],
      },
    ]);
    expect(data.messages).toHaveLength(2);
  });

  it('requires canonical actor refs', () => {
    expect(parseCanonicalActorRef('operator')).toEqual({ kind: 'operator' });
    expect(parseCanonicalActorRef('run:worker-1')).toEqual({
      kind: 'run',
      runId: 'worker-1',
    });
    expect(() => parseCanonicalActorRef('Claude 1')).toThrow('canonical ref');
    expect(() => parseCanonicalActorRef('worker-1')).toThrow('canonical ref');
  });

  it('filters by content and canonical participant while respecting unread', () => {
    const data = buildThreadsData({
      journal,
      actor: { kind: 'operator' },
      peerRuns: [{ runId: 'worker-1' }],
    });

    expect(
      filterThreadSummaries(data.summaries, 'complete', false),
    ).toHaveLength(1);
    expect(
      filterThreadSummaries(data.summaries, 'run:worker-1', false),
    ).toHaveLength(1);
    expect(filterThreadSummaries(data.summaries, '', true)).toHaveLength(0);
  });

  it('models recipient actions and the most advanced receipt', () => {
    const message = journal.messages[1]!;
    expect(canActOnReceipt(message, { kind: 'operator' })).toBe(true);
    expect(canActOnReceipt(message, { kind: 'run', runId: 'worker-1' })).toBe(
      false,
    );
    expect(receiptLabel(message)).toBe('ACK 2026-08-30T12:03:00.000Z');
  });
});
