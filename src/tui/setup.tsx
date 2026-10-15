import type React from 'react';
import type { AgentCatalogEntry } from '../agents/registry.js';
import type { ProjectSetupState } from '../application/project-setup.js';
import { PROVIDER_SETUP } from './provider-setup.js';

export interface SetupProps {
  initial: ProjectSetupState;
  providers: AgentCatalogEntry[];
  onInitialize: () => Promise<ProjectSetupState>;
  onStartTask: (
    request: string,
    allowDirty: boolean,
  ) => Promise<ProjectSetupState>;
  onRefresh: () => Promise<{
    setup: ProjectSetupState;
    providers: AgentCatalogEntry[];
  }>;
  onDone: () => void;
  onQuit: () => void;
}

/** First launch is explicit: read-only until Initialize or Start is selected. */
export function createSetupApp(
  ink: typeof import('ink'),
  ReactModule: typeof import('react'),
): React.FC<SetupProps> {
  const { Box, Text, useInput, useStdout } = ink;
  const { useState, useRef, useEffect } = ReactModule;
  return function Setup({
    initial,
    providers: initialProviders,
    onInitialize,
    onStartTask,
    onRefresh,
    onDone,
    onQuit,
  }) {
    const { stdout } = useStdout();
    const [size, setSize] = useState({
      columns: stdout.columns ?? 80,
      rows: stdout.rows ?? 24,
    });
    useEffect(() => {
      const resize = () =>
        setSize({ columns: stdout.columns ?? 80, rows: stdout.rows ?? 24 });
      stdout.on('resize', resize);
      return () => {
        stdout.off('resize', resize);
      };
    }, [stdout]);
    const [setup, setSetup] = useState(initial);
    const [providers, setProviders] = useState(initialProviders);
    const [request, setRequest] = useState('');
    const [allowDirty, setAllowDirty] = useState(false);
    const [field, setField] = useState<'task' | 'dirty' | 'start'>('task');
    const [selected, setSelected] = useState(0);
    const [message, setMessage] = useState<string | null>(null);
    const [pending, setPending] = useState(false);
    const busy = useRef(false);
    const operate = (operation: () => Promise<ProjectSetupState>) => {
      if (busy.current) return;
      busy.current = true;
      setPending(true);
      setMessage(null);
      void operation()
        .then(setSetup, (error: unknown) => {
          setMessage(
            error instanceof Error ? error.message : 'Setup failed. Try again.',
          );
        })
        .finally(() => {
          busy.current = false;
          setPending(false);
        });
    };

    useInput((input, key) => {
      if (key.escape || (key.ctrl && input === 'c')) {
        onQuit();
        return;
      }
      if (busy.current) return;
      if (setup.stage === 'initialize' && key.return) {
        operate(onInitialize);
      } else if (setup.stage === 'task') {
        if (key.tab || key.downArrow || key.upArrow) {
          const fields = setup.dirty
            ? (['task', 'dirty', 'start'] as const)
            : (['task', 'start'] as const);
          const index = fields.findIndex((value) => value === field);
          const direction = key.upArrow || (key.tab && key.shift) ? -1 : 1;
          setField(
            fields[(index + direction + fields.length) % fields.length]!,
          );
        } else if (field === 'dirty' && (input === ' ' || key.return)) {
          setAllowDirty((value) => !value);
        } else if (key.return) {
          if (!request.trim()) {
            setMessage('Describe your task first.');
            return;
          }
          if (setup.dirty && !allowDirty) {
            setMessage(
              'Use Tab, then Space to acknowledge the existing changes.',
            );
            return;
          }
          operate(() => onStartTask(request.trim(), allowDirty));
        } else if (field === 'task') {
          if (key.ctrl && input === 'u') setRequest('');
          else if (key.backspace || key.delete)
            setRequest((value) => Array.from(value).slice(0, -1).join(''));
          else if (input && !key.ctrl && !key.meta) {
            setRequest((value) =>
              (value + input.replace(/[\r\n\t]/g, ' ')).slice(0, 2000),
            );
          }
        }
      } else if (setup.stage === 'ready') {
        if (key.return) onDone();
        else if (key.upArrow || key.downArrow) {
          setSelected((value) =>
            providers.length
              ? (value + (key.upArrow ? -1 : 1) + providers.length) %
                providers.length
              : 0,
          );
        } else if (input === 'r') {
          operate(async () => {
            const result = await onRefresh();
            setProviders(result.providers);
            return result.setup;
          });
        }
      } else if (input === 'r') {
        operate(async () => {
          const result = await onRefresh();
          setProviders(result.providers);
          return result.setup;
        });
      }
    });

    const provider = providers[selected];
    const help = provider ? PROVIDER_SETUP[provider.id] : undefined;
    return (
      <Box
        flexDirection="column"
        width={Math.max(1, size.columns - 1)}
        height={size.rows}
        paddingX={1}
        overflow="hidden"
      >
        <Box
          flexDirection="column"
          borderStyle="single"
          borderTop={false}
          borderLeft={false}
          borderRight={false}
          borderColor="gray"
          paddingY={1}
          flexShrink={0}
        >
          <Text bold color="cyan">
            RIREI / FIRST TASK
          </Text>
          <Text color="gray" wrap="truncate-end">
            {setup.project}
          </Text>
        </Box>
        <Box flexDirection="column" flexGrow={1} paddingY={1} overflow="hidden">
          {setup.stage === 'not_repository' ? (
            <>
              <Text bold>Open a Git project to get started</Text>
              <Text>Change to your project directory, then run relay tui.</Text>
              <Text color="gray">
                For an existing folder without Git, initialize it yourself with
                git init.
              </Text>
              <Text color="gray">
                Rirei does not create a repository or install provider CLIs
                automatically.
              </Text>
            </>
          ) : setup.stage === 'error' ? (
            <>
              <Text bold color="red">
                Project setup needs attention
              </Text>
              <Text>{setup.detail}</Text>
              <Text color="gray">
                Existing task data is preserved. Fix the issue, then press R.
              </Text>
            </>
          ) : setup.stage === 'initialize' ? (
            <>
              <Text bold>Initialize this project</Text>
              <Text>
                Rirei will create local .relay settings and checkpoints.
              </Text>
              <Text color="gray">
                It also excludes /.relay/ from local Git status.
              </Text>
              <Text color="gray">
                Your source files, commits, and provider settings stay as they
                are.
              </Text>
              <Box marginTop={1}>
                <Text bold color="cyan">
                  [ Enter ] Initialize project
                </Text>
              </Box>
            </>
          ) : setup.stage === 'task' ? (
            <>
              <Text bold>What are you working on?</Text>
              <Text color="gray">
                Describe the task the providers should continue.
              </Text>
              <Box
                marginTop={1}
                borderStyle="round"
                borderColor={field === 'task' ? 'cyan' : 'gray'}
                paddingX={1}
              >
                <Text wrap="truncate-start">
                  {request || 'Type your task here'}
                  {field === 'task' ? '▌' : ''}
                </Text>
              </Box>
              {setup.dirty ? (
                <Box marginTop={1}>
                  <Text color={field === 'dirty' ? 'cyan' : 'yellow'}>
                    {allowDirty ? '[x]' : '[ ]'} Record the existing uncommitted
                    changes as the baseline
                  </Text>
                </Box>
              ) : null}
              <Box marginTop={1}>
                <Text bold color={field === 'start' ? 'cyan' : 'white'}>
                  [ Enter ] Start task
                </Text>
              </Box>
            </>
          ) : (
            <>
              <Text bold>Task ready: {setup.taskTitle}</Text>
              <Text color="gray">
                Installed providers use their own sign-in and permissions.
              </Text>
              <Box marginTop={1} flexDirection="column">
                {providers.map((entry, index) => (
                  <Text
                    key={entry.id}
                    bold={selected === index}
                    color={selected === index ? 'cyan' : 'white'}
                  >
                    {selected === index ? '> ' : '  '}
                    {entry.displayName.padEnd(13)}{' '}
                    {entry.installed ? 'Installed' : 'Not installed'}
                  </Text>
                ))}
              </Box>
              {provider && help ? (
                <Box marginTop={1} flexDirection="column">
                  <Text>
                    {provider.displayName}:{' '}
                    {provider.installed
                      ? `sign-in ${provider.authentication?.status ?? 'checked by provider at launch'}`
                      : `install the ${help.executable} CLI`}
                  </Text>
                  <Text color="gray">{help.documentation}</Text>
                </Box>
              ) : (
                <Text color="yellow">
                  Provider discovery is unavailable. Use R to retry or relay
                  doctor.
                </Text>
              )}
              <Box marginTop={1}>
                <Text bold color="cyan">
                  [ Enter ] Open dashboard and choose a provider
                </Text>
              </Box>
            </>
          )}
        </Box>
        {message ? <Text color="red">{message}</Text> : null}
        <Text color="gray">
          {pending
            ? 'Working...'
            : setup.stage === 'task'
              ? 'Type task / Tab move / Space toggle / Enter start / Esc quit'
              : 'Enter continue / Arrows inspect / R recheck / Esc quit'}
        </Text>
      </Box>
    );
  };
}
