import { describe, expect, it } from 'vitest';
import {
  mkdir,
  readdir,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import {
  readThreadsJournal,
  threadsJournalPath,
  updateThreadsJournal,
} from '../../src/messages/store.js';
import { THREADS_MAX_JOURNAL_BYTES } from '../../src/messages/schema.js';
import { createRepository, removeRepository } from '../helpers.js';

describe('threads store', () => {
  it('initializes empty journal on first read', async () => {
    const root = await createRepository();
    try {
      const journal = await readThreadsJournal(root, 'session-123');
      expect(journal.schemaVersion).toBe(1);
      expect(journal.sessionId).toBe('session-123');
      expect(journal.revision).toBe(0);
      expect(journal.messages).toEqual([]);
    } finally {
      await removeRepository(root);
    }
  });

  it('updates journal atomically and bumps revision', async () => {
    const root = await createRepository();
    try {
      const { journal } = await updateThreadsJournal(
        root,
        'session-123',
        (curr) => ({
          ...curr,
          nextSequence: 2,
        }),
      );
      expect(journal.revision).toBe(1);
      expect(journal.nextSequence).toBe(2);

      const reloaded = await readThreadsJournal(root, 'session-123');
      expect(reloaded.revision).toBe(1);
      expect(reloaded.nextSequence).toBe(2);
      const entries = await readdir(path.join(root, '.relay', 'threads'));
      expect(entries.some((entry) => entry.endsWith('.tmp'))).toBe(false);
    } finally {
      await removeRepository(root);
    }
  });

  it('handles idempotent operations with the same payloadHash', async () => {
    const root = await createRepository();
    try {
      const opId = 'op-send-1';
      const payloadHash = 'a'.repeat(64);
      const msgId = '11111111-1111-4111-8111-111111111111';

      const first = await updateThreadsJournal(
        root,
        'session-123',
        (curr) => ({
          ...curr,
          nextSequence: 2,
          messages: [
            {
              id: msgId,
              sequence: 1,
              threadId: msgId,
              from: { kind: 'operator' },
              to: { kind: 'run', runId: 'run-1' },
              intent: 'request',
              body: 'Initial request',
              contextCards: [],
              deliveryMode: 'inbox',
              createdAt: new Date().toISOString(),
              delivery: { state: 'queued', attemptCount: 0 },
              redactions: [],
            },
          ],
        }),
        { opId, actor: 'operator', payloadHash, messageId: msgId },
      );
      expect(first.journal.revision).toBe(1);

      // Repeat with same opId and payloadHash
      const second = await updateThreadsJournal(
        root,
        'session-123',
        (curr) => ({
          ...curr,
          messages: [],
        }),
        { opId, actor: 'operator', payloadHash, messageId: msgId },
      );
      expect(second.journal.revision).toBe(1);
      expect(second.existingMessage?.id).toBe(msgId);

      // Conflict with different payloadHash
      await expect(
        updateThreadsJournal(root, 'session-123', (curr) => curr, {
          opId,
          actor: 'operator',
          payloadHash: 'b'.repeat(64),
          messageId: msgId,
        }),
      ).rejects.toThrow(/different payload/);
    } finally {
      await removeRepository(root);
    }
  });

  it('rejects a journal whose embedded session does not match the request', async () => {
    const root = await createRepository();
    try {
      await updateThreadsJournal(root, 'session-123', (current) => ({
        ...current,
        nextSequence: 2,
      }));
      await writeFile(
        threadsJournalPath(root, 'session-123'),
        JSON.stringify({
          schemaVersion: 1,
          sessionId: 'different-session',
          revision: 1,
          nextSequence: 1,
          recentOperations: [],
          messages: [],
        }),
      );
      await expect(readThreadsJournal(root, 'session-123')).rejects.toThrow(
        /session mismatch/i,
      );
    } finally {
      await removeRepository(root);
    }
  });

  it('rejects symlinked relay and threads paths and journal files', async () => {
    const relayRoot = await createRepository();
    const threadsRoot = await createRepository();
    const journalRoot = await createRepository();
    try {
      await mkdir(path.join(relayRoot, 'redirect'));
      await symlink(
        path.join(relayRoot, 'redirect'),
        path.join(relayRoot, '.relay'),
      );
      await expect(readThreadsJournal(relayRoot, 'session')).rejects.toThrow(
        /symlink|real directory/i,
      );

      await mkdir(path.join(threadsRoot, '.relay'));
      await mkdir(path.join(threadsRoot, 'redirect'));
      await symlink(
        path.join(threadsRoot, 'redirect'),
        path.join(threadsRoot, '.relay', 'threads'),
      );
      await expect(readThreadsJournal(threadsRoot, 'session')).rejects.toThrow(
        /symlink|real directory/i,
      );

      await updateThreadsJournal(journalRoot, 'session', (current) => ({
        ...current,
        nextSequence: 2,
      }));
      const journal = threadsJournalPath(journalRoot, 'session');
      await unlink(journal);
      await symlink(path.join(journalRoot, 'README.md'), journal);
      await expect(readThreadsJournal(journalRoot, 'session')).rejects.toThrow(
        /symlink|regular file/i,
      );
    } finally {
      await removeRepository(relayRoot);
      await removeRepository(threadsRoot);
      await removeRepository(journalRoot);
    }
  });

  it('rejects oversized and non-regular journal entries before parsing', async () => {
    const root = await createRepository();
    try {
      await updateThreadsJournal(root, 'session', (current) => ({
        ...current,
        nextSequence: 2,
      }));
      const journal = threadsJournalPath(root, 'session');
      await writeFile(journal, Buffer.alloc(THREADS_MAX_JOURNAL_BYTES + 1));
      await expect(readThreadsJournal(root, 'session')).rejects.toThrow(
        /maximum size/i,
      );

      await rm(journal);
      await mkdir(journal);
      await expect(readThreadsJournal(root, 'session')).rejects.toThrow(
        /regular file/i,
      );
    } finally {
      await removeRepository(root);
    }
  });
});
