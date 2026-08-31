import { Command } from 'commander';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { runTerminalDaemon } from '../../desktop/terminal-daemon-server.mjs';
import { ensureDaemon } from '../platform/daemon-manager.js';
import { shellCommand } from '../platform/shell.js';

export interface DaemonCommandOptions {
  internal?: boolean;
  ensure?: boolean;
  socket?: string;
  descriptor?: string;
  bridge?: string;
  cli?: string;
  node?: string;
}

interface DaemonStartBody {
  kind?: string;
  shell?: string;
  command?: string;
  agent?: string;
  resumeTargetKind?: string;
  resumeTargetValue?: string;
  fork?: boolean;
  model?: string;
  effort?: string;
  workspaceId?: string;
}

interface DaemonBridgeRecord {
  instanceId: string;
  pid: number;
  protocolVersion: number;
}

interface DaemonObservationRecord {
  status: string;
  lifecycleState: string;
  activeRuntimeSeconds: number;
  runtimeSequence: number;
  attentionKind?: string;
  daemon: {
    instanceId: string;
    pid: number;
    bootId: string;
  };
}

export function daemonCommand(): Command {
  return new Command('daemon')
    .description('Manage the Relay terminal daemon service')
    .option('--internal', 'Run the terminal daemon process in the foreground')
    .option('--ensure', 'Start or reuse the detached terminal daemon')
    .option('--socket <path>', 'Unix socket or Windows named pipe path')
    .option('--descriptor <path>', 'Daemon descriptor file path')
    .option('--bridge <path>', 'Legacy Python PTY bridge path')
    .option('--cli <path>', 'Relay CLI executable path')
    .option('--node <path>', 'Node.js executable path')
    .action(async (options: DaemonCommandOptions) => {
      if (options.ensure) {
        const daemon = await ensureDaemon();
        process.stdout.write(`${JSON.stringify(daemon)}\n`);
        return;
      }
      if (!options.internal) {
        process.stderr.write(
          'relay daemon: use --internal to start the daemon process\n',
        );
        process.exitCode = 1;
        return;
      }

      const socketPath = options.socket;
      const descriptorPath = options.descriptor;
      if (!socketPath || !descriptorPath) {
        process.stderr.write(
          'relay daemon: --socket and --descriptor are required\n',
        );
        process.exitCode = 1;
        return;
      }

      const nodePath = options.node ?? process.execPath;
      const defaultCli = path.resolve(process.cwd(), 'dist', 'index.cjs');
      const cliPath = await realpath(
        options.cli ?? process.argv[1] ?? defaultCli,
      );
      const desktopSupportPath = path.resolve(
        path.dirname(cliPath),
        '..',
        'desktop',
      );

      const daemon = await runTerminalDaemon({
        socketPath,
        descriptorPath,
        bridgePath: options.bridge,
        nodePath,
        lifecycleHookPath: path.join(
          desktopSupportPath,
          'provider-lifecycle-hook.cjs',
        ),
        codexLifecycleWrapperPath: path.join(
          desktopSupportPath,
          'codex-lifecycle-wrapper.mjs',
        ),
        openCodeLifecycleWrapperPath: path.join(
          desktopSupportPath,
          'opencode-lifecycle-wrapper.mjs',
        ),
        pathValue: process.env.PATH ?? '',
        commandFor(body: DaemonStartBody, terminalId: string) {
          if (body.kind === 'shell') {
            const shell = shellCommand(body.shell);
            return [shell.executable, ...shell.args];
          }
          return [
            nodePath,
            cliPath,
            body.command ?? 'run',
            body.agent ?? 'claude',
            ...(body.command === 'resume'
              ? body.resumeTargetKind === 'latest'
                ? ['--latest']
                : body.resumeTargetKind === 'id'
                  ? ['--id', body.resumeTargetValue ?? '']
                  : ['--picker']
              : []),
            ...(body.command === 'resume' && body.fork ? ['--fork'] : []),
            ...(body.model ? ['--model', body.model] : []),
            ...(body.effort ? ['--effort', body.effort] : []),
            ...(body.workspaceId && body.workspaceId !== 'default'
              ? ['--workspace', body.workspaceId]
              : []),
            '--operation-id',
            terminalId,
            '--terminal-id',
            terminalId,
          ];
        },
        async registerBridge(
          project: string,
          terminalId: string,
          bridge: DaemonBridgeRecord,
        ) {
          const { spawn } = await import('node:child_process');
          const args = [
            cliPath,
            'bridge',
            '--terminal-id',
            terminalId,
            '--instance-id',
            bridge.instanceId,
            '--pid',
            String(bridge.pid),
            '--protocol-version',
            String(bridge.protocolVersion),
          ];
          await new Promise<void>((resolve, reject) => {
            const child = spawn(nodePath, args, {
              cwd: project,
              stdio: 'ignore',
              windowsHide: true,
            });
            let settled = false;
            const finish = (error: Error | null) => {
              if (settled) return;
              settled = true;
              globalThis.clearTimeout(timer);
              if (error) reject(error);
              else resolve();
            };
            const timer = globalThis.setTimeout(() => {
              child.kill('SIGKILL');
              finish(new Error('Bridge registration timed out.'));
            }, 5_000);
            child.once('error', () =>
              finish(new Error('Bridge registration could not start.')),
            );
            child.once('close', (code) =>
              finish(
                code === 0 ? null : new Error('Bridge registration failed.'),
              ),
            );
          });
        },
        async updateProviderStatus(
          project: string,
          terminalId: string,
          observation: DaemonObservationRecord,
        ) {
          const { spawn } = await import('node:child_process');
          const args = [
            cliPath,
            'bridge',
            '--terminal-id',
            terminalId,
            '--status',
            observation.status,
            '--lifecycle-state',
            observation.lifecycleState,
            '--active-runtime-seconds',
            String(observation.activeRuntimeSeconds),
            '--runtime-sequence',
            String(observation.runtimeSequence),
            '--daemon-id',
            observation.daemon.instanceId,
            '--daemon-pid',
            String(observation.daemon.pid),
            '--daemon-boot-id',
            observation.daemon.bootId,
            ...(observation.attentionKind
              ? ['--attention-kind', observation.attentionKind]
              : []),
          ];
          await new Promise<void>((resolve) => {
            const child = spawn(nodePath, args, {
              cwd: project,
              stdio: 'ignore',
              windowsHide: true,
            });
            const timer = globalThis.setTimeout(
              () => child.kill('SIGKILL'),
              5_000,
            );
            child.once('close', () => {
              globalThis.clearTimeout(timer);
              resolve();
            });
            child.once('error', () => {
              globalThis.clearTimeout(timer);
              resolve();
            });
          });
        },
        async readProviderResult(project: string, terminalId: string) {
          const { spawn } = await import('node:child_process');
          return new Promise((resolve) => {
            const child = spawn(nodePath, [cliPath, 'status', '--json'], {
              cwd: project,
              stdio: ['ignore', 'pipe', 'ignore'],
              windowsHide: true,
            });
            let output = '';
            const timer = globalThis.setTimeout(
              () => child.kill('SIGKILL'),
              5_000,
            );
            if (child.stdout) {
              child.stdout.on('data', (chunk: Buffer) => {
                if (output.length < 1024 * 1024) output += chunk.toString();
              });
            }
            child.once('close', () => {
              globalThis.clearTimeout(timer);
              try {
                const state = JSON.parse(output);
                const run = state.agentHistory?.find(
                  (entry: { terminalId: string }) =>
                    entry.terminalId === terminalId,
                );
                resolve(run?.exitClassification ?? null);
              } catch {
                resolve(null);
              }
            });
            child.once('error', () => {
              globalThis.clearTimeout(timer);
              resolve(null);
            });
          });
        },
      });

      const shutdown = () =>
        void daemon.close({ stopActive: true }).then(() => process.exit(0));
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);

      // Keep event loop alive
      void path;
    });
}
