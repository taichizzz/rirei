import type React from 'react';
import type { DOMElement } from 'ink';
import type { AgentCatalogEntry } from '../agents/registry.js';
import {
  cycleChoice,
  effortChoices,
  type LaunchSelection,
  modelChoices,
  normalizeEffort,
} from './launch-options.js';
import {
  consumeMouseInput,
  containsPoint,
  DISABLE_MOUSE,
  elementBounds,
  ENABLE_MOUSE,
} from './mouse.js';
import type { DashboardData } from './state.js';
import {
  canActOnReceipt,
  canonicalActorRef,
  filterThreadSummaries,
  messagesForThread,
  receiptLabel,
  type CanonicalActorRef,
  type ThreadsData,
} from './threads.js';

export interface NewThreadDraft {
  readonly to: CanonicalActorRef;
  readonly intent: 'request' | 'inform';
  readonly body: string;
  readonly deliveryMode: 'inbox';
}

export interface ReplyThreadDraft {
  readonly parentMessageId: string;
  readonly intent: 'request' | 'inform';
  readonly body: string;
  readonly deliveryMode: 'inbox';
}

export interface TerminalSummary {
  readonly id: string;
  readonly provider: string;
  readonly project: string;
  readonly workspaceId: string;
  readonly branchLabel: string;
  readonly status: string;
  readonly attentionKind?: string | null;
  readonly activeRuntimeSeconds?: number;
  readonly displayLabel?: string;
}

export interface AppProps {
  initialData: DashboardData;
  agentCatalog: AgentCatalogEntry[];
  terminals: TerminalSummary[];
  daemonConnected: boolean;
  initialNotification?:
    { terminalId: string; message?: string } | string | null;
  onLaunchAgent: (
    selection: LaunchSelection,
  ) => Promise<{ id?: string } | void>;
  onLaunchShell: () => Promise<{ id?: string } | void>;
  onAttach: (terminalId: string) => void;
  onStop: (terminalId: string) => Promise<void>;
  onStopAll: () => Promise<void>;
  onRefresh: () => Promise<void>;
  onRefreshThreads: () => Promise<ThreadsData>;
  onSendMessage: (draft: NewThreadDraft) => Promise<ThreadsData>;
  onReplyMessage: (draft: ReplyThreadDraft) => Promise<ThreadsData>;
  onMarkMessageRead: (messageId: string) => Promise<ThreadsData>;
  onAcknowledgeMessage: (messageId: string) => Promise<ThreadsData>;
  subscribeThreads?: (listener: () => void) => () => void;
  onQuit: () => void;
}

const launchActions = [
  { id: 'claude', key: 'c', label: 'Claude' },
  { id: 'codex', key: 'o', label: 'Codex' },
  { id: 'gemini', key: 'g', label: 'Gemini' },
  { id: 'antigravity', key: 'a', label: 'Antigrav' },
  { id: 'opencode', key: 'p', label: 'OpenCode' },
  { id: 'shell', key: 's', label: 'Shell' },
] as const;
const usageActions = launchActions.filter((action) => action.id !== 'shell');
const activeTerminalStatuses = new Set([
  'starting',
  'running',
  'waiting',
  'stopping',
]);

function basename(value: string): string {
  return value.split(/[/\\]/).filter(Boolean).at(-1) ?? value;
}

export function runtimeLabel(seconds = 0): string {
  const totalSeconds = Math.round(seconds);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const remainder = totalSeconds % 60;
  return `${minutes}m ${remainder}s`;
}

export function exactUsageTimestamp(value?: string | null): string {
  if (!value) return 'not reported';
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) return 'invalid timestamp';
  return timestamp.toISOString().replace('.000Z', 'Z');
}

export function compactTimestamp(value: string): string {
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) return 'invalid';
  return timestamp.toISOString().slice(0, 16).replace('T', ' ');
}

