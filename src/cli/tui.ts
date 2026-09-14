import { Command } from 'commander';
import { randomUUID } from 'node:crypto';
import { TerminalDaemonClient } from '../../desktop/terminal-daemon-client.mjs';
import { agentCatalog } from '../agents/registry.js';
import { reconcileProjectRuns } from '../application/reconciliation.js';
import { taskContext } from '../lifecycle.js';
import { resolveCurrentActor } from '../messages/capability.js';
import {
  acknowledgeMessage,
  markMessageRead,
  replyMessage,
  sendMessage,
} from '../messages/service.js';
import { ensureDaemon } from '../platform/daemon-manager.js';
import {
  createApp,
  type NewThreadDraft,
  type ReplyThreadDraft,
  type TerminalSummary,
} from '../tui/app.js';
import { attachTerminalSession } from '../tui/attach.js';
import type { LaunchSelection } from '../tui/launch-options.js';
import { loadDashboardData, loadThreadsData } from '../tui/state.js';
import { parseCanonicalActorRef } from '../tui/threads.js';
import { createWorkspace } from '../worktrees/manager.js';

const ENTER_DASHBOARD = '\x1b[?1049h\x1b[2J\x1b[H\x1b[?25l';
const RESET_DASHBOARD = '\x1b[2J\x1b[H';
const LEAVE_DASHBOARD = '\x1b[?1000l\x1b[?1006l\x1b[?25h\x1b[?1049l';

