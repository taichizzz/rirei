import { access, constants, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  type AgentAdapter,
  type AgentId,
  type AuthResult,
  type InstallationResult,
  type AgentRunContext,
  type CommandSpec,
  type ProcessResult,
} from './adapter.js';

const execFileAsync = promisify(execFile);

class OfficialCliAdapter implements AgentAdapter {
  constructor(
    readonly id: AgentId,
    readonly displayName: string,
    readonly executable: string,
    private readonly promptArgs: (context: AgentRunContext) => string[],
  ) {}

  detectInstallation(): Promise<InstallationResult> {
    return detectExecutable(this.executable);
  }
  detectAuthentication(): Promise<AuthResult> {
    return Promise.resolve(conservativeAuthenticationStatus());
  }
  async getVersion(): Promise<string | null> {
    try {
      const { stdout, stderr } = await execFileAsync(
        this.executable,
        ['--version'],
        {
          encoding: 'utf8',
          timeout: 10_000,
        },
      );
      return (stdout || stderr).trim() || null;
    } catch {
      return null;
    }
  }
  buildInteractiveCommand(context: AgentRunContext): Promise<CommandSpec> {
    return Promise.resolve({
      executable: this.executable,
      args: this.promptArgs(context),
    });
  }
  classifyExit(result: ProcessResult): Promise<{
    reason:
      'completed' | 'user_cancelled' | 'command_not_found' | 'unknown_failure';
    confidence: 'low' | 'medium' | 'high';
  }> {
    if (result.exitCode === 0)
      return Promise.resolve({ reason: 'completed', confidence: 'high' });
    if (result.signal === 'SIGINT' || result.exitCode === 130)
      return Promise.resolve({ reason: 'user_cancelled', confidence: 'high' });
    if (result.exitCode === 127)
      return Promise.resolve({
        reason: 'command_not_found',
        confidence: 'medium',
      });
    return Promise.resolve({ reason: 'unknown_failure', confidence: 'low' });
  }
}

const agents: ReadonlyArray<AgentAdapter> = [
  new OfficialCliAdapter('claude', 'Claude', 'claude', (context) =>
    context.providerSettingsPath
      ? ['--settings', context.providerSettingsPath, context.prompt]
      : [context.prompt],
  ),
  new OfficialCliAdapter('codex', 'Codex', 'codex', (context) => [
    context.prompt,
  ]),
  // --prompt-interactive starts a real session; --prompt would run headless
  // and exit (and headless mode refuses to launch the first-run auth picker).
  new OfficialCliAdapter('gemini', 'Gemini', 'gemini', (context) => [
    '--prompt-interactive',
    context.prompt,
  ]),
  // Antigravity CLI (`agy`) is Google's successor to Gemini CLI for individual
  // accounts (incl. Google AI Pro/Ultra). Interactive-with-prompt is -i /
  // --prompt-interactive; --prompt/-p is its headless one-shot mode.
  // Verify the binary name and flags against `agy --help` on the target machine.
  new OfficialCliAdapter('antigravity', 'Antigravity', 'agy', (context) => [
    '--prompt-interactive',
    context.prompt,
  ]),
];

export function registeredAgents(): ReadonlyArray<AgentAdapter> {
  return agents;
}

export function getAgent(id: AgentId): AgentAdapter {
  return agents.find((agent) => agent.id === id)!;
}

export async function detectExecutable(
  executable: string,
): Promise<InstallationResult> {
  const directories = process.env.PATH?.split(path.delimiter) ?? [];
  for (const directory of directories) {
    try {
      const candidate = path.join(directory, executable);
      await access(candidate, constants.X_OK);
      if ((await stat(candidate)).isFile()) return { status: 'ready' };
    } catch {
      // Continue checking PATH entries.
    }
  }
  return { status: 'not_installed' };
}

export function conservativeAuthenticationStatus(): AuthResult {
  return {
    status: 'unknown',
    detail: 'Relay does not inspect provider credential files.',
  };
}

export function isAgentId(value: string): value is AgentId {
  return agents.some((agent) => agent.id === value);
}
