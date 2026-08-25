import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTerminalDaemon } from './terminal-daemon-server.mjs';

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
    await new Promise((resolve, reject) => {
      const child = spawn(nodePath, args, { cwd: project, stdio: 'ignore' });
      let settled = false;
      const finish = (error) => {
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
        finish(code === 0 ? null : new Error('Bridge registration failed.')),
      );
    });
  },
  async updateProviderStatus(project, terminalId, observation) {
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
    await new Promise((resolve) => {
      const child = spawn(nodePath, args, { cwd: project, stdio: 'ignore' });
      const timer = globalThis.setTimeout(() => child.kill('SIGKILL'), 5_000);
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
  async readProviderResult(project, terminalId) {
    const { spawn } = await import('node:child_process');
    return new Promise((resolve) => {
      const child = spawn(nodePath, [cliPath, 'status', '--json'], {
        cwd: project,
        stdio: ['ignore', 'pipe', 'ignore'],
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
  void daemon.close({ stopActive: true }).then(() => process.exit(0));
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Keep the detached daemon alive while its socket server owns sessions.
void path;
