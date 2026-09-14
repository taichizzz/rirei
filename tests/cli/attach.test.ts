import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { attachCommand } from '../../src/cli/attach.js';
import * as daemonManager from '../../src/platform/daemon-manager.js';
import * as tuiAttach from '../../src/tui/attach.js';

class MockDaemonClient extends EventEmitter {
  connected = true;
  inspectResult: Record<string, unknown> = { id: 'term-1', status: 'running' };
  attachResult: { data: string; startCursor: number; endCursor: number } = {
    data: Buffer.from('finished output').toString('base64'),
    startCursor: 0,
    endCursor: 15,
  };
  attachResults: Array<{
    data: string;
    startCursor: number;
    endCursor: number;
    nextCursor?: number;
  }> = [];
  disconnected = false;
  detached = false;

  async connect() {
    this.connected = true;
  }
  disconnect() {
    this.disconnected = true;
    this.connected = false;
  }
  async inspect() {
    return this.inspectResult;
  }
  async attach() {
    return this.attachResults.shift() ?? this.attachResult;
  }
  async detach() {
    this.detached = true;
    return { ok: true };
  }
}

function setTty(stdin: boolean, stdout: boolean): () => void {
  const originalStdin = process.stdin.isTTY;
  const originalStdout = process.stdout.isTTY;
  Object.defineProperty(process.stdin, 'isTTY', {
    value: stdin,
    configurable: true,
  });
  Object.defineProperty(process.stdout, 'isTTY', {
    value: stdout,
    configurable: true,
  });
  return () => {
    Object.defineProperty(process.stdin, 'isTTY', {
      value: originalStdin,
      configurable: true,
    });
    Object.defineProperty(process.stdout, 'isTTY', {
      value: originalStdout,
      configurable: true,
    });
  };
}

