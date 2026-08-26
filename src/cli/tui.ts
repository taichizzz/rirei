import { Command } from 'commander';
import { TerminalDaemonClient } from '../../desktop/terminal-daemon-client.mjs';
import { ensureDaemon } from '../platform/daemon-manager.js';
import { createApp, type TerminalSummary } from '../tui/app.js';
import { attachTerminalSession } from '../tui/attach.js';
import { loadDashboardData } from '../tui/state.js';

export function tuiCommand(): Command {
  return new Command('tui')
    .description('Open the interactive Relay terminal user interface')
    .action(async () => {
      // Dynamically import ESM-only Ink and React
      const ink = await import('ink');
      const React = (await import('react')).default;
      const App = createApp(ink, React);

      // 1. Ensure daemon is active
      const daemonInfo = await ensureDaemon();
      const client = new TerminalDaemonClient({
        descriptorPath: daemonInfo.descriptorPath,
        socketPath: daemonInfo.socketPath,
        requestTimeoutMs: 5000,
      });

      await client.connect();

      let isRunning = true;
      const shutdown = () => {
        isRunning = false;
        client.disconnect();
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);

      while (isRunning) {
        let attachTarget: string | null = null;
        let inkInstance: ReturnType<typeof ink.render> | null = null;

        const data = await loadDashboardData(process.cwd());
        let inventory: Array<{
          id: string;
          provider: string;
          project: string;
          workspaceId: string;
          branchLabel: string;
          status: string;
          attentionKind?: string | null;
          activeRuntimeSeconds?: number;
        }> = [];
        try {
          inventory = await client.refreshInventory();
        } catch {
          // Keep current
        }

        const terminalSummaries: TerminalSummary[] = inventory.map((item) => ({
          id: item.id,
          provider: item.provider,
          project: item.project,
          workspaceId: item.workspaceId,
          branchLabel: item.branchLabel,
          status: item.status,
          attentionKind: item.attentionKind,
          activeRuntimeSeconds: item.activeRuntimeSeconds,
        }));

        await new Promise<void>((resolve) => {
          const appElement = React.createElement(App, {
            initialData: data,
            terminals: terminalSummaries,
            daemonConnected: client.connected,
            onLaunchAgent: async (agent: string) => {
              try {
                const terminal = await client.start({
                  kind: 'agent',
                  agent,
                  project: process.cwd(),
                  workspaceId: 'default',
                });
                attachTarget = terminal.id;
                inkInstance?.unmount();
                resolve();
              } catch {
                // Ignore launch error
              }
            },
            onLaunchShell: async () => {
              try {
                const terminal = await client.start({
                  kind: 'shell',
                  project: process.cwd(),
                  workspaceId: 'default',
                });
                attachTarget = terminal.id;
                inkInstance?.unmount();
                resolve();
              } catch {
                // Ignore launch error
              }
            },
            onAttach: (terminalId: string) => {
              attachTarget = terminalId;
              inkInstance?.unmount();
              resolve();
            },
            onRefresh: async () => {
              inkInstance?.unmount();
              resolve();
            },
            onQuit: () => {
              isRunning = false;
              inkInstance?.unmount();
              resolve();
            },
          });

          inkInstance = ink.render(appElement);
        });

        if (!isRunning) break;

        if (attachTarget) {
          await attachTerminalSession(client, attachTarget);
          attachTarget = null;
        }
      }

      client.disconnect();
    });
}
