import { mkdir } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  acknowledgeMessage,
  expireQueuedMessages,
  getInbox,
  getThread,
  markMessageRead,
  replyMessage,
  sendMessage,
} from '../../src/messages/service.js';
import { readThreadsJournal } from '../../src/messages/store.js';
import { relayPath } from '../../src/safety/path-policy.js';
import {
  LATEST_STATE_SCHEMA,
  type RelayState,
} from '../../src/state/schema.js';
import { updateState, writeState } from '../../src/state/store.js';
import { createRepository, removeRepository } from '../helpers.js';

const now = '2026-01-01T00:00:00.000Z';

async function initializeState(
  root: string,
  sessionId: string,
  runIds: string[],
  taskStatus: RelayState['task']['status'] = 'active',
): Promise<void> {
  const state: RelayState = {
    schemaVersion: LATEST_STATE_SCHEMA,
    revision: 0,
    recentOperations: [],
    runs: runIds.map((runId, index) => ({
      runId,
      displayLabel: `Run ${index + 1}`,
      worktreePath: `${root}/worktree-${index}`,
      projectRoot: root,
      agent: 'test-agent',
      launchMode: 'new',
      controllerId: `cli:test:${index}`,
      controller: {
        kind: 'cli',
        instanceId: String(index),
        pid: index + 1,
        bootId: 'test-boot',
      },
      lifecycleStatus: 'working',
      activeRuntimeSeconds: 0,
      runtimeSequence: 0,
      startedAt: now,
      lastSeenAt: now,
      status: 'running',
    })),
    sessionId,
    projectRoot: root,
    task: {
      title: 'Message service test',
      originalRequest: 'Test message lifecycle behavior.',
      requirements: [],
      constraints: [],
      status: taskStatus,
      createdAt: now,
      updatedAt: now,
    },
    git: { startingCommit: 'abc', startingBranch: 'main', dirtyAtStart: false },
    agentHistory: [],
    decisions: [],
    completedWork: [],
    remainingWork: [],
    tests: [],
    checkpoints: [],
    blockers: [],
    notes: [],
  };
  await mkdir(relayPath(root), { recursive: true });
  await writeState(root, state);
}

