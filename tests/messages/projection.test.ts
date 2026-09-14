import { describe, expect, it } from 'vitest';
import {
  countUnreadMessages,
  summarizeThreads,
} from '../../src/messages/projection.js';
import {
  LATEST_THREADS_SCHEMA,
  type ThreadsJournal,
} from '../../src/messages/schema.js';

describe('threads projection', () => {
  it('summarizes threads with unread counts and excerpts', () => {
    const threadId = '11111111-1111-4111-8111-111111111111';
    const journal: ThreadsJournal = {
      schemaVersion: LATEST_THREADS_SCHEMA,
      sessionId: 'session-1',
      revision: 1,
      nextSequence: 3,
      recentOperations: [],
      messages: [
        {
          id: threadId,
          sequence: 1,
          threadId,
          from: { kind: 'operator' },
          to: { kind: 'run', runId: 'run-claude' },
          intent: 'request',
          body: 'Initial task description for Claude.',
          contextCards: [],
          deliveryMode: 'inbox',
          createdAt: '2026-01-01T00:00:00.000Z',
          delivery: { state: 'queued', attemptCount: 0 },
          redactions: [],
        },
        {
          id: '22222222-2222-4222-8222-222222222222',
          sequence: 2,
          threadId,
          replyToId: threadId,
          from: { kind: 'run', runId: 'run-claude' },
          to: { kind: 'operator' },
          intent: 'inform',
          body: 'Claude completed the first step.',
          contextCards: [],
          deliveryMode: 'inbox',
          createdAt: '2026-01-01T00:01:00.000Z',
          delivery: { state: 'queued', attemptCount: 0 },
          redactions: [],
        },
      ],
    };

    expect(countUnreadMessages(journal, { kind: 'operator' })).toBe(1);
    expect(
      countUnreadMessages(journal, { kind: 'run', runId: 'run-claude' }),
    ).toBe(1);

    const summaries = summarizeThreads(journal, { kind: 'operator' });
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.threadId).toBe(threadId);
    expect(summaries[0]?.messageCount).toBe(2);
    expect(summaries[0]?.unreadCount).toBe(1);
    expect(summaries[0]?.latestExcerpt).toBe(
      'Claude completed the first step.',
    );
  });
});
