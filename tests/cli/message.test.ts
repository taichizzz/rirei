import { mkdir } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { messageCommand } from '../../src/cli/message.js';
import { relayPath } from '../../src/safety/path-policy.js';
import {
  LATEST_STATE_SCHEMA,
  type RelayState,
} from '../../src/state/schema.js';
import { writeState } from '../../src/state/store.js';
import { createRepository, removeRepository } from '../helpers.js';

const directories: string[] = [];

afterEach(async () => {
  for (const dir of directories) {
    await removeRepository(dir);
  }
  directories.length = 0;
});

async function setupProject(): Promise<string> {
  const root = await createRepository();
  directories.push(root);
  await mkdir(relayPath(root), { recursive: true });

  const now = '2026-01-01T00:00:00.000Z';
  const state: RelayState = {
    schemaVersion: LATEST_STATE_SCHEMA,
    revision: 0,
    recentOperations: [],
    runs: [
      {
        runId: 'run-claude',
        displayLabel: 'Claude 1',
        worktreePath: root,
        projectRoot: root,
        agent: 'claude',
        launchMode: 'new',
        controllerId: 'cli:boot:1',
        controller: { kind: 'cli', instanceId: '1', pid: 1, bootId: 'boot' },
        lifecycleStatus: 'working',
        activeRuntimeSeconds: 0,
        runtimeSequence: 0,
        startedAt: now,
        lastSeenAt: now,
        status: 'running',
      },
    ],
    sessionId: 'session-test',
    projectRoot: root,
    task: {
      title: 'Task',
      originalRequest: 'Task',
      requirements: [],
      constraints: [],
      status: 'active',
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
    notes: [
      {
        id: '11111111-1111-4111-8111-111111111111',
        type: 'decision',
        text: 'We decided to implement relay threads.',
        provenance: { source: 'user', recordedBy: 'relay-cli' },
        git: {
          commit: 'abcdef123456',
          branch: 'main',
          fingerprint: '0'.repeat(64),
        },
        createdAt: now,
      },
    ],
  };

  await writeState(root, state);
  return root;
}

describe('relay message CLI', () => {
  it('executes send, inbox, and reply workflows', async () => {
    const root = await setupProject();
    const prevCwd = process.cwd();
    process.chdir(root);

    try {
      // 1. Send message using the canonical run reference.
      const sendCmd = messageCommand();
      let capturedOut = '';
      const writeSpy = (chunk: string) => {
        capturedOut += chunk;
        return true;
      };
      const origWrite = process.stdout.write;
      process.stdout.write = writeSpy as typeof process.stdout.write;

      await sendCmd.parseAsync([
        'node',
        'relay',
        'send',
        '--to',
        'run:run-claude',
        '--intent',
        'request',
        '--text',
        'Please review note-1.',
        '--context-note',
        '11111111-1111-4111-8111-111111111111',
        '--json',
      ]);

      process.stdout.write = origWrite;
      const sendJson = JSON.parse(capturedOut);
      expect(sendJson.schemaVersion).toBe(1);
      expect(sendJson.message.body).toBe('Please review note-1.');
      expect(sendJson.message.contextCards).toHaveLength(1);
      expect(sendJson.message.contextCards[0].sourceId).toBe(
        '11111111-1111-4111-8111-111111111111',
      );

      // 2. Read thread
      const threadCmd = messageCommand();
      capturedOut = '';
      process.stdout.write = writeSpy as typeof process.stdout.write;

      await threadCmd.parseAsync([
        'node',
        'relay',
        'thread',
        `thread:${sendJson.message.threadId}`,
        '--json',
      ]);

      process.stdout.write = origWrite;
      const threadJson = JSON.parse(capturedOut);
      expect(threadJson.messages).toHaveLength(1);

      await expect(
        messageCommand().parseAsync([
          'node',
          'relay',
          'send',
          '--to',
          'Claude 1',
          '--text',
          'This label must not route.',
        ]),
      ).rejects.toThrow(/Display labels are not routing keys/);

      await expect(
        messageCommand().parseAsync([
          'node',
          'relay',
          'send',
          '--to',
          'run:run-claude',
          '--delivery',
          'wake',
          '--text',
          'Unsupported delivery.',
        ]),
      ).rejects.toThrow(/wake delivery is not supported/);
    } finally {
      process.chdir(prevCwd);
    }
  });
});
