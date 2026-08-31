import { Command } from 'commander';
import { TerminalDaemonClient } from '../../desktop/terminal-daemon-client.mjs';
import { agentCatalog } from '../agents/registry.js';
import { ensureDaemon } from '../platform/daemon-manager.js';
import { createApp, type TerminalSummary } from '../tui/app.js';
import { attachTerminalSession } from '../tui/attach.js';
import type { LaunchSelection } from '../tui/launch-options.js';
import { loadDashboardData } from '../tui/state.js';

const ENTER_DASHBOARD = '\x1b[?1049h\x1b[2J\x1b[H\x1b[?25l';
const RESET_DASHBOARD = '\x1b[2J\x1b[H';
const LEAVE_DASHBOARD = '\x1b[?1000l\x1b[?1006l\x1b[?25h\x1b[?1049l';

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
        requestTimeoutMs: 10_000,
      });

      await client.connect();
      if (process.stdout.isTTY)
        process.stdout.write(
          'Discovering installed provider models and capabilities…',
        );
      let catalog = await agentCatalog({
        includeAuthentication: false,
      }).catch(() => []);
      if (process.stdout.isTTY) process.stdout.write('\r\x1b[2K');

      let isRunning = true;
      let dashboardActive = false;
      let activeInk: ReturnType<typeof ink.render> | null = null;
      let finishDashboard: (() => void) | null = null;
      const enterDashboard = () => {
        if (!process.stdout.isTTY) return;
        process.stdout.write(
          dashboardActive ? RESET_DASHBOARD : ENTER_DASHBOARD,
        );
        dashboardActive = true;
      };
      const leaveDashboard = () => {
        if (!dashboardActive) return;
        process.stdout.write(LEAVE_DASHBOARD);
        dashboardActive = false;
      };
      const shutdown = () => {
        isRunning = false;
        activeInk?.unmount();
        finishDashboard?.();
        client.disconnect();
        leaveDashboard();
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);

      try {
        while (isRunning) {
          enterDashboard();
          let attachTarget: string | null = null;

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
          if (!isRunning) break;

          const terminalSummaries: TerminalSummary[] = inventory.map(
            (item) => ({
              id: item.id,
              provider: item.provider,
              project: item.project,
              workspaceId: item.workspaceId,
              branchLabel: item.branchLabel,
              status: item.status,
              attentionKind: item.attentionKind,
              activeRuntimeSeconds: item.activeRuntimeSeconds,
            }),
          );

          let dashboardInk: ReturnType<typeof ink.render> | null = null;
          await new Promise<void>((resolve) => {
            let settled = false;
            const finish = () => {
              if (settled) return;
              settled = true;
              resolve();
            };
            finishDashboard = finish;
            const appElement = React.createElement(App, {
              initialData: data,
              agentCatalog: catalog,
              terminals: terminalSummaries,
              daemonConnected: client.connected,
              onLaunchAgent: async (selection: LaunchSelection) => {
                const terminal = await client.start({
                  kind: 'agent',
                  agent: selection.agent,
                  model: selection.model,
                  effort: selection.effort,
                  project: process.cwd(),
                  workspaceId: 'default',
                });
                attachTarget = terminal.id;
                dashboardInk?.unmount();
                finish();
              },
              onLaunchShell: async () => {
                const terminal = await client.start({
                  kind: 'shell',
                  project: process.cwd(),
                  workspaceId: 'default',
                });
                attachTarget = terminal.id;
                dashboardInk?.unmount();
                finish();
              },
              onAttach: (terminalId: string) => {
                attachTarget = terminalId;
                dashboardInk?.unmount();
                finish();
              },
              onRefresh: async () => {
                catalog = await agentCatalog({
                  includeAuthentication: false,
                }).catch(() => catalog);
                dashboardInk?.unmount();
                finish();
              },
              onQuit: () => {
                isRunning = false;
                dashboardInk?.unmount();
                finish();
              },
            });

            dashboardInk = ink.render(appElement, { exitOnCtrlC: false });
            activeInk = dashboardInk;
          });
          if (activeInk === dashboardInk) activeInk = null;
          finishDashboard = null;

          if (!isRunning) break;

          if (attachTarget) {
            try {
              await attachTerminalSession(client, attachTarget, {
                clearOnExit: false,
              });
            } finally {
              // Providers may manage their own alternate screen; normalize back
              // to the primary screen before the dashboard enters a fresh one.
              dashboardActive = true;
              leaveDashboard();
            }
          }
        }
      } finally {
        shutdown();
        process.off('SIGINT', shutdown);
        process.off('SIGTERM', shutdown);
        client.disconnect();
      }
    });
}