export function createApp(
  ink: typeof import('ink'),
  ReactModule: typeof import('react'),
): React.FC<AppProps> {
  const { Box, Text, useInput, useApp, useStdin, useStdout } = ink;
  const { useState, useEffect, useRef } = ReactModule;

  return function App({
    initialData,
    agentCatalog,
    terminals,
    daemonConnected,
    initialNotification,
    onLaunchAgent,
    onLaunchShell,
    onAttach,
    onStop,
    onStopAll,
    onRefresh,
    onRefreshThreads,
    onSendMessage,
    onReplyMessage,
    onMarkMessageRead,
    onAcknowledgeMessage,
    subscribeThreads,
    onQuit,
  }: AppProps) {
    const { exit } = useApp();
    const { stdin, isRawModeSupported } = useStdin();
    const { stdout } = useStdout();
    const [selectedIndex, setSelectedIndex] = useState(0);
    const [selectedAction, setSelectedAction] = useState(0);
    const [focus, setFocus] = useState<'actions' | 'sessions'>(
      terminals.length > 0 ? 'sessions' : 'actions',
    );
    const [feedbackMessage, setFeedbackMessage] = useState<string | null>(null);
    const [notificationCard, setNotificationCard] = useState<{
      terminalId: string;
      message?: string;
    } | null>(
      typeof initialNotification === 'string'
        ? { terminalId: initialNotification }
        : (initialNotification ?? null),
    );
    const [stopConfirmation, setStopConfirmation] = useState<
      'selected' | 'all' | null
    >(null);
    const [launchDraft, setLaunchDraft] = useState<LaunchSelection | null>(
      null,
    );
    const [launchField, setLaunchField] = useState<
      'model' | 'effort' | 'launch'
    >('model');
    const [launchCustomModel, setLaunchCustomModel] = useState('');
    const [usageOpen, setUsageOpen] = useState(false);
    const [selectedUsage, setSelectedUsage] = useState(0);
    const [threadsData, setThreadsData] = useState(initialData.threads);
    const [threadsOpen, setThreadsOpen] = useState(false);
    const [threadView, setThreadView] = useState<
      'list' | 'detail' | 'filter' | 'compose'
    >('list');
    const [selectedThreadIndex, setSelectedThreadIndex] = useState(0);
    const [detailThreadId, setDetailThreadId] = useState<string | null>(null);
    const [selectedMessageIndex, setSelectedMessageIndex] = useState(0);
    const [threadFilter, setThreadFilter] = useState('');
    const [unreadThreadsOnly, setUnreadThreadsOnly] = useState(false);
    const [threadFeedback, setThreadFeedback] = useState<string | null>(null);
    const [composeKind, setComposeKind] = useState<'new' | 'reply'>('new');
    const [composeToIndex, setComposeToIndex] = useState(0);
    const [composeIntent, setComposeIntent] = useState<'request' | 'inform'>(
      'request',
    );
    const [composeBody, setComposeBody] = useState('');
    const [composeField, setComposeField] = useState<
      'to' | 'intent' | 'body' | 'send'
    >('to');
    const [terminalWidth, setTerminalWidth] = useState(stdout.columns ?? 80);
    const [terminalHeight, setTerminalHeight] = useState(stdout.rows ?? 24);
    const launchPending = useRef(false);
    const refreshPending = useRef(false);
    const stopPending = useRef(false);
    const threadPending = useRef(false);
    const controls = useRef(new Map<string, DOMElement>());
    const mouseBuffer = useRef('');
    const activateControl = useRef<(id: string) => void>(() => undefined);
    const wide = terminalWidth >= 96;
    const mouseEnabled = isRawModeSupported && Boolean(stdout.isTTY);
    const activeTerminals = terminals.filter((terminal) =>
      activeTerminalStatuses.has(terminal.status),
    );
    const filteredThreads = filterThreadSummaries(
      threadsData.summaries,
      threadFilter,
      unreadThreadsOnly,
    );
    const listedThread = filteredThreads[selectedThreadIndex];
    const selectedThread =
      detailThreadId &&
      (threadView === 'detail' ||
        (threadView === 'compose' && composeKind === 'reply'))
        ? threadsData.summaries.find(
            (summary) => summary.threadId === detailThreadId,
          )
        : listedThread;
    const selectedThreadMessages = selectedThread
      ? messagesForThread(threadsData, selectedThread.threadId)
      : [];
    const selectedMessage = selectedThreadMessages[selectedMessageIndex];

    const requestStop = (scope: 'selected' | 'all') => {
      if (stopPending.current) return;
      const selected = terminals[selectedIndex];
      if (
        scope === 'selected' &&
        (!selected || !activeTerminalStatuses.has(selected.status))
      ) {
        setFeedbackMessage('Stop failed: no active session selected.');
        return;
      }
      if (scope === 'all' && activeTerminals.length === 0) {
        setFeedbackMessage('Stop failed: no active sessions.');
        return;
      }
      setStopConfirmation(scope);
    };

    const confirmStop = () => {
      if (!stopConfirmation || stopPending.current) return;
      const selected = terminals[selectedIndex];
      const operation =
        stopConfirmation === 'all' ? onStopAll : () => onStop(selected!.id);
      stopPending.current = true;
      setStopConfirmation(null);
      setFeedbackMessage(
        stopConfirmation === 'all'
          ? `Stopping ${activeTerminals.length} sessions...`
          : `Stopping ${selected?.displayLabel ?? selected?.provider ?? 'session'}...`,
      );
      void operation().then(
        () => {
          stopPending.current = false;
          setFeedbackMessage('Stop requested.');
        },
        (error: unknown) => {
          stopPending.current = false;
          setFeedbackMessage(
            `Stop failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        },
      );
    };

    const launch = (
      message: string,
      operation: () => Promise<{ id?: string } | void>,
    ) => {
      if (launchPending.current) return;
      launchPending.current = true;
      setFeedbackMessage(message);
      void operation().then(
        (result) => {
          launchPending.current = false;
          setFeedbackMessage(null);
          if (result && typeof result === 'object' && result.id) {
            setNotificationCard({
              terminalId: result.id,
              message: `Session started: ${result.id} • Run: relay attach ${result.id}`,
            });
          }
        },
        (error: unknown) => {
          launchPending.current = false;
          setFeedbackMessage(
            `Launch failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        },
      );
    };

    const runAction = (id: string) => {
      const action = launchActions.find((item) => item.id === id);
      if (!action) return;
      setFocus('actions');
      setSelectedAction(launchActions.indexOf(action));
      if (action.id === 'shell') {
        launch('Opening shell terminal...', onLaunchShell);
      } else {
        const catalogEntry = agentCatalog.find(
          (entry) => entry.id === action.id,
        );
        if (catalogEntry && !catalogEntry.installed) {
          setFeedbackMessage(
            catalogEntry.installation.status === 'error'
              ? (catalogEntry.installation.detail ??
                  `${catalogEntry.displayName} CLI installation check failed.`)
              : `${catalogEntry.displayName} CLI is not installed.`,
          );
          return;
        }
        setLaunchDraft({ agent: action.id });
        setLaunchCustomModel('');
        setLaunchField('model');
        setFeedbackMessage(null);
      }
    };

    const launchCatalogEntry = launchDraft
      ? agentCatalog.find((entry) => entry.id === launchDraft.agent)
      : undefined;
    const launchModels = modelChoices(launchCatalogEntry);
    const launchEfforts = effortChoices(launchCatalogEntry, launchDraft?.model);
    const cycleLaunchChoice = (field: 'model' | 'effort', delta: number) => {
      setLaunchDraft((current) => {
        if (!current) return current;
        const entry = agentCatalog.find((item) => item.id === current.agent);
        if (field === 'model') {
          const model = cycleChoice(modelChoices(entry), current.model, delta);
          return {
            ...current,
            model,
            effort: normalizeEffort(entry, model, current.effort),
          };
        }
        return {
          ...current,
          effort: cycleChoice(
            effortChoices(entry, current.model),
            current.effort,
            delta,
          ),
        };
      });
    };
    const confirmLaunch = () => {
      if (!launchDraft) return;
      const providerName = launchCatalogEntry?.displayName ?? launchDraft.agent;
      const selection = {
        ...launchDraft,
        model:
          launchDraft.model === '__custom'
            ? launchCustomModel.trim() || undefined
            : launchDraft.model,
      };
      launch(`Launching ${providerName} session...`, () =>
        onLaunchAgent(selection),
      );
    };

    const runThreadOperation = (
      message: string,
      operation: () => Promise<ThreadsData>,
      onSuccess?: (data: ThreadsData) => void,
    ) => {
      if (threadPending.current) return;
      threadPending.current = true;
      setThreadFeedback(message);
      void operation().then(
        (data) => {
          threadPending.current = false;
          setThreadsData(data);
          setThreadFeedback(null);
          onSuccess?.(data);
        },
        (error: unknown) => {
          threadPending.current = false;
          setThreadFeedback(
            `Failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        },
      );
    };

    const openNewMessage = () => {
      if (!threadsData.writable) {
        setThreadFeedback('This task is closed; its threads are read-only.');
        return;
      }
      if (threadsData.peers.length === 0) {
        setThreadFeedback('No active peers are available.');
        return;
      }
      setComposeKind('new');
      setComposeToIndex(0);
      setComposeIntent('request');
      setComposeBody('');
      setComposeField('to');
      setThreadView('compose');
      setThreadFeedback(null);
    };

    const openReply = () => {
      if (!selectedMessage) return;
      if (!threadsData.writable) {
        setThreadFeedback('This task is closed; its threads are read-only.');
        return;
      }
      setComposeKind('reply');
      setComposeIntent('inform');
      setComposeBody('');
      setComposeField('intent');
      setThreadView('compose');
      setThreadFeedback(null);
    };

    const submitCompose = () => {
      const body = composeBody.trim();
      if (!body) {
        setThreadFeedback('Message body is required.');
        setComposeField('body');
        return;
      }
      if (composeKind === 'new') {
        const peer = threadsData.peers[composeToIndex];
        if (!peer || !peer.deliveryModes.includes('inbox')) {
          setThreadFeedback('Inbox delivery is unavailable for this peer.');
          return;
        }
        runThreadOperation(
          `Sending to ${peer.ref}...`,
          () =>
            onSendMessage({
              to: peer.ref,
              intent: composeIntent,
              body,
              deliveryMode: 'inbox',
            }),
          () => {
            setThreadView('list');
            setDetailThreadId(null);
            setSelectedThreadIndex(0);
            setComposeBody('');
          },
        );
        return;
      }
      if (!selectedMessage) return;
      const threadId = selectedMessage.threadId;
      runThreadOperation(
        'Sending reply...',
        () =>
          onReplyMessage({
            parentMessageId: selectedMessage.id,
            intent: composeIntent,
            body,
            deliveryMode: 'inbox',
          }),
        (data) => {
          setThreadView('detail');
          setComposeBody('');
          setSelectedMessageIndex(
            Math.max(0, messagesForThread(data, threadId).length - 1),
          );
        },
      );
    };

    activateControl.current = (id) => {
      if (id === 'stop:selected') {
        requestStop('selected');
        return;
      }
      if (id === 'stop:all') {
        requestStop('all');
        return;
      }
      if (id === 'threads') {
        setThreadsOpen(true);
        setThreadView('list');
        setThreadFeedback(null);
        return;
      }
      if (id === 'threads:back') {
        if (threadView === 'list') setThreadsOpen(false);
        else setThreadView('list');
        return;
      }
      if (id === 'threads:new') {
        openNewMessage();
        return;
      }
      if (id.startsWith('threads:open:')) {
        const threadId = id.slice('threads:open:'.length);
        const index = filteredThreads.findIndex(
          (summary) => summary.threadId === threadId,
        );
        if (index >= 0) {
          const messages = messagesForThread(threadsData, threadId);
          setSelectedThreadIndex(index);
          setDetailThreadId(threadId);
          setSelectedMessageIndex(Math.max(0, messages.length - 1));
          setThreadView('detail');
        }
        return;
      }
      if (id === 'launch:model') {
        setLaunchField('model');
        cycleLaunchChoice('model', 1);
        return;
      }
      if (id === 'launch:effort') {
        setLaunchField('effort');
        cycleLaunchChoice('effort', 1);
        return;
      }
      if (id === 'launch:confirm') {
        setLaunchField('launch');
        confirmLaunch();
        return;
      }
      if (id === 'launch:cancel') {
        setLaunchDraft(null);
        setFeedbackMessage(null);
        return;
      }
      if (id === 'usage') {
        setUsageOpen(true);
        setSelectedUsage(0);
        setFeedbackMessage(null);
        return;
      }
      if (id === 'usage:back') {
        setUsageOpen(false);
        return;
      }
      if (id.startsWith('usage:provider:')) {
        const index = Number(id.slice('usage:provider:'.length));
        if (
          Number.isInteger(index) &&
          index >= 0 &&
          index < usageActions.length
        )
          setSelectedUsage(index);
        return;
      }
      if (id === 'refresh') {
        if (refreshPending.current) return;
        refreshPending.current = true;
        setFeedbackMessage('Refreshing workspace and provider models...');
        void onRefresh().then(
          () => {
            refreshPending.current = false;
          },
          (error: unknown) => {
            refreshPending.current = false;
            setFeedbackMessage(
              `Refresh failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          },
        );
        return;
      }
      if (id === 'quit') {
        onQuit();
        exit();
        return;
      }
      if (id.startsWith('session:')) {
        const terminalId = id.slice('session:'.length);
        const index = terminals.findIndex((item) => item.id === terminalId);
        if (index >= 0) {
          setFocus('sessions');
          setSelectedIndex(index);
          onAttach(terminalId);
        }
        return;
      }
      runAction(id);
    };

    useEffect(() => {
      const resize = () => {
        setTerminalWidth(stdout.columns ?? 80);
        setTerminalHeight(stdout.rows ?? 24);
      };
      stdout.on('resize', resize);
      return () => {
        stdout.off('resize', resize);
      };
    }, [stdout]);

    useEffect(() => {
      if (terminals.length > 0 && selectedIndex >= terminals.length) {
        setSelectedIndex(terminals.length - 1);
      }
    }, [terminals.length, selectedIndex]);

    useEffect(() => {
      if (selectedThreadIndex >= filteredThreads.length) {
        setSelectedThreadIndex(Math.max(0, filteredThreads.length - 1));
      }
    }, [filteredThreads.length, selectedThreadIndex]);

    useEffect(() => {
      if (selectedMessageIndex >= selectedThreadMessages.length) {
        setSelectedMessageIndex(Math.max(0, selectedThreadMessages.length - 1));
      }
    }, [selectedMessageIndex, selectedThreadMessages.length]);

    useEffect(() => {
      if (!subscribeThreads) return;
      return subscribeThreads(() => {
        if (threadPending.current) return;
        threadPending.current = true;
        void onRefreshThreads().then(
          (data) => {
            threadPending.current = false;
            setThreadsData(data);
          },
          () => {
            threadPending.current = false;
          },
        );
      });
    }, [onRefreshThreads, subscribeThreads]);

    useEffect(() => {
      if (!mouseEnabled) return;
      stdout.write(ENABLE_MOUSE);
      const handleMouse = (chunk: Buffer | string) => {
        const parsed = consumeMouseInput(
          mouseBuffer.current + chunk.toString(),
        );
        mouseBuffer.current = parsed.remainder;
        for (const event of parsed.events) {
          if (event.button !== 'left' || event.action !== 'press') continue;
          for (const [id, element] of controls.current) {
            const bounds = elementBounds(element);
            if (bounds && containsPoint(bounds, event.x, event.y)) {
              activateControl.current(id);
              break;
            }
          }
        }
      };
      stdin.on('data', handleMouse);
      return () => {
        stdin.off('data', handleMouse);
        mouseBuffer.current = '';
        stdout.write(DISABLE_MOUSE);
      };
    }, [mouseEnabled, stdin, stdout]);

    useInput((input, key) => {
      if (key.ctrl && input === 'c') {
        activateControl.current('quit');
        return;
      }

      if (notificationCard && key.escape) {
        setNotificationCard(null);
        return;
      }

      if (stopConfirmation) {
        if (key.escape || input === 'q' || input === 'n')
          setStopConfirmation(null);
        else if (key.return || input === 'y') confirmStop();
        return;
      }

      if (threadsOpen) {
        if (threadView === 'filter') {
          if (key.escape) {
            setThreadView('list');
          } else if (key.return) {
            setSelectedThreadIndex(0);
            setThreadView('list');
          } else if (key.backspace || key.delete) {
            setThreadFilter((current) => current.slice(0, -1));
          } else if (key.ctrl && input === 'u') {
            setThreadFilter('');
          } else if (input && !key.ctrl && !key.meta) {
            setThreadFilter((current) => (current + input).slice(0, 120));
          }
          return;
        }

        if (threadView === 'compose') {
          if (key.escape) {
            setThreadView(composeKind === 'reply' ? 'detail' : 'list');
            setThreadFeedback(null);
            return;
          }
          const fields: Array<'to' | 'intent' | 'body' | 'send'> =
            composeKind === 'new'
              ? ['to', 'intent', 'body', 'send']
              : ['intent', 'body', 'send'];
          if (composeField === 'body') {
            if (key.backspace || key.delete) {
              setComposeBody((current) => current.slice(0, -1));
            } else if (key.return) {
              submitCompose();
            } else if (key.tab || key.downArrow) {
              setComposeField('send');
            } else if (key.upArrow) {
              setComposeField('intent');
            } else if (input && !key.ctrl && !key.meta) {
              setComposeBody((current) => (current + input).slice(0, 4000));
            }
            return;
          }
          if (key.tab || key.upArrow || key.downArrow) {
            const index = Math.max(0, fields.indexOf(composeField));
            const delta = key.upArrow ? -1 : 1;
            setComposeField(
              fields[(index + delta + fields.length) % fields.length]!,
            );
            return;
          }
          if (key.leftArrow || key.rightArrow || key.return) {
            const delta = key.leftArrow ? -1 : 1;
            if (composeField === 'to' && threadsData.peers.length > 0) {
              setComposeToIndex(
                (current) =>
                  (current + delta + threadsData.peers.length) %
                  threadsData.peers.length,
              );
            } else if (composeField === 'intent') {
              setComposeIntent((current) =>
                current === 'request' ? 'inform' : 'request',
              );
            } else if (composeField === 'send' && key.return) {
              submitCompose();
            }
          }
          return;
        }

        if (threadView === 'detail') {
          if (input === 'b' || input === 'q' || key.escape) {
            setThreadView('list');
          } else if (input === 'n') {
            openNewMessage();
          } else if (input === 'r') {
            openReply();
          } else if (input === 'm' && selectedMessage) {
            if (!threadsData.writable) {
              setThreadFeedback('This task is closed; receipts are read-only.');
            } else if (!canActOnReceipt(selectedMessage, threadsData.actor)) {
              setThreadFeedback(
                'Only the recipient can mark this message read.',
              );
            } else if (selectedMessage.delivery.readAt) {
              setThreadFeedback('Message is already read.');
            } else {
              runThreadOperation('Marking message read...', () =>
                onMarkMessageRead(selectedMessage.id),
              );
            }
          } else if (input === 'a' && selectedMessage) {
            if (!threadsData.writable) {
              setThreadFeedback('This task is closed; receipts are read-only.');
            } else if (!canActOnReceipt(selectedMessage, threadsData.actor)) {
              setThreadFeedback(
                'Only the recipient can acknowledge this message.',
              );
            } else if (selectedMessage.delivery.acknowledgedAt) {
              setThreadFeedback('Message is already acknowledged.');
            } else {
              runThreadOperation('Acknowledging message...', () =>
                onAcknowledgeMessage(selectedMessage.id),
              );
            }
          } else if (input === 'g') {
            runThreadOperation('Refreshing threads...', onRefreshThreads);
          } else if (key.upArrow || key.downArrow) {
            if (selectedThreadMessages.length === 0) return;
            setSelectedMessageIndex((current) => {
              const delta = key.upArrow ? -1 : 1;
              return (
                (current + delta + selectedThreadMessages.length) %
                selectedThreadMessages.length
              );
            });
          }
          return;
        }

        if (input === 'b' || input === 'q' || input === 'm' || key.escape) {
          setThreadsOpen(false);
        } else if (input === 'n') {
          openNewMessage();
        } else if (input === '/') {
          setThreadView('filter');
        } else if (input === 'i') {
          setUnreadThreadsOnly((current) => !current);
          setSelectedThreadIndex(0);
        } else if (input === 'x') {
          setThreadFilter('');
          setUnreadThreadsOnly(false);
          setSelectedThreadIndex(0);
        } else if (input === 'r') {
          runThreadOperation('Refreshing threads...', onRefreshThreads);
        } else if (key.upArrow || key.downArrow) {
          if (filteredThreads.length === 0) return;
          setSelectedThreadIndex((current) => {
            const delta = key.upArrow ? -1 : 1;
            return (
              (current + delta + filteredThreads.length) %
              filteredThreads.length
            );
          });
        } else if (key.return && selectedThread) {
          setDetailThreadId(selectedThread.threadId);
          setSelectedMessageIndex(
            Math.max(0, selectedThreadMessages.length - 1),
          );
          setThreadView('detail');
          setThreadFeedback(null);
        }
        return;
      }

      if (usageOpen) {
        if (input === 'q' || input === 'b' || input === 'u') {
          activateControl.current('usage:back');
        } else if (input === 'r') {
          activateControl.current('refresh');
        } else if (key.upArrow || key.downArrow) {
          setSelectedUsage((current) => {
            const delta = key.upArrow ? -1 : 1;
            return (
              (current + delta + usageActions.length) % usageActions.length
            );
          });
        }
        return;
      }

      if (launchDraft) {
        if (launchDraft.model === '__custom' && launchField === 'model') {
          if (key.escape) {
            setLaunchDraft({ ...launchDraft, model: undefined });
            setLaunchCustomModel('');
          } else if (key.leftArrow || key.rightArrow) {
            cycleLaunchChoice('model', key.leftArrow ? -1 : 1);
          } else if (key.backspace || key.delete) {
            setLaunchCustomModel((current) => current.slice(0, -1));
          } else if (key.return || key.tab || key.downArrow) {
            setLaunchField(launchEfforts.length > 1 ? 'effort' : 'launch');
          } else if (input && !key.ctrl && !key.meta) {
            setLaunchCustomModel((current) => (current + input).slice(0, 120));
          }
          return;
        }
        if (input === 'q' || input === 'b') {
          activateControl.current('launch:cancel');
          return;
        }
        if (input === 'l') {
          confirmLaunch();
          return;
        }
        const fields: Array<'model' | 'effort' | 'launch'> =
          launchEfforts.length > 1
            ? ['model', 'effort', 'launch']
            : ['model', 'launch'];
        if (key.upArrow || key.downArrow || key.tab) {
          const current = Math.max(0, fields.indexOf(launchField));
          const delta = key.upArrow ? -1 : 1;
          setLaunchField(
            fields[(current + delta + fields.length) % fields.length]!,
          );
          return;
        }
        if (key.leftArrow || key.rightArrow) {
          if (launchField !== 'launch')
            cycleLaunchChoice(launchField, key.leftArrow ? -1 : 1);
          return;
        }
        if (key.return) {
          if (launchField === 'launch') confirmLaunch();
          else cycleLaunchChoice(launchField, 1);
        }
        return;
      }

      if (input === 'q') {
        activateControl.current('quit');
        return;
      }

      if (input === 'r') {
        activateControl.current('refresh');
        return;
      }

      if (input === 'u') {
        activateControl.current('usage');
        return;
      }

      if (input === 'm') {
        activateControl.current('threads');
        return;
      }

      if (input === 'X') {
        requestStop('all');
        return;
      }

      if (input === 'x' && focus === 'sessions') {
        requestStop('selected');
        return;
      }

      const action = launchActions.find((item) => item.key === input);
      if (action) {
        runAction(action.id);
        return;
      }

      if (key.tab) {
        setFocus((current) =>
          current === 'actions' && terminals.length > 0
            ? 'sessions'
            : 'actions',
        );
        return;
      }

      if (key.leftArrow || key.rightArrow) {
        setFocus('actions');
        setSelectedAction((current) => {
          const delta = key.leftArrow ? -1 : 1;
          return (
            (current + delta + launchActions.length) % launchActions.length
          );
        });
        return;
      }

      if (key.upArrow || key.downArrow) {
        if (terminals.length === 0) return;
        setFocus('sessions');
        setSelectedIndex((current) => {
          const delta = key.upArrow ? -1 : 1;
          return (current + delta + terminals.length) % terminals.length;
        });
        return;
      }

      if (key.return) {
        if (focus === 'actions') {
          runAction(launchActions[selectedAction]!.id);
        } else if (terminals[selectedIndex]) {
          onAttach(terminals[selectedIndex].id);
        }
      }
    });

    const controlRef = (id: string) => (element: DOMElement | null) => {
      if (element) controls.current.set(id, element);
      else controls.current.delete(id);
    };

    const renderStatus = (status: string, attention?: string | null) => {
      if (status === 'running') return <Text color="green">RUNNING</Text>;
      if (status === 'waiting') {
        return (
          <Text bold color="yellow">
            {attention ? `NEEDS ${attention.toUpperCase()}` : 'WAITING'}
          </Text>
        );
      }
      if (status === 'starting') return <Text color="yellow">STARTING</Text>;
      if (status === 'stopping') return <Text color="red">STOPPING</Text>;
      return <Text color="gray">{status.toUpperCase()}</Text>;
    };

    const renderRemaining = (
      percent: number | null,
      width = 8,
      status?: 'available' | 'stale',
    ) => {
      if (percent === null || Number.isNaN(percent)) {
        return <Text color="gray">{'·'.repeat(width)} --</Text>;
      }
      const filled = Math.min(
        width,
        Math.max(0, Math.round((percent / 100) * width)),
      );
      const color =
        status === 'stale'
          ? 'gray'
          : percent < 20
            ? 'red'
            : percent < 50
              ? 'yellow'
              : 'green';
      return (
        <Text>
          <Text color={color}>{'━'.repeat(filled)}</Text>
          <Text color="gray">{'·'.repeat(width - filled)}</Text>{' '}
          <Text color={color}>{String(Math.round(percent)).padStart(3)}%</Text>
          {status === 'stale' ? (
            <Text color="gray">{width >= 8 ? ' STALE' : '~'}</Text>
          ) : null}
        </Text>
      );
    };

    if (stopConfirmation) {
      const selected = terminals[selectedIndex];
      const count =
        stopConfirmation === 'all' ? activeTerminals.length : selected ? 1 : 0;
      return (
        <Box
          flexDirection="column"
          width={Math.max(1, terminalWidth - 1)}
          height={Math.max(1, terminalHeight)}
          justifyContent="center"
          alignItems="center"
          paddingX={2}
        >
          <Box
            flexDirection="column"
            borderStyle="round"
            borderColor="red"
            paddingX={2}
            paddingY={1}
          >
            <Text bold color="red">
              {stopConfirmation === 'all'
                ? 'STOP ALL SESSIONS?'
                : 'STOP SESSION?'}
            </Text>
            <Text>
              {stopConfirmation === 'all'
                ? `Stop ${count} active session${count === 1 ? '' : 's'} on this device?`
                : `Stop ${selected?.displayLabel ?? selected?.provider ?? 'the selected session'}?`}
            </Text>
            <Text color="gray">ENTER / Y confirm ESC / N cancel</Text>
          </Box>
        </Box>
      );
    }

    const usageReasonLabels: Record<string, string> = {
      live_window: 'LIVE',
      not_collected: 'NOT COLLECTED',
      unsupported_auth: 'AUTH-SPECIFIC',
      unsupported_provider: 'UNSUPPORTED',
      collector_error: 'READ ERROR',
      all_windows_stale: 'STALE',
    };

    if (threadsOpen) {
      const availableRows = Math.max(1, terminalHeight - 8);
      const threadRowHeight = terminalWidth < 64 ? 3 : 2;
      const threadLimit = Math.max(
        1,
        Math.min(10, Math.floor(availableRows / threadRowHeight)),
      );
      const threadOffset = Math.min(
        Math.max(0, selectedThreadIndex - Math.floor(threadLimit / 2)),
        Math.max(0, filteredThreads.length - threadLimit),
      );
      const visibleThreads = filteredThreads.slice(
        threadOffset,
        threadOffset + threadLimit,
      );
      const selectedPeer = threadsData.peers[composeToIndex];
      const receiptActionAvailable = canActOnReceipt(
        selectedMessage,
        threadsData.actor,
      );

      return (
        <Box
          flexDirection="column"
          width={Math.max(1, terminalWidth - 1)}
          height={Math.max(1, terminalHeight)}
          overflow="hidden"
          paddingX={1}
        >
          <Box
            justifyContent="space-between"
            borderStyle="single"
            borderTop={false}
            borderLeft={false}
            borderRight={false}
            borderColor="gray"
            paddingY={1}
            flexShrink={0}
            overflow="hidden"
          >
            <Box flexDirection="column" flexShrink={1} overflow="hidden">
              <Text bold color="cyan" wrap="truncate-end">
                RELAY <Text color="white">THREADS</Text>
              </Text>
              <Text color="gray" wrap="truncate-end">
                ACTOR {threadsData.actorRef} / INBOX DELIVERY
              </Text>
            </Box>
            <Box flexDirection="column" alignItems="flex-end" flexShrink={0}>
              <Text
                bold={threadsData.unreadCount > 0}
                color={threadsData.unreadCount > 0 ? 'yellow' : 'gray'}
              >
                {threadsData.unreadCount} UNREAD
              </Text>
              <Text color={threadsData.status === 'ready' ? 'green' : 'red'}>
                {threadsData.status.toUpperCase()}
              </Text>
            </Box>
          </Box>

          {threadView === 'compose' ? (
            <Box
              flexDirection="column"
              borderStyle="round"
              borderColor="cyan"
              paddingX={1}
              marginTop={1}
              flexGrow={1}
              overflow="hidden"
            >
              <Text bold>
                {composeKind === 'new' ? 'NEW MESSAGE' : 'REPLY'}
              </Text>
              <Text color="gray" wrap="truncate-end">
                {composeKind === 'reply' && selectedMessage
                  ? `THREAD thread:${selectedMessage.threadId}`
                  : 'Start a new inbox thread'}
              </Text>
              {composeKind === 'new' ? (
                <Box justifyContent="space-between" overflow="hidden">
                  <Text
                    bold={composeField === 'to'}
                    color={composeField === 'to' ? 'cyan' : 'white'}
                  >
                    {composeField === 'to' ? '> ' : '  '}TO
                  </Text>
                  <Text wrap="truncate-end">
                    {'< '} {selectedPeer?.ref ?? 'no peers'} {' >'}
                  </Text>
                </Box>
              ) : null}
              <Box justifyContent="space-between" overflow="hidden">
                <Text
                  bold={composeField === 'intent'}
                  color={composeField === 'intent' ? 'cyan' : 'white'}
                >
                  {composeField === 'intent' ? '> ' : '  '}INTENT
                </Text>
                <Text>
                  {'< '} {composeIntent.toUpperCase()} {' >'}
                </Text>
              </Box>
              <Box justifyContent="space-between" overflow="hidden">
                <Text color="gray">DELIVERY</Text>
                <Text color="green">INBOX ONLY</Text>
              </Box>
              <Box
                flexDirection="column"
                borderStyle="single"
                borderColor={composeField === 'body' ? 'cyan' : 'gray'}
                paddingX={1}
                marginTop={1}
                flexGrow={1}
                overflow="hidden"
              >
                <Text
                  bold={composeField === 'body'}
                  color={composeField === 'body' ? 'cyan' : 'gray'}
                >
                  {composeField === 'body' ? '> ' : ''}BODY {composeBody.length}
                  /4000
                </Text>
                <Text wrap="wrap">
                  {composeBody || 'Type a message...'}
                  {composeField === 'body' ? <Text inverse> </Text> : null}
                </Text>
              </Box>
              <Text
                bold={composeField === 'send'}
                color={composeField === 'send' ? 'cyan' : 'white'}
              >
                {composeField === 'send' ? '> ' : '  '}SEND TO INBOX
              </Text>
            </Box>
          ) : threadView === 'detail' ? (
            <Box
              flexDirection="column"
              borderStyle="round"
              borderColor="cyan"
              paddingX={1}
              marginTop={1}
              flexGrow={1}
              overflow="hidden"
            >
              {selectedThread && selectedMessage ? (
                <>
                  <Box justifyContent="space-between" overflow="hidden">
                    <Text bold wrap="truncate-end">
                      THREAD thread:{selectedThread.threadId}
                    </Text>
                    <Box flexShrink={0}>
                      <Text color="gray">
                        {selectedMessageIndex + 1}/
                        {selectedThreadMessages.length}
                      </Text>
                    </Box>
                  </Box>
                  <Text color="gray" wrap="truncate-end">
                    msg:{selectedMessage.id} / #{selectedMessage.sequence} /{' '}
                    {compactTimestamp(selectedMessage.createdAt)}
                  </Text>
                  <Text wrap="truncate-end">
                    <Text color="cyan">
                      {canonicalActorRef(selectedMessage.from)}
                    </Text>{' '}
                    {'->'}{' '}
                    <Text color="cyan">
                      {canonicalActorRef(selectedMessage.to)}
                    </Text>{' '}
                    / {selectedMessage.intent.toUpperCase()}
                  </Text>
                  <Box
                    flexDirection="column"
                    borderStyle="single"
                    borderColor="gray"
                    paddingX={1}
                    marginTop={1}
                    flexGrow={1}
                    overflow="hidden"
                  >
                    <Text wrap="wrap">{selectedMessage.body}</Text>
                  </Box>
                  <Text color="gray" wrap="truncate-end">
                    RECEIPT {receiptLabel(selectedMessage)} / ATTEMPTS{' '}
                    {selectedMessage.delivery.attemptCount}
                  </Text>
                  {selectedMessage.contextCards.length > 0 ? (
                    <Text color="gray" wrap="truncate-end">
                      CONTEXT {selectedMessage.contextCards.length} card(s):{' '}
                      {selectedMessage.contextCards
                        .map((card) => card.title)
                        .join(', ')}
                    </Text>
                  ) : null}
                </>
              ) : (
                <Text color="gray">This thread has no visible messages.</Text>
              )}
            </Box>
          ) : (
            <Box
              flexDirection="column"
              borderStyle="round"
              borderColor="gray"
              paddingX={1}
              marginTop={1}
              flexGrow={1}
              overflow="hidden"
            >
              <Box justifyContent="space-between" overflow="hidden">
                <Text bold>THREAD LIST</Text>
                <Text color="gray">
                  {filteredThreads.length}/{threadsData.summaries.length}{' '}
                  {unreadThreadsOnly ? 'UNREAD ONLY' : 'ALL'}
                </Text>
              </Box>
              {threadView === 'filter' || threadFilter ? (
                <Text color={threadView === 'filter' ? 'cyan' : 'gray'}>
                  FILTER /{threadFilter}
                  {threadView === 'filter' ? <Text inverse> </Text> : null}
                </Text>
              ) : null}
              {threadsData.status === 'unavailable' ? (
                <Text color="red" wrap="wrap">
                  {threadsData.error}
                </Text>
              ) : visibleThreads.length === 0 ? (
                <Text color="gray">
                  {threadsData.summaries.length === 0
                    ? 'No threads yet. Press N to compose.'
                    : 'No threads match this filter.'}
                </Text>
              ) : (
                visibleThreads.map((summary, visibleIndex) => {
                  const index = threadOffset + visibleIndex;
                  const selected = index === selectedThreadIndex;
                  return (
                    <Box
                      key={summary.threadId}
                      ref={controlRef(`threads:open:${summary.threadId}`)}
                      flexDirection="column"
                      height={threadRowHeight}
                      overflow="hidden"
                    >
                      <Box justifyContent="space-between" overflow="hidden">
                        <Text
                          bold={selected}
                          color={selected ? 'cyan' : 'white'}
                          wrap="truncate-end"
                        >
                          {selected ? '> ' : '  '}
                          {summary.participants
                            .map(canonicalActorRef)
                            .join(' <-> ')}
                        </Text>
                        <Box flexShrink={0}>
                          <Text
                            color={summary.unreadCount > 0 ? 'yellow' : 'gray'}
                          >
                            {summary.unreadCount > 0
                              ? `${summary.unreadCount} NEW`
                              : `${summary.messageCount} MSG`}
                          </Text>
                        </Box>
                      </Box>
                      <Text color="gray" wrap="truncate-end">
                        {summary.intent.toUpperCase()} /{' '}
                        {summary.deliveryState.toUpperCase()} /{' '}
                        {summary.latestExcerpt}
                      </Text>
                      {terminalWidth < 64 ? (
                        <Text color="gray" wrap="truncate-end">
                          thread:{summary.threadId}
                        </Text>
                      ) : null}
                    </Box>
                  );
                })
              )}
            </Box>
          )}

          <Box height={1} flexShrink={0} overflow="hidden" paddingX={1}>
            <Text
              color={threadFeedback?.startsWith('Failed:') ? 'red' : 'yellow'}
              wrap="truncate-end"
            >
              {threadFeedback ?? ' '}
            </Text>
          </Box>
          <Box
            justifyContent="space-between"
            height={1}
            flexShrink={0}
            overflow="hidden"
          >
            <Text color="gray" wrap="truncate-end">
              {threadView === 'compose'
                ? 'TAB fields  ARROWS choose  ENTER send  ESC cancel'
                : threadView === 'detail'
                  ? `UP/DOWN messages  R reply${receiptActionAvailable ? '  M read  A ack' : ''}  G refresh`
                  : threadView === 'filter'
                    ? 'TYPE filter  ENTER apply  ESC cancel  CTRL+U clear'
                    : 'UP/DOWN move  ENTER open  / filter  I unread  N new  R refresh'}
            </Text>
            <Box ref={controlRef('threads:back')} flexShrink={0}>
              <Text bold color="cyan">
                B BACK
              </Text>
            </Box>
          </Box>
        </Box>
      );
    }

    if (usageOpen) {
      const selectedAction = usageActions[selectedUsage] ?? usageActions[0];
      const selectedPlan = selectedAction
        ? initialData.planUsage[selectedAction.id]
        : undefined;
      const metricResets =
        selectedPlan?.metrics
          .filter((metric) => metric.resetsAt)
          .slice(0, 2)
          .map(
            (metric) =>
              `${metric.window?.label ?? metric.id} ${exactUsageTimestamp(metric.resetsAt)}`,
          ) ?? [];
      const resetSummary =
        metricResets.length > 0
          ? metricResets.join(' / ')
          : [
              selectedPlan?.fiveHour?.resetsAt
                ? `5H ${exactUsageTimestamp(selectedPlan.fiveHour.resetsAt)}`
                : null,
              selectedPlan?.week?.resetsAt
                ? `7D ${exactUsageTimestamp(selectedPlan.week.resetsAt)}`
                : null,
            ]
              .filter(Boolean)
              .join(' / ') || 'not reported';
      return (
        <Box
          flexDirection="column"
          width={Math.max(1, terminalWidth - 1)}
          height={Math.max(1, terminalHeight)}
          overflow="hidden"
          paddingX={1}
        >
          <Box
            justifyContent="space-between"
            borderStyle="single"
            borderTop={false}
            borderLeft={false}
            borderRight={false}
            borderColor="gray"
            paddingY={1}
            flexShrink={0}
          >
            <Box flexDirection="column">
              <Text bold color="cyan">
                PLAN <Text color="white">REMAINING</Text>
              </Text>
              <Text color="gray">Verified provider quota windows only</Text>
            </Box>
            <Text color="gray">5H / 7D</Text>
          </Box>

          <Box flexDirection="column" flexGrow={1} overflow="hidden">
            {usageActions.map((action, index) => {
              const usage = initialData.planUsage[action.id];
              const hasWindows = Boolean(usage?.fiveHour || usage?.week);
              const metrics = usage?.metrics.slice(0, 2) ?? [];
              const status = usage
                ? (usageReasonLabels[usage.statusReason] ??
                  usage.status.toUpperCase())
                : 'UNAVAILABLE';
              const statusColor =
                usage?.status === 'available'
                  ? 'green'
                  : usage?.status === 'error'
                    ? 'red'
                    : 'yellow';
              return (
                <Box
                  key={action.id}
                  ref={controlRef(`usage:provider:${index}`)}
                  flexDirection="column"
                  height={3}
                  overflow="hidden"
                  borderStyle="single"
                  borderTop={false}
                  borderLeft={false}
                  borderRight={false}
                  borderColor={index === selectedUsage ? 'cyan' : 'gray'}
                  paddingX={1}
                >
                  <Box justifyContent="space-between" height={1}>
                    <Text wrap="truncate-end">
                      <Text bold>
                        {index === selectedUsage ? '> ' : '  '}
                        {action.label.toUpperCase()}
                      </Text>
                      <Text color="gray">
                        {' '}
                        / {usage?.source ?? 'Unavailable'}
                      </Text>
                    </Text>
                    <Text color={statusColor}>{status}</Text>
                  </Box>
                  {metrics.length > 0 ? (
                    <Box justifyContent="space-between" height={1}>
                      {metrics.map((metric) => {
                        const remaining =
                          metric.remaining ??
                          (metric.unit === 'percent' &&
                          metric.used !== undefined
                            ? 100 - metric.used
                            : null);
                        return (
                          <Text key={metric.id} wrap="truncate-end">
                            {metric.window?.label ?? metric.id}{' '}
                            {metric.unit === 'percent' ? (
                              renderRemaining(remaining, 8, metric.status)
                            ) : (
                              <Text color="cyan">
                                {remaining ?? '--'} {metric.unit} left
                                {metric.status === 'stale' ? ' STALE' : ''}
                              </Text>
                            )}
                          </Text>
                        );
                      })}
                    </Box>
                  ) : hasWindows ? (
                    <Box justifyContent="space-between" height={1}>
                      <Text>
                        5H{' '}
                        {renderRemaining(
                          usage?.fiveHour?.remainingPercentage ?? null,
                          10,
                          usage?.fiveHour?.status,
                        )}
                      </Text>
                      <Text>
                        7D{' '}
                        {renderRemaining(
                          usage?.week?.remainingPercentage ?? null,
                          10,
                          usage?.week?.status,
                        )}
                      </Text>
                    </Box>
                  ) : (
                    <Text color="gray" wrap="truncate-end">
                      {usage?.detail ??
                        'No verified usage source is available.'}
                    </Text>
                  )}
                </Box>
              );
            })}
          </Box>

          <Box flexDirection="column" height={2} flexShrink={0} paddingX={1}>
            {feedbackMessage ? (
              <Text color="yellow" wrap="truncate-end">
                {feedbackMessage}
              </Text>
            ) : (
              <Text color="gray" wrap="truncate-end">
                UPDATED {exactUsageTimestamp(selectedPlan?.capturedAt)}
              </Text>
            )}
            <Text color="gray" wrap="truncate-end">
              RESETS {resetSummary}
            </Text>
          </Box>

          <Box justifyContent="space-between" height={1} flexShrink={0}>
            <Text color="gray">UP/DOWN inspect {'  '} R refresh</Text>
            <Box ref={controlRef('usage:back')}>
              <Text bold color="cyan">
                B BACK
              </Text>
            </Box>
          </Box>
        </Box>
      );
    }

    if (launchDraft) {
      const providerName =
        launchCatalogEntry?.displayName ?? launchDraft.agent.toUpperCase();
      const modelLabel =
        launchDraft.model === '__custom'
          ? `Custom: ${launchCustomModel || 'type model ID'}`
          : (launchModels.find(
              (choice) => choice.id === (launchDraft.model ?? ''),
            )?.label ??
            launchDraft.model ??
            'Auto (provider default)');
      const effortLabel =
        launchEfforts.find((choice) => choice.id === (launchDraft.effort ?? ''))
          ?.label ??
        launchDraft.effort ??
        'Auto (provider default)';
      const modelDetail = launchCatalogEntry?.models.detail
        ? launchCatalogEntry.models.detail
        : `Model source: ${launchCatalogEntry?.models.source ?? 'catalog unavailable'}`;
      return (
        <Box
          flexDirection="column"
          width={Math.max(1, terminalWidth - 1)}
          height={Math.max(1, terminalHeight)}
          overflow="hidden"
          paddingX={1}
        >
          <Box
            justifyContent="space-between"
            borderStyle="single"
            borderTop={false}
            borderLeft={false}
            borderRight={false}
            borderColor="gray"
            paddingY={1}
            flexShrink={0}
          >
            <Box flexDirection="column">
              <Text bold color="cyan">
                CONFIGURE <Text color="white">{providerName}</Text>
              </Text>
              <Text color="gray">Session-only launch settings</Text>
            </Box>
            <Text
              color={
                !launchCatalogEntry || launchCatalogEntry.installed === false
                  ? 'red'
                  : 'green'
              }
            >
              {!launchCatalogEntry
                ? 'CATALOG UNAVAILABLE'
                : launchCatalogEntry.installed === false
                  ? 'CLI NOT INSTALLED'
                  : `MODELS ${launchCatalogEntry.models.status.toUpperCase()}`}
            </Text>
          </Box>

          <Box
            flexDirection="column"
            borderStyle="round"
            borderColor="gray"
            paddingX={1}
            marginTop={1}
            flexShrink={0}
          >
            <Text bold>LAUNCH PROFILE</Text>
            <Box
              ref={controlRef('launch:model')}
              justifyContent="space-between"
              paddingX={1}
            >
              <Text
                bold={launchField === 'model'}
                color={launchField === 'model' ? 'cyan' : 'white'}
              >
                {launchField === 'model' ? '> ' : '  '}MODEL
              </Text>
              <Text wrap="truncate-end">‹ {modelLabel} ›</Text>
            </Box>
            <Box
              ref={controlRef('launch:effort')}
              justifyContent="space-between"
              paddingX={1}
            >
              <Text
                bold={launchField === 'effort'}
                color={launchField === 'effort' ? 'cyan' : 'white'}
              >
                {launchField === 'effort' ? '> ' : '  '}EFFORT
              </Text>
              <Text color={launchEfforts.length > 1 ? 'white' : 'gray'}>
                {launchEfforts.length > 1
                  ? `‹ ${effortLabel} ›`
                  : 'Not supported'}
              </Text>
            </Box>
            <Text color="gray" wrap="truncate-end">
              {modelDetail}
            </Text>
          </Box>

          <Box marginTop={1}>
            <Box
              ref={controlRef('launch:confirm')}
              borderStyle="round"
              borderColor={launchField === 'launch' ? 'cyan' : 'gray'}
              paddingX={1}
              marginRight={1}
            >
              <Text bold color={launchField === 'launch' ? 'cyan' : 'white'}>
                {launchField === 'launch' ? '> ' : ''}LAUNCH SESSION
              </Text>
            </Box>
            <Box
              ref={controlRef('launch:cancel')}
              borderStyle="round"
              borderColor="gray"
              paddingX={1}
            >
              <Text>BACK</Text>
            </Box>
          </Box>

          {feedbackMessage && (
            <Box
              borderStyle="round"
              borderColor={
                feedbackMessage.includes('failed:') ? 'red' : 'yellow'
              }
              paddingX={1}
              marginTop={1}
            >
              <Text
                color={feedbackMessage.includes('failed:') ? 'red' : 'yellow'}
              >
                {feedbackMessage}
              </Text>
            </Box>
          )}

          <Box marginTop={1}>
            <Text color="gray">
              {launchDraft.model === '__custom' && launchField === 'model'
                ? 'TYPE model ID    ENTER next    ESC cancel custom'
                : 'ARROWS choose    ENTER select    L launch    B back'}
            </Text>
          </Box>
        </Box>
      );
    }

    const activeProjects = initialData.activity?.projects ?? [];
    const projectName = basename(initialData.currentProject);
    const feedbackIsError = feedbackMessage?.includes('failed:') ?? false;
    const feedbackRows = (feedbackMessage ? 4 : 0) + (notificationCard ? 4 : 0);
    const showSidePanel = wide || terminalHeight >= 28 + feedbackRows;
    const visibleSessionLimit = Math.min(
      8,
      Math.max(
        2,
        terminalHeight - (wide ? 16 : showSidePanel ? 24 : 15) - feedbackRows,
      ),
    );
    const sessionOffset = Math.min(
      Math.max(0, selectedIndex - Math.floor(visibleSessionLimit / 2)),
      Math.max(0, terminals.length - visibleSessionLimit),
    );
    const visibleSessions = terminals.slice(
      sessionOffset,
      sessionOffset + visibleSessionLimit,
    );
    const showRecentProjects = wide
      ? terminalHeight >= 28 + feedbackRows
      : terminalHeight >= 38 + feedbackRows;

    const sessionsPanel = (
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={focus === 'sessions' ? 'cyan' : 'gray'}
        paddingX={1}
        minHeight={5}
        flexGrow={1}
        flexShrink={1}
        overflow="hidden"
      >
        <Box justifyContent="space-between">
          <Text bold>SESSIONS</Text>
          <Text color="gray">
            {terminals.length > visibleSessions.length
              ? `${sessionOffset + 1}-${sessionOffset + visibleSessions.length} / ${terminals.length}`
              : `${terminals.length} ACTIVE`}{' '}
            {focus === 'sessions' ? 'ENTER OPEN / X STOP / SHIFT+X ALL' : ''}
          </Text>
        </Box>
        {terminals.length === 0 ? (
          <Box flexDirection="column" paddingY={1}>
            <Text bold>No agents running</Text>
            <Text color="gray">
              Pick a launcher above. Relay will open it here and attach
              automatically.
            </Text>
          </Box>
        ) : (
          visibleSessions.map((terminal, visibleIndex) => {
            const index = sessionOffset + visibleIndex;
            const selected = focus === 'sessions' && index === selectedIndex;
            return (
              <Box
                key={terminal.id}
                ref={controlRef(`session:${terminal.id}`)}
                paddingX={1}
                justifyContent="space-between"
                height={1}
                overflow="hidden"
              >
                <Box flexGrow={1} flexShrink={1} overflow="hidden">
                  <Text
                    bold={selected}
                    color={selected ? 'black' : 'white'}
                    backgroundColor={selected ? 'cyan' : undefined}
                    wrap="truncate-end"
                  >
                    {selected ? ' OPEN ' : '      '}
                    {(
                      terminal.displayLabel || terminal.provider.toUpperCase()
                    ).padEnd(12)}
                    <Text color={selected ? 'black' : 'gray'}>
                      {terminal.branchLabel || 'main'}
                    </Text>
                  </Text>
                </Box>
                <Box marginLeft={1} flexShrink={0}>
                  <Text wrap="truncate-end">
                    <Text color="gray">│ </Text>
                    {renderStatus(terminal.status, terminal.attentionKind)}{' '}
                    <Text color="gray">
                      {runtimeLabel(terminal.activeRuntimeSeconds)}
                    </Text>
                  </Text>
                </Box>
              </Box>
            );
          })
        )}
      </Box>
    );

    const sidePanel = (
      <Box
        flexDirection="column"
        width={wide ? 40 : '100%'}
        marginLeft={wide ? 1 : 0}
        marginTop={wide ? 0 : 1}
        flexShrink={0}
        overflow="hidden"
      >
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor="gray"
          paddingX={1}
          flexShrink={0}
        >
          <Box justifyContent="space-between">
            <Text bold>PLAN REMAINING</Text>
            <Text color="gray">5H / 7D</Text>
          </Box>
          {launchActions
            .filter((action) => action.id !== 'shell')
            .map((action) => {
              const usage = initialData.planUsage[action.id];
              const hasWindows = Boolean(usage?.fiveHour || usage?.week);
              return (
                <Box
                  key={action.id}
                  justifyContent="space-between"
                  height={1}
                  overflow="hidden"
                >
                  <Text color="gray">{action.label.padEnd(12)}</Text>
                  {hasWindows && usage?.status !== 'stale' ? (
                    <Text wrap="truncate-end">
                      {renderRemaining(
                        usage?.fiveHour?.remainingPercentage ?? null,
                        5,
                        usage?.fiveHour?.status,
                      )}{' '}
                      {renderRemaining(
                        usage?.week?.remainingPercentage ?? null,
                        5,
                        usage?.week?.status,
                      )}
                    </Text>
                  ) : (
                    <Text color="gray" wrap="truncate-end">
                      {usage
                        ? (usageReasonLabels[usage.statusReason] ??
                          usage.status.toUpperCase())
                        : 'UNAVAILABLE'}
                    </Text>
                  )}
                </Box>
              );
            })}
        </Box>

        {showRecentProjects && (
          <Box
            flexDirection="column"
            borderStyle="round"
            borderColor="gray"
            paddingX={1}
            marginTop={1}
          >
            <Text bold>RECENT WORKSPACES</Text>
            {activeProjects.length === 0 ? (
              <Text color="gray">No recent workspaces</Text>
            ) : (
              activeProjects
                .slice(0, 3)
                .map((project: { project: string; branch?: string }) => (
                  <Box key={project.project} justifyContent="space-between">
                    <Text>{basename(project.project)}</Text>
                    <Text color="gray">{project.branch || 'main'}</Text>
                  </Box>
                ))
            )}
          </Box>
        )}
      </Box>
    );

    return (
      <Box
        flexDirection="column"
        width={Math.max(1, terminalWidth - 1)}
        height={Math.max(1, terminalHeight)}
        overflow="hidden"
        paddingX={1}
      >
        <Box
          justifyContent="space-between"
          borderStyle="single"
          borderTop={false}
          borderLeft={false}
          borderRight={false}
          borderColor="gray"
          paddingY={1}
          flexShrink={0}
        >
          <Box flexDirection="column" width="68%">
            <Text bold color="cyan">
              RELAY <Text color="white">CONTROL ROOM</Text>
            </Text>
            <Text color="gray" wrap="truncate-end">
              {projectName} / {initialData.currentProject}
            </Text>
          </Box>
          <Box flexDirection="column" alignItems="flex-end" width="32%">
            <Text bold color={daemonConnected ? 'green' : 'red'}>
              {daemonConnected ? '● ONLINE' : '○ OFFLINE'}
            </Text>
            <Text
              color={threadsData.unreadCount > 0 ? 'yellow' : 'gray'}
              wrap="truncate-end"
            >
              {threadsData.unreadCount > 0
                ? `${threadsData.unreadCount} UNREAD / M INBOX`
                : `UPDATED ${initialData.lastUpdated}`}
            </Text>
          </Box>
        </Box>

        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor={focus === 'actions' ? 'cyan' : 'gray'}
          paddingX={1}
          marginTop={1}
          flexShrink={0}
        >
          <Box justifyContent="space-between">
            <Text bold>NEW SESSION</Text>
            <Text color="gray">CLICK OR PRESS A SHORTCUT</Text>
          </Box>
          <Box flexWrap="wrap">
            {launchActions.map((action, index) => {
              const selected = focus === 'actions' && index === selectedAction;
              return (
                <Box
                  key={action.id}
                  ref={controlRef(action.id)}
                  marginRight={1}
                >
                  <Text bold={selected} color={selected ? 'cyan' : 'white'}>
                    {selected ? '> ' : ''}[
                    <Text inverse>{action.key.toUpperCase()}</Text>]{' '}
                    {action.label}
                  </Text>
                </Box>
              );
            })}
          </Box>
        </Box>

        <Box
          flexDirection={wide ? 'row' : 'column'}
          marginTop={1}
          flexGrow={1}
          flexShrink={1}
          overflow="hidden"
        >
          {sessionsPanel}
          {showSidePanel ? sidePanel : null}
        </Box>

        {notificationCard && (
          <Box
            borderStyle="round"
            borderColor="cyan"
            paddingX={1}
            marginTop={1}
            flexShrink={0}
          >
            <Text color="cyan" bold>
              {notificationCard.message ??
                `Session started: ${notificationCard.terminalId} • Run: relay attach ${notificationCard.terminalId}`}
            </Text>
          </Box>
        )}

        {feedbackMessage && (
          <Box
            borderStyle="round"
            borderColor={feedbackIsError ? 'red' : 'yellow'}
            paddingX={1}
            marginTop={1}
            flexShrink={0}
          >
            <Text color={feedbackIsError ? 'red' : 'yellow'}>
              {feedbackIsError ? 'ERROR' : 'WORKING'} / {feedbackMessage}
            </Text>
          </Box>
        )}

        <Box
          justifyContent="space-between"
          paddingX={1}
          marginTop={1}
          height={1}
          flexShrink={0}
          overflow="hidden"
        >
          <Text color="gray" wrap="truncate-end">
            <Text bold color="white">
              TAB
            </Text>{' '}
            focus {'  '}
            <Text bold color="white">
              ARROWS
            </Text>{' '}
            move {'  '}
            <Text bold color="white">
              ENTER
            </Text>{' '}
            open
            {activeTerminals.length > 0 ? (
              <>
                {'  '}
                <Text bold color="white">
                  X
                </Text>{' '}
                stop
              </>
            ) : null}
          </Text>
          <Box>
            <Text color="gray">{mouseEnabled ? 'MOUSE ON  ' : ''}</Text>
            <Box ref={controlRef('threads')}>
              <Text color={threadsData.unreadCount > 0 ? 'yellow' : 'gray'}>
                <Text
                  bold
                  color={threadsData.unreadCount > 0 ? 'yellow' : 'white'}
                >
                  M
                </Text>{' '}
                inbox
                {threadsData.unreadCount > 0
                  ? `(${threadsData.unreadCount})`
                  : ''}
              </Text>
            </Box>
            <Text> {'  '} </Text>
            <Box ref={controlRef('usage')}>
              <Text color="gray">
                <Text bold color="white">
                  U
                </Text>{' '}
                usage
              </Text>
            </Box>
            <Text> {'  '} </Text>
            <Box ref={controlRef('refresh')}>
              <Text color="gray">
                <Text bold color="white">
                  R
                </Text>{' '}
                refresh
              </Text>
            </Box>
            <Text> {'  '} </Text>
            <Box ref={controlRef('quit')}>
              <Text color="gray">
                <Text bold color="white">
                  Q
                </Text>{' '}
                quit
              </Text>
            </Box>
          </Box>
        </Box>
      </Box>
    );
  };
}
