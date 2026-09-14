import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTerminalDaemon } from './terminal-daemon-server.mjs';
import { DaemonBridgeWorker } from './daemon-bridge-worker.mjs';

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const socketPath = option('--socket');
const descriptorPath = option('--descriptor');
const bridgePath = option('--bridge');
const cliPath = option('--cli');
const nodePath = option('--node');
if (![socketPath, descriptorPath, bridgePath, cliPath, nodePath].every(Boolean))
  throw new Error('Terminal daemon paths are required.');

const bridgeWorker = new DaemonBridgeWorker({ nodePath, cliPath });

const daemon = await runTerminalDaemon({
  socketPath,
  descriptorPath,
  bridgePath,
  nodePath,
  lifecycleHookPath: path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    'provider-lifecycle-hook.cjs',
  ),
  codexLifecycleWrapperPath: path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    'codex-lifecycle-wrapper.mjs',
  ),
  openCodeLifecycleWrapperPath: path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    'opencode-lifecycle-wrapper.mjs',
  ),
  pathValue: process.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin',
  commandFor(body, terminalId) {
    if (body.kind === 'shell') return [body.shell || '/bin/zsh', '-l'];
    return [
      nodePath,
      cliPath,
      body.command,
      body.agent,
      ...(body.command === 'resume'
        ? body.resumeTargetKind === 'latest'
          ? ['--latest']
          : body.resumeTargetKind === 'id'
            ? ['--id', body.resumeTargetValue]
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
  async registerBridge(project, terminalId, bridge) {
    return bridgeWorker.registerBridge(project, terminalId, bridge);
  },
  async updateProviderStatus(project, terminalId, observation) {
    return bridgeWorker.updateProviderStatus(project, terminalId, observation);
  },
  async readProviderResult(project, terminalId) {
    const { spawn } = await import('node:child_process');
    return new Promise((resolve) => {
      const child = spawn(nodePath, [cliPath, 'status', '--json'], {
        cwd: project,
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      });
      let output = '';
      const timer = globalThis.setTimeout(() => child.kill('SIGKILL'), 5_000);
      child.stdout.on('data', (chunk) => {
        if (output.length < 1024 * 1024) output += chunk.toString();
      });
      child.once('close', () => {
        globalThis.clearTimeout(timer);
        try {
          const state = JSON.parse(output);
          const run = state.agentHistory?.find(
            (entry) => entry.terminalId === terminalId,
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
  void daemon.close({ stopActive: true }).then(() => {
    bridgeWorker.stop();
    process.exit(0);
  });
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Keep the detached daemon alive while its socket server owns sessions.
void path;