describe('threads service', () => {
  it('rejects delivery modes not advertised by the recipient adapter', async () => {
    const root = await createRepository();
    try {
      await initializeState(root, 'session-delivery', ['worker']);
      await expect(
        sendMessage(root, {
          sessionId: 'session-delivery',
          from: { kind: 'operator' },
          to: { kind: 'run', runId: 'worker' },
          intent: 'inform',
          deliveryMode: 'wake',
          body: 'Wake up.',
        }),
      ).rejects.toThrow(/wake delivery is not supported/);
    } finally {
      await removeRepository(root);
    }
  });

  it('sends root message and replies in thread', async () => {
    const root = await createRepository();
    try {
      const sessionId = 'session-test';
      await initializeState(root, sessionId, ['run-claude']);
      const { message: rootMsg } = await sendMessage(root, {
        sessionId,
        from: { kind: 'operator' },
        to: { kind: 'run', runId: 'run-claude' },
        intent: 'request',
        body: 'Please run tests and report back.',
      });

      expect(rootMsg.threadId).toBe(rootMsg.id);
      expect(rootMsg.sequence).toBe(1);
      expect(rootMsg.delivery.state).toBe('queued');

      const { message: replyMsg } = await replyMessage(root, {
        sessionId,
        parentMessageId: rootMsg.id,
        from: { kind: 'run', runId: 'run-claude' },
        intent: 'inform',
        body: 'Tests passed cleanly.',
      });

      expect(replyMsg.threadId).toBe(rootMsg.threadId);
      expect(replyMsg.replyToId).toBe(rootMsg.id);
      expect(replyMsg.to).toEqual({ kind: 'operator' });
      expect(replyMsg.sequence).toBe(2);

      const thread = await getThread(root, sessionId, rootMsg.threadId, {
        kind: 'operator',
      });
      expect(thread).toHaveLength(2);
      expect(thread[0]?.body).toBe('Please run tests and report back.');
      expect(thread[1]?.body).toBe('Tests passed cleanly.');
    } finally {
      await removeRepository(root);
    }
  });

  it('handles ack reply acknowledging parent atomically', async () => {
    const root = await createRepository();
    try {
      const sessionId = 'session-test';
      await initializeState(root, sessionId, ['run-codex', 'run-claude']);
      const { message: requestMsg } = await sendMessage(root, {
        sessionId,
        from: { kind: 'run', runId: 'run-codex' },
        to: { kind: 'run', runId: 'run-claude' },
        intent: 'request',
        body: 'Please review this checkpoint.',
      });

      const { message: ackReply } = await replyMessage(root, {
        sessionId,
        parentMessageId: requestMsg.id,
        from: { kind: 'run', runId: 'run-claude' },
        intent: 'ack',
        body: 'Acknowledged and starting review.',
      });

      const thread = await getThread(root, sessionId, requestMsg.threadId, {
        kind: 'operator',
      });
      expect(thread[0]?.delivery.state).toBe('acknowledged');
      expect(thread[0]?.delivery.acknowledgedAt).toBeDefined();
      expect(ackReply.sequence).toBe(2);
    } finally {
      await removeRepository(root);
    }
  });

  it('marks inbox messages read', async () => {
    const root = await createRepository();
    try {
      const sessionId = 'session-test';
      await initializeState(root, sessionId, ['run-1']);
      const { message: msg } = await sendMessage(root, {
        sessionId,
        from: { kind: 'operator' },
        to: { kind: 'run', runId: 'run-1' },
        intent: 'inform',
        body: 'A reminder.',
      });

      expect(msg.delivery.readAt).toBeUndefined();

      // Read via getInbox (with peek: false)
      const inbox = await getInbox(root, sessionId, {
        kind: 'run',
        runId: 'run-1',
      });
      expect(inbox).toHaveLength(1);
      expect(inbox[0]?.delivery.readAt).toBeDefined();

      // Verify readAt was populated
      const inboxAfter = await getInbox(
        root,
        sessionId,
        { kind: 'run', runId: 'run-1' },
        { peek: true },
      );
      expect(inboxAfter[0]?.delivery.readAt).toBeDefined();

      // Test markMessageRead explicitly
      const marked = await markMessageRead(root, sessionId, msg.id, {
        kind: 'run',
        runId: 'run-1',
      });
      expect(marked.delivery.readAt).toBeDefined();

      // Test acknowledgeMessage explicitly
      const acked = await acknowledgeMessage(root, sessionId, msg.id, {
        kind: 'run',
        runId: 'run-1',
      });
      expect(acked.delivery.state).toBe('acknowledged');
      expect(acked.delivery.acknowledgedAt).toBeDefined();
    } finally {
      await removeRepository(root);
    }
  });

  it('expires queued messages when recipient ends', async () => {
    const root = await createRepository();
    try {
      const sessionId = 'session-test';
      await initializeState(root, sessionId, ['run-dead']);
      await sendMessage(root, {
        sessionId,
        from: { kind: 'operator' },
        to: { kind: 'run', runId: 'run-dead' },
        intent: 'request',
        body: 'Are you there?',
      });

      const expiredCount = await expireQueuedMessages(
        root,
        sessionId,
        'recipient_ended',
        'run-dead',
      );
      expect(expiredCount).toBe(1);

      const thread = await getInbox(
        root,
        sessionId,
        { kind: 'run', runId: 'run-dead' },
        { peek: true },
      );
      expect(thread[0]?.delivery.state).toBe('expired');
      expect(thread[0]?.delivery.expirationReason).toBe('recipient_ended');
    } finally {
      await removeRepository(root);
    }
  });

  it('twenty concurrent sends retain every message and unique sequence', async () => {
    const root = await createRepository();
    try {
      const sessionId = 'session-concurrent';
      await initializeState(root, sessionId, ['run-worker']);
      const tasks = Array.from({ length: 20 }, (_, i) =>
        sendMessage(root, {
          sessionId,
          from: { kind: 'operator' },
          to: { kind: 'run', runId: 'run-worker' },
          intent: 'inform',
          body: `Concurrent message ${i}`,
        }),
      );

      const results = await Promise.all(tasks);
      expect(results).toHaveLength(20);

      const inbox = await getInbox(
        root,
        sessionId,
        { kind: 'run', runId: 'run-worker' },
        { peek: true },
      );
      expect(inbox).toHaveLength(20);

      const sequences = inbox.map((m) => m.sequence).sort((a, b) => a - b);
      expect(sequences).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    } finally {
      await removeRepository(root);
    }
  });

  it('keeps acknowledgement transitions recipient-only, idempotent, and non-expired', async () => {
    const root = await createRepository();
    try {
      const sessionId = 'session-ack-invariants';
      await initializeState(root, sessionId, [
        'recipient',
        'expired-recipient',
      ]);
      const { message } = await sendMessage(root, {
        sessionId,
        from: { kind: 'operator' },
        to: { kind: 'run', runId: 'recipient' },
        intent: 'request',
        body: 'Please confirm.',
      });

      await expect(
        acknowledgeMessage(root, sessionId, message.id, { kind: 'operator' }),
      ).rejects.toThrow(/Only the recipient/);
      await expect(
        replyMessage(root, {
          sessionId,
          parentMessageId: message.id,
          from: { kind: 'operator' },
          intent: 'ack',
          body: 'Invalid self-ack.',
        }),
      ).rejects.toThrow(/parent recipient/i);

      const first = await acknowledgeMessage(root, sessionId, message.id, {
        kind: 'run',
        runId: 'recipient',
      });
      const firstJournal = await readThreadsJournal(root, sessionId);
      const second = await acknowledgeMessage(root, sessionId, message.id, {
        kind: 'run',
        runId: 'recipient',
      });
      const secondJournal = await readThreadsJournal(root, sessionId);
      expect(second.delivery.acknowledgedAt).toBe(
        first.delivery.acknowledgedAt,
      );
      expect(secondJournal.revision).toBe(firstJournal.revision);

      const { message: expiring } = await sendMessage(root, {
        sessionId,
        from: { kind: 'operator' },
        to: { kind: 'run', runId: 'expired-recipient' },
        intent: 'request',
        body: 'This will expire.',
      });
      await expireQueuedMessages(root, sessionId, 'ttl');
      await expect(
        acknowledgeMessage(root, sessionId, expiring.id, {
          kind: 'run',
          runId: 'expired-recipient',
        }),
      ).rejects.toThrow(/Expired messages/);
      await expect(
        replyMessage(root, {
          sessionId,
          parentMessageId: expiring.id,
          from: { kind: 'run', runId: 'expired-recipient' },
          intent: 'ack',
          body: 'Too late.',
        }),
      ).rejects.toThrow(/Expired messages/);
    } finally {
      await removeRepository(root);
    }
  });

  it('scans and redacts caller-supplied context card fields before persistence', async () => {
    const root = await createRepository();
    try {
      const secret = 'ghp_1234567890abcdefghijklmnopqrstuvwxyz12';
      await initializeState(root, 'session-card-redaction', ['recipient']);
      const request = {
        sessionId: 'session-card-redaction',
        from: { kind: 'operator' } as const,
        to: { kind: 'run', runId: 'recipient' } as const,
        intent: 'inform' as const,
        body: 'Review the attached context.',
        contextCards: [
          {
            kind: 'note' as const,
            sourceId: 'note-1',
            title: `Credential ${secret}`,
            text: 'Caller-provided context.',
            capturedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      };
      await expect(sendMessage(root, request)).rejects.toThrow(
        /sensitive secrets/,
      );

      const { message } = await sendMessage(root, {
        ...request,
        redact: true,
      });
      expect(message.contextCards[0]?.title).not.toContain(secret);
      expect(message.contextCards[0]?.title).toContain(
        '[REDACTED_SECRET:github_token]',
      );
      expect(message.redactions).toContainEqual({
        kind: 'github_token',
        count: 1,
      });
      expect(
        JSON.stringify(await readThreadsJournal(root, request.sessionId)),
      ).not.toContain(secret);
    } finally {
      await removeRepository(root);
    }
  });

  it('treats context capture timestamps as non-semantic for operation retries', async () => {
    const root = await createRepository();
    try {
      const sessionId = 'session-context-retry';
      await initializeState(root, sessionId, ['recipient']);
      const base = {
        sessionId,
        from: { kind: 'operator' } as const,
        to: { kind: 'run', runId: 'recipient' } as const,
        intent: 'inform' as const,
        body: 'Review this context.',
        operationId: 'context-retry',
      };
      const first = await sendMessage(root, {
        ...base,
        contextCards: [
          {
            kind: 'note',
            sourceId: 'note-1',
            title: 'Decision',
            text: 'Use the durable journal.',
            capturedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      });
      const retry = await sendMessage(root, {
        ...base,
        contextCards: [
          {
            kind: 'note',
            sourceId: 'note-1',
            title: 'Decision',
            text: 'Use the durable journal.',
            capturedAt: '2026-01-01T00:00:01.000Z',
          },
        ],
      });
      expect(retry.message.id).toBe(first.message.id);
      expect(retry.journal.revision).toBe(first.journal.revision);
    } finally {
      await removeRepository(root);
    }
  });

  it('returns exactly the read receipts persisted by a concurrent inbox read', async () => {
    const root = await createRepository();
    try {
      const sessionId = 'session-inbox-race';
      const actor = { kind: 'run' as const, runId: 'worker' };
      await initializeState(root, sessionId, ['worker']);
      await sendMessage(root, {
        sessionId,
        from: { kind: 'operator' },
        to: actor,
        intent: 'inform',
        body: 'Initial message',
      });

      const [returned] = await Promise.all([
        getInbox(root, sessionId, actor),
        ...Array.from({ length: 12 }, (_, index) =>
          sendMessage(root, {
            sessionId,
            from: { kind: 'operator' },
            to: actor,
            intent: 'inform',
            body: `Racing message ${index}`,
          }),
        ),
      ]);
      const persisted = await getInbox(root, sessionId, actor, { peek: true });
      const returnedIds = new Set(returned.map((message) => message.id));
      expect(returned.every((message) => message.delivery.readAt)).toBe(true);
      expect(
        persisted
          .filter((message) => message.delivery.readAt)
          .every((message) => returnedIds.has(message.id)),
      ).toBe(true);
    } finally {
      await removeRepository(root);
    }
  });

  it('requires the current session and an active or blocked task', async () => {
    const root = await createRepository();
    try {
      await initializeState(root, 'current-session', [], 'completed');
      await expect(
        sendMessage(root, {
          sessionId: 'current-session',
          from: { kind: 'operator' },
          to: { kind: 'run', runId: 'missing' },
          intent: 'inform',
          body: 'Too late.',
        }),
      ).rejects.toThrow(/active or blocked/);
      await expect(
        sendMessage(root, {
          sessionId: 'stale-session',
          from: { kind: 'operator' },
          to: { kind: 'run', runId: 'missing' },
          intent: 'inform',
          body: 'Wrong task.',
        }),
      ).rejects.toThrow(/session mismatch/i);
      expect(
        (await readThreadsJournal(root, 'current-session')).messages,
      ).toEqual([]);
    } finally {
      await removeRepository(root);
    }
  });

  it('requires current non-orphaned run senders and recipients', async () => {
    const root = await createRepository();
    try {
      const sessionId = 'session-leases';
      await initializeState(root, sessionId, ['sender']);
      await expect(
        sendMessage(root, {
          sessionId,
          from: { kind: 'operator' },
          to: { kind: 'run', runId: 'nonexistent' },
          intent: 'inform',
          body: 'No recipient.',
        }),
      ).rejects.toThrow(/Active recipient run:nonexistent/);

      await updateState(root, (current) => ({
        ...current,
        runs: current.runs.map((run) => ({
          ...run,
          status: 'orphaned' as const,
          lifecycleStatus: 'orphaned' as const,
        })),
      }));
      await expect(
        sendMessage(root, {
          sessionId,
          from: { kind: 'run', runId: 'sender' },
          to: { kind: 'operator' },
          intent: 'inform',
          body: 'Orphaned sender.',
        }),
      ).rejects.toThrow(/non-orphaned lease/);
    } finally {
      await removeRepository(root);
    }
  });

  it('rejects a reply when its inferred run recipient has ended', async () => {
    const root = await createRepository();
    try {
      const sessionId = 'session-ended-recipient';
      await initializeState(root, sessionId, ['recipient']);
      const { message } = await sendMessage(root, {
        sessionId,
        from: { kind: 'operator' },
        to: { kind: 'run', runId: 'recipient' },
        intent: 'request',
        body: 'Initial request.',
      });
      await updateState(root, (current) => ({ ...current, runs: [] }));

      await expect(
        sendMessage(root, {
          sessionId,
          from: { kind: 'operator' },
          to: { kind: 'run', runId: 'recipient' },
          intent: 'inform',
          body: 'Recipient has ended.',
        }),
      ).rejects.toThrow(/Active recipient run:recipient/);
      await expect(
        replyMessage(root, {
          sessionId,
          parentMessageId: message.id,
          from: { kind: 'operator' },
          intent: 'inform',
          body: 'Reply after recipient ended.',
        }),
      ).rejects.toThrow(/Active recipient run:recipient/);
      expect((await readThreadsJournal(root, sessionId)).messages).toHaveLength(
        1,
      );
    } finally {
      await removeRepository(root);
    }
  });

  it('orders send against task closure without leaving a queued message', async () => {
    const root = await createRepository();
    try {
      const sessionId = 'session-close-race';
      await initializeState(root, sessionId, ['recipient']);

      const [sendResult, closeResult] = await Promise.allSettled([
        sendMessage(root, {
          sessionId,
          from: { kind: 'operator' },
          to: { kind: 'run', runId: 'recipient' },
          intent: 'inform',
          body: 'Racing task closure.',
        }),
        (async () => {
          await updateState(root, (current) => ({
            ...current,
            runs: [],
            task: {
              ...current.task,
              status: 'completed' as const,
              updatedAt: new Date().toISOString(),
            },
          }));
          await expireQueuedMessages(root, sessionId, 'task_closed');
        })(),
      ]);
      expect(closeResult.status).toBe('fulfilled');

      const messages = (await readThreadsJournal(root, sessionId)).messages;
      expect(
        messages.some((message) => message.delivery.state === 'queued'),
      ).toBe(false);
      if (sendResult.status === 'fulfilled') {
        expect(messages).toHaveLength(1);
        expect(messages[0]?.delivery.state).toBe('expired');
      } else {
        expect(messages).toHaveLength(0);
      }
    } finally {
      await removeRepository(root);
    }
  });
});