describe('relay attach CLI', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects mutual inclusion of --read-only and --takeover', async () => {
    const cmd = attachCommand();
    cmd.exitOverride();

    await expect(
      cmd.parseAsync(['node', 'attach', 'term-1', '--read-only', '--takeover']),
    ).rejects.toThrow('Cannot specify both --read-only and --takeover.');
  });

  it('requires an interactive terminal (stdin.isTTY)', async () => {
    const restoreTty = setTty(false, true);

    try {
      const cmd = attachCommand();
      cmd.exitOverride();

      await expect(
        cmd.parseAsync(['node', 'attach', 'term-1']),
      ).rejects.toThrow('Attach requires an interactive terminal.');
    } finally {
      restoreTty();
    }
  });

  it('requires interactive stdout as well as stdin', async () => {
    const restoreTty = setTty(true, false);
    try {
      const cmd = attachCommand();
      cmd.exitOverride();

      await expect(
        cmd.parseAsync(['node', 'attach', 'term-1']),
      ).rejects.toThrow('Attach requires an interactive terminal.');
    } finally {
      restoreTty();
    }
  });

  it('replays every retained buffer slice and exits cleanly when a terminal has finished', async () => {
    const restoreTty = setTty(true, true);

    const mockClient = new MockDaemonClient();
    mockClient.inspectResult = { id: 'term-done', status: 'completed' };
    mockClient.attachResults = [
      {
        data: Buffer.from('finished ').toString('base64'),
        startCursor: 0,
        endCursor: 9,
        nextCursor: 15,
      },
      {
        data: Buffer.from('output').toString('base64'),
        startCursor: 9,
        endCursor: 15,
        nextCursor: 15,
      },
    ];

    vi.spyOn(daemonManager, 'locateDaemon').mockResolvedValue({
      socketPath: '/tmp/fake.sock',
      descriptorPath: '/tmp/fake.json',
      reused: true,
    });

    const stdoutWrite = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    const attachSessionSpy = vi.spyOn(tuiAttach, 'attachTerminalSession');

    // Mock client creation
    const { TerminalDaemonClient } =
      await import('../../desktop/terminal-daemon-client.mjs');
    vi.spyOn(TerminalDaemonClient.prototype, 'connect').mockImplementation(
      async function () {
        mockClient.connected = true;
      },
    );
    vi.spyOn(TerminalDaemonClient.prototype, 'disconnect').mockImplementation(
      function () {
        mockClient.disconnect();
      },
    );
    vi.spyOn(TerminalDaemonClient.prototype, 'inspect').mockImplementation(
      async function () {
        return mockClient.inspectResult;
      },
    );
    vi.spyOn(TerminalDaemonClient.prototype, 'attach').mockImplementation(
      async function () {
        return mockClient.attach();
      },
    );
    vi.spyOn(TerminalDaemonClient.prototype, 'detach').mockImplementation(
      async function () {
        return mockClient.detach('term-done');
      },
    );

    try {
      const cmd = attachCommand();
      cmd.exitOverride();

      await cmd.parseAsync(['node', 'attach', 'term-done']);

      expect(stdoutWrite).toHaveBeenNthCalledWith(1, Buffer.from('finished '));
      expect(stdoutWrite).toHaveBeenNthCalledWith(2, Buffer.from('output'));
      expect(mockClient.detached).toBe(true);
      expect(mockClient.disconnected).toBe(true);
      expect(attachSessionSpy).not.toHaveBeenCalled();
    } finally {
      restoreTty();
    }
  });

  it('passes read-only and takeover flags to attachTerminalSession for active terminal', async () => {
    const restoreTty = setTty(true, true);

    const mockClient = new MockDaemonClient();
    mockClient.inspectResult = { id: 'term-active', status: 'running' };

    vi.spyOn(daemonManager, 'locateDaemon').mockResolvedValue({
      socketPath: '/tmp/fake.sock',
      descriptorPath: '/tmp/fake.json',
      reused: true,
    });

    const { TerminalDaemonClient } =
      await import('../../desktop/terminal-daemon-client.mjs');
    vi.spyOn(TerminalDaemonClient.prototype, 'connect').mockImplementation(
      async function () {
        mockClient.connected = true;
      },
    );
    vi.spyOn(TerminalDaemonClient.prototype, 'disconnect').mockImplementation(
      function () {
        mockClient.disconnect();
      },
    );
    vi.spyOn(TerminalDaemonClient.prototype, 'inspect').mockImplementation(
      async function () {
        return mockClient.inspectResult;
      },
    );

    const attachSessionSpy = vi
      .spyOn(tuiAttach, 'attachTerminalSession')
      .mockResolvedValue();

    try {
      const cmd = attachCommand();
      cmd.exitOverride();

      await cmd.parseAsync(['node', 'attach', 'term-active', '--takeover']);

      expect(attachSessionSpy).toHaveBeenCalledWith(
        expect.any(Object),
        'term-active',
        expect.objectContaining({
          readOnly: undefined,
          takeover: true,
          clearOnExit: false,
          returnToDashboard: false,
        }),
      );
      expect(mockClient.disconnected).toBe(true);
    } finally {
      restoreTty();
    }
  });
  it('surfaces helpful error message when control is busy without --takeover', async () => {
    const restoreTty = setTty(true, true);

    const mockClient = new MockDaemonClient();
    mockClient.inspectResult = { id: 'term-busy', status: 'running' };

    vi.spyOn(daemonManager, 'locateDaemon').mockResolvedValue({
      socketPath: '/tmp/fake.sock',
      descriptorPath: '/tmp/fake.json',
      reused: true,
    });

    const { TerminalDaemonClient } =
      await import('../../desktop/terminal-daemon-client.mjs');
    vi.spyOn(TerminalDaemonClient.prototype, 'connect').mockImplementation(
      async function () {
        mockClient.connected = true;
      },
    );
    vi.spyOn(TerminalDaemonClient.prototype, 'disconnect').mockImplementation(
      function () {
        mockClient.disconnect();
      },
    );
    vi.spyOn(TerminalDaemonClient.prototype, 'inspect').mockImplementation(
      async function () {
        return mockClient.inspectResult;
      },
    );

    vi.spyOn(tuiAttach, 'attachTerminalSession').mockRejectedValue(
      Object.assign(new Error('busy'), { code: 'control_busy' }),
    );

    try {
      const cmd = attachCommand();
      cmd.exitOverride();

      await expect(
        cmd.parseAsync(['node', 'attach', 'term-busy']),
      ).rejects.toThrow(
        'Terminal control is already held by another client. Run with --takeover to displace or --read-only to observe.',
      );
      expect(mockClient.disconnected).toBe(true);
    } finally {
      restoreTty();
    }
  });
});
