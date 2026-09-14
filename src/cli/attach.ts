import { Command } from 'commander';
import { TerminalDaemonClient } from '../../desktop/terminal-daemon-client.mjs';
import { locateDaemon } from '../platform/daemon-manager.js';
import { attachTerminalSession } from '../tui/attach.js';

export interface AttachCliOptions {
  readOnly?: boolean;
  takeover?: boolean;
}

const FINAL_TERMINAL_STATUSES = new Set([
  'finished',
  'completed',
  'failed',
  'cancelled',
  'orphaned',
]);

async function replayTerminalOutput(
  client: TerminalDaemonClient,
  terminalId: string,
): Promise<void> {
  let cursor = 0;
  let attached = false;
  try {
    while (true) {
      const replay = await client.attach(terminalId, cursor);
      attached = true;
      if (replay.data) process.stdout.write(Buffer.from(replay.data, 'base64'));
      const nextCursor = Number.isSafeInteger(replay.nextCursor)
        ? replay.nextCursor
        : replay.endCursor;
      if (replay.endCursor <= cursor || replay.endCursor >= nextCursor) return;
      cursor = replay.endCursor;
    }
  } finally {
    if (attached) await client.detach(terminalId).catch(() => undefined);
  }
}

export function attachCommand(): Command {
  return new Command('attach')
    .description('Attach the interactive terminal to a daemon session')
    .argument('<terminal-id>', 'session terminal identifier')
    .option('-r, --read-only', 'attach as a read-only observer')
    .option('-t, --takeover', 'forcibly displace an existing controller')
    .action(async (terminalId: string, options: AttachCliOptions) => {
      if (options.readOnly && options.takeover) {
        throw new Error('Cannot specify both --read-only and --takeover.');
      }

      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        throw new Error('Attach requires an interactive terminal.');
      }

      const daemonInfo = await locateDaemon();
      const client = new TerminalDaemonClient({
        descriptorPath: daemonInfo.descriptorPath,
        socketPath: daemonInfo.socketPath,
        requestTimeoutMs: 10_000,
      });

      await client.connect();

      try {
        const terminal = (await client.inspect(terminalId)) as {
          status?: string;
          lifecycleState?: string;
        };

        if (
          FINAL_TERMINAL_STATUSES.has(terminal.status ?? '') ||
          FINAL_TERMINAL_STATUSES.has(terminal.lifecycleState ?? '')
        ) {
          await replayTerminalOutput(client, terminalId);
          return;
        }

        try {
          await attachTerminalSession(client, terminalId, {
            readOnly: options.readOnly,
            takeover: options.takeover,
            clearOnExit: false,
            returnToDashboard: false,
          });
        } catch (error: unknown) {
          if (
            typeof error === 'object' &&
            error !== null &&
            ((error as { code?: string }).code === 'control_busy' ||
              (error as { daemonCode?: string }).daemonCode === 'control_busy')
          ) {
            throw new Error(
              'Terminal control is already held by another client. Run with --takeover to displace or --read-only to observe.',
            );
          }
          throw error;
        }
      } finally {
        client.disconnect();
      }
    });
}
