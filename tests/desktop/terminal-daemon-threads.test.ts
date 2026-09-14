import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TerminalDaemonClient } from '../../desktop/terminal-daemon-client.mjs';
import { runTerminalDaemon } from '../../desktop/terminal-daemon-server.mjs';
import { createRepository, removeRepository } from '../helpers.js';

const directories: string[] = [];
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((c) => c()));
  for (const dir of directories) {
    await removeRepository(dir);
  }
  directories.length = 0;
});

describe('daemon threads notification protocol', () => {
  it('delivers thread changes only to clients watching the project', async () => {
    const root = await createRepository();
    const otherRoot = await createRepository();
    directories.push(root, otherRoot);

    const socketPath =
      process.platform === 'win32'
        ? `\\\\.\\pipe\\rirei-threads-test-${randomUUID()}`
        : path.join(root, 'daemon.sock');
    const descriptorPath = path.join(root, 'daemon.json');

    const daemon = await runTerminalDaemon({
      root,
      socketPath,
      descriptorPath,
      bridgePath: path.resolve('desktop/pty_bridge.py'),
      pathValue: process.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin',
      commandFor: () => ['/bin/zsh', '-f'],
      readProviderResult: async () => null,
    });
    cleanups.push(() => daemon.close({ stopActive: true }));

    const client1 = new TerminalDaemonClient({
      descriptorPath,
      socketPath,
    });
    const client2 = new TerminalDaemonClient({
      descriptorPath,
      socketPath,
    });
    const client3 = new TerminalDaemonClient({
      descriptorPath,
      socketPath,
    });

    await client1.connect();
    await client2.connect();
    await client3.connect();
    await client2.watchThreads(root);
    await client3.watchThreads(otherRoot);

    const receivedEvents: unknown[] = [];
    const unrelatedEvents: unknown[] = [];
    client2.on('threads_changed', (event) => {
      receivedEvents.push(event);
    });
    client3.on('threads_changed', (event) => {
      unrelatedEvents.push(event);
    });

    await client1.notifyThreads({
      projectRoot: root,
      sessionId: 'session-1',
      threadId: '11111111-1111-4111-8111-111111111111',
      messageId: '22222222-2222-4222-8222-222222222222',
      revision: 3,
    });

    // Wait for event to arrive
    const deadline = Date.now() + 2000;
    while (receivedEvents.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }

    expect(receivedEvents).toHaveLength(1);
    expect(receivedEvents[0]).toMatchObject({
      event: 'threads_changed',
      projectRoot: root,
      sessionId: 'session-1',
      threadId: '11111111-1111-4111-8111-111111111111',
      messageId: '22222222-2222-4222-8222-222222222222',
      revision: 3,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(unrelatedEvents).toEqual([]);

    await expect(
      client1.notifyThreads({
        projectRoot: root,
        messageId: 'not-a-message-id',
      }),
    ).rejects.toMatchObject({ code: 'invalid_threads_notification' });

    await client1.disconnect();
    await client2.disconnect();
    await client3.disconnect();
  });
});
