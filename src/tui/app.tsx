import type React from 'react';
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
  terminals: TerminalSummary[];
  daemonConnected: boolean;
  onLaunchAgent: (agent: string) => Promise<void>;
  onLaunchShell: () => Promise<void>;
  onAttach: (terminalId: string) => void;
  onRefresh: () => Promise<void>;
  onQuit: () => void;
}

export function createApp(
  ink: typeof import('ink'),
  ReactModule: typeof import('react'),
): React.FC<AppProps> {
  const { Box, Text, useInput, useApp } = ink;
  const { useState, useEffect } = ReactModule;

  return function App({
    initialData,
    terminals,
    daemonConnected,
    onLaunchAgent,
    onLaunchShell,
    onAttach,
    onRefresh,
    onQuit,
  }: AppProps) {
    const { exit } = useApp();
    const [selectedIndex, setSelectedIndex] = useState(0);
    const [feedbackMessage, setFeedbackMessage] = useState<string | null>(null);

    useEffect(() => {
      if (terminals.length > 0 && selectedIndex >= terminals.length) {
        setSelectedIndex(terminals.length - 1);
      }
    }, [terminals.length, selectedIndex]);

    useInput((input, key) => {
      if (input === 'q' || (key.ctrl && input === 'c')) {
        onQuit();
        exit();
        return;
      }

      if (input === 'u') {
        setFeedbackMessage('Refreshing state...');
        void onRefresh().then(() => setFeedbackMessage(null));
        return;
      }

      if (input === 'c') {
        setFeedbackMessage('Launching Claude session...');
        void onLaunchAgent('claude').then(() => setFeedbackMessage(null));
        return;
      }

      if (input === 'o') {
        setFeedbackMessage('Launching Codex session...');
        void onLaunchAgent('codex').then(() => setFeedbackMessage(null));
        return;
      }

      if (input === 'g') {
        setFeedbackMessage('Launching Gemini session...');
        void onLaunchAgent('gemini').then(() => setFeedbackMessage(null));
        return;
      }

      if (input === 'a') {
        setFeedbackMessage('Launching Antigravity session...');
        void onLaunchAgent('antigravity').then(() => setFeedbackMessage(null));
        return;
      }

      if (input === 'p') {
        setFeedbackMessage('Launching OpenCode session...');
        void onLaunchAgent('opencode').then(() => setFeedbackMessage(null));
        return;
      }

      if (input === 's') {
        setFeedbackMessage('Opening shell terminal...');
        void onLaunchShell().then(() => setFeedbackMessage(null));
        return;
      }

      if (key.upArrow) {
        setSelectedIndex((prev) =>
          prev > 0 ? prev - 1 : Math.max(0, terminals.length - 1),
        );
        return;
      }

      if (key.downArrow) {
        setSelectedIndex((prev) =>
          prev < terminals.length - 1 ? prev + 1 : 0,
        );
        return;
      }

      if (key.return && terminals.length > 0 && terminals[selectedIndex]) {
        const target = terminals[selectedIndex];
        onAttach(target.id);
        return;
      }
    });

    const renderStatusBadge = (status: string, attention?: string | null) => {
      if (status === 'running') {
        return <Text color="green">● RUNNING</Text>;
      }
      if (status === 'waiting') {
        const label = attention
          ? `WAITING: ${attention.toUpperCase()}`
          : 'WAITING';
        return <Text color="yellow">▲ {label}</Text>;
      }
      if (status === 'stopping') {
        return <Text color="red">■ STOPPING</Text>;
      }
      return <Text color="gray">○ {status.toUpperCase()}</Text>;
    };

    const renderUsageBar = (percent: number | null) => {
      if (percent === null || Number.isNaN(percent)) {
        return <Text color="gray">N/A</Text>;
      }
      const width = 12;
      const filled = Math.min(
        width,
        Math.max(0, Math.round((percent / 100) * width)),
      );
      const empty = width - filled;
      const bar = '█'.repeat(filled) + '░'.repeat(empty);
      const color = percent > 85 ? 'red' : percent > 60 ? 'yellow' : 'cyan';
      return (
        <Text>
          <Text color={color}>{bar}</Text> {Math.round(percent)}%
        </Text>
      );
    };

    const activeProjects = initialData.activity?.projects ?? [];

    return (
      <Box flexDirection="column" padding={1} width={90}>
        {/* Header */}
        <Box
          borderStyle="round"
          borderColor="cyan"
          paddingX={1}
          justifyContent="space-between"
        >
          <Text bold color="cyan">
            ◆ RELAY TUI <Text color="gray">v0.1.0-alpha.4</Text>
          </Text>
          <Text>
            Daemon:{' '}
            {daemonConnected ? (
              <Text color="green">● Connected</Text>
            ) : (
              <Text color="red">○ Disconnected</Text>
            )}{' '}
            | Updated: <Text color="gray">{initialData.lastUpdated}</Text>
          </Text>
        </Box>

        {/* Main Grid */}
        <Box flexDirection="row" marginTop={1} gap={1}>
          {/* Left Column: Sessions & Projects */}
          <Box flexDirection="column" width="60%">
            {/* Active Sessions Panel */}
            <Box
              flexDirection="column"
              borderStyle="single"
              borderColor="blue"
              paddingX={1}
              minHeight={8}
            >
              <Text bold color="blue">
                ▶ Active Sessions ({terminals.length})
              </Text>
              {terminals.length === 0 ? (
                <Box marginY={1}>
                  <Text color="gray">
                    No active sessions. Press [c,o,g,a,p] to launch an agent or
                    [s] for a shell.
                  </Text>
                </Box>
              ) : (
                terminals.map((t, idx) => {
                  const isSelected = idx === selectedIndex;
                  const runtime = t.activeRuntimeSeconds
                    ? `${Math.round(t.activeRuntimeSeconds)}s`
                    : '0s';
                  return (
                    <Box key={t.id} marginY={0}>
                      <Text
                        bold={isSelected}
                        color={isSelected ? 'cyan' : undefined}
                      >
                        {isSelected ? '❯ ' : '  '}
                        <Text bold>{t.provider.toUpperCase()}</Text>{' '}
                        <Text color="gray">({t.branchLabel || 'main'})</Text>{' '}
                        {renderStatusBadge(t.status, t.attentionKind)}{' '}
                        <Text color="gray">[{runtime}]</Text>
                      </Text>
                    </Box>
                  );
                })
              )}
            </Box>

            {/* Projects Panel */}
            <Box
              flexDirection="column"
              borderStyle="single"
              borderColor="gray"
              paddingX={1}
              marginTop={1}
            >
              <Text bold color="white">
                📁 Recent Projects & Worktrees
              </Text>
              {activeProjects.length === 0 ? (
                <Text color="gray">
                  No recent projects recorded in activity journal.
                </Text>
              ) : (
                activeProjects
                  .slice(0, 3)
                  .map((proj: { project: string; branch?: string }) => (
                    <Box key={proj.project} justifyContent="space-between">
                      <Text>
                        {proj.project.split(/[/\\]/).pop() || proj.project}
                      </Text>
                      <Text color="gray">{proj.branch || 'main'}</Text>
                    </Box>
                  ))
              )}
            </Box>
          </Box>

          {/* Right Column: Plan Usage */}
          <Box
            flexDirection="column"
            width="40%"
            borderStyle="single"
            borderColor="magenta"
            paddingX={1}
          >
            <Text bold color="magenta">
              ⚡ Plan Usage & Limits
            </Text>
            {['claude', 'codex', 'gemini', 'antigravity', 'opencode'].map(
              (provider) => {
                const usage = initialData.planUsage[provider];
                const fiveHour = usage?.fiveHour?.usedPercentage ?? null;
                const weekly = usage?.week?.usedPercentage ?? null;
                return (
                  <Box key={provider} flexDirection="column" marginY={0}>
                    <Text bold color="yellow">
                      {provider.toUpperCase()}
                    </Text>
                    <Box justifyContent="space-between">
                      <Text color="gray"> 5h:</Text>
                      {renderUsageBar(fiveHour)}
                    </Box>
                    <Box justifyContent="space-between">
                      <Text color="gray"> 7d:</Text>
                      {renderUsageBar(weekly)}
                    </Box>
                  </Box>
                );
              },
            )}
          </Box>
        </Box>

        {/* Feedback Message */}
        {feedbackMessage && (
          <Box marginY={0} paddingX={1}>
            <Text color="cyan">ℹ {feedbackMessage}</Text>
          </Box>
        )}

        {/* Footer Hotkeys */}
        <Box
          borderStyle="round"
          borderColor="gray"
          paddingX={1}
          marginTop={1}
          flexWrap="wrap"
        >
          <Text color="white">
            <Text bold color="cyan">
              [c]
            </Text>{' '}
            Claude{' '}
            <Text bold color="cyan">
              [o]
            </Text>{' '}
            Codex{' '}
            <Text bold color="cyan">
              [g]
            </Text>{' '}
            Gemini{' '}
            <Text bold color="cyan">
              [a]
            </Text>{' '}
            Antigravity{' '}
            <Text bold color="cyan">
              [p]
            </Text>{' '}
            OpenCode{' '}
            <Text bold color="cyan">
              [s]
            </Text>{' '}
            Shell{' '}
            <Text bold color="yellow">
              [Enter]
            </Text>{' '}
            Attach{' '}
            <Text bold color="white">
              [u]
            </Text>{' '}
            Refresh{' '}
            <Text bold color="red">
              [q]
            </Text>{' '}
            Quit
          </Text>
        </Box>
      </Box>
    );
  };
}
