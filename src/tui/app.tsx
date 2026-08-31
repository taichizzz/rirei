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

export interface TerminalSummary {
  readonly id: string;
  readonly provider: string;
  readonly project: string;
  readonly workspaceId: string;
  readonly branchLabel: string;
  readonly status: string;
  readonly attentionKind?: string | null;
  readonly activeRuntimeSeconds?: number;
}

export interface AppProps {
  initialData: DashboardData;
  agentCatalog: AgentCatalogEntry[];
  terminals: TerminalSummary[];
  daemonConnected: boolean;
  onLaunchAgent: (selection: LaunchSelection) => Promise<void>;
  onLaunchShell: () => Promise<void>;
  onAttach: (terminalId: string) => void;
  onRefresh: () => Promise<void>;
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
    onLaunchAgent,
    onLaunchShell,
    onAttach,
    onRefresh,
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
    const [launchDraft, setLaunchDraft] = useState<LaunchSelection | null>(
      null,
    );
    const [launchField, setLaunchField] = useState<
      'model' | 'effort' | 'launch'
    >('model');
    const [launchCustomModel, setLaunchCustomModel] = useState('');
    const [usageOpen, setUsageOpen] = useState(false);
    const [selectedUsage, setSelectedUsage] = useState(0);
    const [terminalWidth, setTerminalWidth] = useState(stdout.columns ?? 80);
    const [terminalHeight, setTerminalHeight] = useState(stdout.rows ?? 24);
    const launchPending = useRef(false);
    const refreshPending = useRef(false);
    const controls = useRef(new Map<string, DOMElement>());
    const mouseBuffer = useRef('');
    const activateControl = useRef<(id: string) => void>(() => undefined);
    const wide = terminalWidth >= 96;
    const mouseEnabled = isRawModeSupported && Boolean(stdout.isTTY);

    const launch = (message: string, operation: () => Promise<void>) => {
      if (launchPending.current) return;
      launchPending.current = true;
      setFeedbackMessage(message);
      void operation().then(
        () => {
          launchPending.current = false;
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

    activateControl.current = (id) => {
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

    const usageReasonLabels: Record<string, string> = {
      live_window: 'LIVE',
      not_collected: 'NOT COLLECTED',
      unsupported_auth: 'AUTH-SPECIFIC',
      unsupported_provider: 'UNSUPPORTED',
      collector_error: 'READ ERROR',
      all_windows_stale: 'STALE',
    };

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
    const feedbackRows = feedbackMessage ? 4 : 0;
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
            {focus === 'sessions' ? 'FOCUSED' : ''}
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
                    {terminal.provider.toUpperCase().padEnd(12)}
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
            <Text color="gray">UPDATED {initialData.lastUpdated}</Text>
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
          </Text>
          <Box>
            <Text color="gray">{mouseEnabled ? 'MOUSE ON  ' : ''}</Text>
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