export async function startTuiAgent(
  client: {
    start(options: Record<string, unknown>): Promise<{
      id: string;
      status: string;
    }>;
  },
  selection: LaunchSelection,
  project: string,
  createIsolatedWorkspace: () => Promise<{ id: string; branch: string }>,
) {
  const request = {
    kind: 'agent',
    agent: selection.agent,
    model: selection.model,
    effort: selection.effort,
    project,
  };
  try {
    return await client.start({ ...request, workspaceId: 'default' });
  } catch (error) {
    if ((error as { code?: string })?.code !== 'claimed') throw error;
  }

  const workspace = await createIsolatedWorkspace();
  return client.start({
    ...request,
    workspaceId: workspace.id,
    branchLabel: workspace.branch,
  });
}

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
      const threadEvents = client as unknown as {
        notifyThreads(details: Record<string, unknown>): Promise<unknown>;
        on(
          event: 'threads_changed',
          listener: (event: {
            projectRoot?: unknown;
            sessionId?: unknown;
          }) => void,
        ): void;
        removeListener(
          event: 'threads_changed',
          listener: (event: {
            projectRoot?: unknown;
            sessionId?: unknown;
          }) => void,
        ): void;
      };

      await client.connect();
      const reconcileCurrentProject = async () => {
        if (!client.daemonId || !client.daemonPid || !client.daemonBootId)
          return;
        const { root } = await taskContext();
        const inventory = await client.refreshInventory();
        await reconcileProjectRuns(root, {
          instanceId: client.daemonId,
          pid: client.daemonPid,
          bootId: client.daemonBootId,
          terminalIds: new Set(
            inventory
              .filter((item) =>
                ['starting', 'running', 'waiting', 'stopping'].includes(
                  item.status,
                ),
              )
              .map((item) => item.id),
          ),
        });
      };
      await reconcileCurrentProject().catch(() => undefined);
      globalThis
        .setTimeout(
          () => void reconcileCurrentProject().catch(() => undefined),
          1_000,
        )
        .unref();
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
      const startAgent = async (selection: LaunchSelection) => {
        return startTuiAgent(client, selection, process.cwd(), async () => {
          const { root, state } = await taskContext();
          const { workspace } = await createWorkspace(root, {
            role: 'implement',
            parentTaskId: state.sessionId,
            slug: state.task.title,
            operationId: randomUUID(),
          });
          return { id: workspace.id, branch: workspace.branch };
        });
      };
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

      let pendingNotification: {
        terminalId: string;
        message?: string;
      } | null = null;

      try {
        while (isRunning) {
          enterDashboard();
          let attachTarget: string | null = null;

          const data = await loadDashboardData(process.cwd());
          const notifyThreads = (details: {
            threadId?: string;
            messageId?: string;
            revision?: number;
          }) => {
            if (!client.connected || !data.threads.projectRoot) return;
            void threadEvents
              .notifyThreads({
                projectRoot: data.threads.projectRoot,
                sessionId: data.threads.sessionId,
                ...details,
              })
              .catch(() => undefined);
          };
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
            const currentNotification = pendingNotification;
            pendingNotification = null;
            const appElement = React.createElement(App, {
              initialData: data,
              agentCatalog: catalog,
              terminals: terminalSummaries,
              daemonConnected: client.connected,
              initialNotification: currentNotification,
              onLaunchAgent: async (selection: LaunchSelection) => {
                const terminal = await startAgent(selection);
                pendingNotification = {
                  terminalId: terminal.id,
                  message: `Session started: ${terminal.id} • Run: relay attach ${terminal.id}`,
                };
                dashboardInk?.unmount();
                finish();
                return { id: terminal.id };
              },
              onLaunchShell: async () => {
                const terminal = await client.start({
                  kind: 'shell',
                  project: process.cwd(),
                  workspaceId: 'default',
                });
                pendingNotification = {
                  terminalId: terminal.id,
                  message: `Session started: ${terminal.id} • Run: relay attach ${terminal.id}`,
                };
                dashboardInk?.unmount();
                finish();
                return { id: terminal.id };
              },
              onAttach: (terminalId: string) => {
                attachTarget = terminalId;
                dashboardInk?.unmount();
                finish();
              },
              onStop: async (terminalId: string) => {
                await client.stop(terminalId);
                dashboardInk?.unmount();
                finish();
              },
              onStopAll: async () => {
                await client.stopAll();
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
              onRefreshThreads: () => loadThreadsData(process.cwd()),
              onSendMessage: async (draft: NewThreadDraft) => {
                const context = await taskContext();
                const actor = await resolveCurrentActor(
                  context.root,
                  context.state,
                );
                const to = parseCanonicalActorRef(draft.to);
                const { message, journal } = await sendMessage(context.root, {
                  sessionId: context.state.sessionId,
                  from: actor,
                  to,
                  intent: draft.intent,
                  body: draft.body,
                  deliveryMode: draft.deliveryMode,
                });
                notifyThreads({
                  threadId: message.threadId,
                  messageId: message.id,
                  revision: journal.revision,
                });
                return loadThreadsData(process.cwd());
              },
              onReplyMessage: async (draft: ReplyThreadDraft) => {
                const context = await taskContext();
                const actor = await resolveCurrentActor(
                  context.root,
                  context.state,
                );
                const { message, journal } = await replyMessage(context.root, {
                  sessionId: context.state.sessionId,
                  parentMessageId: draft.parentMessageId,
                  from: actor,
                  intent: draft.intent,
                  body: draft.body,
                  deliveryMode: draft.deliveryMode,
                });
                notifyThreads({
                  threadId: message.threadId,
                  messageId: message.id,
                  revision: journal.revision,
                });
                return loadThreadsData(process.cwd());
              },
              onMarkMessageRead: async (messageId: string) => {
                const context = await taskContext();
                const actor = await resolveCurrentActor(
                  context.root,
                  context.state,
                );
                const message = await markMessageRead(
                  context.root,
                  context.state.sessionId,
                  messageId,
                  actor,
                );
                notifyThreads({
                  threadId: message.threadId,
                  messageId: message.id,
                });
                return loadThreadsData(process.cwd());
              },
              onAcknowledgeMessage: async (messageId: string) => {
                const context = await taskContext();
                const actor = await resolveCurrentActor(
                  context.root,
                  context.state,
                );
                const message = await acknowledgeMessage(
                  context.root,
                  context.state.sessionId,
                  messageId,
                  actor,
                );
                notifyThreads({
                  threadId: message.threadId,
                  messageId: message.id,
                });
                return loadThreadsData(process.cwd());
              },
              subscribeThreads: (listener: () => void) => {
                const handleChange = (event: {
                  projectRoot?: unknown;
                  sessionId?: unknown;
                }) => {
                  if (
                    event.projectRoot === data.threads.projectRoot &&
                    (!event.sessionId ||
                      event.sessionId === data.threads.sessionId)
                  ) {
                    listener();
                  }
                };
                threadEvents.on('threads_changed', handleChange);
                return () =>
                  threadEvents.removeListener('threads_changed', handleChange);
              },
              onQuit: () => {
                isRunning = false;
                dashboardInk?.unmount();
                finish();
              },
            });

            dashboardInk = ink.render(appElement, { exitOnCtrlC: false });
            activeInk = dashboardInk;
            if (terminalSummaries.some((item) => item.status === 'stopping'))
              globalThis
                .setTimeout(() => {
                  dashboardInk?.unmount();
                  finish();
                }, 250)
                .unref();
          });
          if (activeInk === dashboardInk) activeInk = null;
          finishDashboard = null;

          if (!isRunning) break;

          if (attachTarget) {
            try {
              await attachTerminalSession(client, attachTarget, {
                clearOnExit: false,
                takeover: false,
              });
            } catch (error: unknown) {
              const code =
                typeof error === 'object' && error !== null
                  ? ((error as { code?: string; daemonCode?: string }).code ??
                    (error as { daemonCode?: string }).daemonCode)
                  : undefined;
              if (code === 'control_busy') {
                pendingNotification = {
                  terminalId: attachTarget,
                  message: `Control is held by another client. Attach with: relay attach ${attachTarget} --takeover`,
                };
              } else {
                pendingNotification = {
                  terminalId: attachTarget,
                  message: `Could not attach: ${error instanceof Error ? error.message : String(error)}`,
                };
              }
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
