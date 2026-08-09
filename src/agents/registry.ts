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
  type AgentResumeContext,
  type CommandSpec,
  type ProcessResult,
  type ModelOption,
} from './adapter.js';

const execFileAsync = promisify(execFile);

class OfficialCliAdapter implements AgentAdapter {
  constructor(
    readonly id: AgentId,
    readonly displayName: string,
    readonly executable: string,
    private readonly promptArgs: (context: AgentRunContext) => string[],
    private readonly models: () => Promise<ModelOption[]>,
    private readonly effortLevels: string[],
    private readonly resumeArgs?: (context: AgentResumeContext) => string[],
    readonly resumeCapabilities?: { supportsFork: boolean },
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
  getModels(): Promise<ModelOption[]> {
    return this.models();
  }
  async getEffortLevels(model?: string): Promise<string[]> {
    const models = model ? await this.models() : [];
    return (
      models.find((option) => option.id === model)?.efforts ?? this.effortLevels
    );
  }
  async buildInteractiveCommand(
    context: AgentRunContext,
  ): Promise<CommandSpec> {
    this.validateSelection(context);
    return {
      executable: this.executable,
      args: this.promptArgs(context),
    };
  }
  async buildResumeCommand(context: AgentResumeContext): Promise<CommandSpec> {
    if (!this.resumeArgs || !this.resumeCapabilities)
      throw new Error(`${this.displayName} does not support session resume.`);
    if (context.fork && !this.resumeCapabilities.supportsFork)
      throw new Error(`${this.displayName} does not support session forks.`);
    if (context.resumeTargetKind === 'picker' && context.prompt)
      throw new Error(
        `${this.displayName} session pickers cannot accept an initial prompt; use --latest or --id.`,
      );
    this.validateSelection(context);
    return {
      executable: this.executable,
      args: this.resumeArgs(context),
    };
  }
  private validateSelection(context: AgentRunContext): void {
    if (
      context.model &&
      (context.model.length > 120 || context.model.startsWith('-'))
    )
      throw new Error(`Invalid model for ${this.displayName}.`);
    if (context.effort && !this.effortLevels.includes(context.effort))
      throw new Error(
        `Unsupported effort for ${this.displayName}: ${context.effort}.`,
      );
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

async function codexModels(): Promise<ModelOption[]> {
  try {
    const { stdout } = await execFileAsync('codex', ['debug', 'models'], {
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const parsed = JSON.parse(stdout) as {
      models?: Array<{
        slug?: unknown;
        display_name?: unknown;
        supported_reasoning_levels?: Array<{ effort?: unknown }>;
      }>;
    };
    return (parsed.models ?? []).flatMap((model) =>
      typeof model.slug === 'string'
        ? [
            {
              id: model.slug,
              label:
                typeof model.display_name === 'string'
                  ? model.display_name
                  : model.slug,
              efforts: (model.supported_reasoning_levels ?? []).flatMap(
                (level) =>
                  typeof level.effort === 'string' ? [level.effort] : [],
              ),
            },
          ]
        : [],
    );
  } catch {
    return [];
  }
}

const antigravityModels = () =>
  Promise.resolve(
    [
      'Gemini 3.5 Flash (Medium)',
      'Gemini 3.5 Flash (High)',
      'Gemini 3.5 Flash (Low)',
      'Gemini 3.1 Pro (Low)',
      'Gemini 3.1 Pro (High)',
      'Claude Sonnet 4.6 (Thinking)',
      'Claude Opus 4.6 (Thinking)',
      'GPT-OSS 120B (Medium)',
    ].map((model) => ({ id: model, label: model })),
  );

const noModels = () => Promise.resolve([] as ModelOption[]);
const claudeModels = () =>
  Promise.resolve([
    { id: 'sonnet', label: 'Sonnet' },
    { id: 'opus', label: 'Opus' },
    { id: 'fable', label: 'Fable' },
  ]);

const agents: ReadonlyArray<AgentAdapter> = [
  new OfficialCliAdapter(
    'claude',
    'Claude',
    'claude',
    (context) => [
      ...(context.providerSettingsPath
        ? ['--settings', context.providerSettingsPath]
        : []),
      ...(context.providerSessionId
        ? ['--session-id', context.providerSessionId]
        : []),
      ...(context.model ? ['--model', context.model] : []),
      ...(context.effort ? ['--effort', context.effort] : []),
      ...(context.prompt ? [context.prompt] : []),
    ],
    claudeModels,
    ['low', 'medium', 'high', 'xhigh', 'max'],
    (context) => [
      ...(context.providerSettingsPath
        ? ['--settings', context.providerSettingsPath]
        : []),
      ...(context.model ? ['--model', context.model] : []),
      ...(context.effort ? ['--effort', context.effort] : []),
      ...(context.resumeTargetKind === 'latest'
        ? ['--continue']
        : context.resumeTargetKind === 'id'
          ? ['--resume', context.resumeTargetValue!]
          : ['--resume']),
      ...(context.fork ? ['--fork-session'] : []),
      ...(context.prompt ? [context.prompt] : []),
    ],
    { supportsFork: true },
  ),
  new OfficialCliAdapter(
    'codex',
    'Codex',
    'codex',
    (context) => [
      ...(context.model ? ['--model', context.model] : []),
      ...(context.effort
        ? ['--config', `model_reasoning_effort="${context.effort}"`]
        : []),
      ...(context.prompt ? [context.prompt] : []),
    ],
    codexModels,
    ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    (context) => [
      'resume',
      ...(context.model ? ['--model', context.model] : []),
      ...(context.effort
        ? ['--config', `model_reasoning_effort="${context.effort}"`]
        : []),
      ...(context.resumeTargetKind === 'latest'
        ? ['--last']
        : context.resumeTargetKind === 'id'
          ? [context.resumeTargetValue!]
          : []),
      ...(context.prompt ? [context.prompt] : []),
    ],
    { supportsFork: false },
  ),
  // --prompt-interactive starts a real session; --prompt would run headless
  // and exit (and headless mode refuses to launch the first-run auth picker).
  new OfficialCliAdapter(
    'gemini',
    'Gemini',
    'gemini',
    (context) => [
      ...(context.model ? ['--model', context.model] : []),
      '--prompt-interactive',
      ...(context.prompt ? [context.prompt] : []),
    ],
    noModels,
    [],
  ),
  // Antigravity CLI (`agy`) is Google's successor to Gemini CLI for individual
  // accounts (incl. Google AI Pro/Ultra). Interactive-with-prompt is -i /
  // --prompt-interactive; --prompt/-p is its headless one-shot mode.
  // Verify the binary name and flags against `agy --help` on the target machine.
  new OfficialCliAdapter(
    'antigravity',
    'Antigravity',
    'agy',
    (context) => [
      ...(context.model ? ['--model', context.model] : []),
      '--prompt-interactive',
      ...(context.prompt ? [context.prompt] : []),
    ],
    antigravityModels,
    [],
  ),
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

export async function agentCatalog(): Promise<
  Array<{
    id: AgentId;
    displayName: string;
    installed: boolean;
    version: string | null;
    models: ModelOption[];
    efforts: string[];
  }>
> {
  return Promise.all(
    agents.map(async (agent) => {
      const installation = await agent.detectInstallation();
      const installed = installation.status === 'ready';
      const [version, models] = installed
        ? await Promise.all([agent.getVersion(), agent.getModels()])
        : [null, []];
      return {
        id: agent.id,
        displayName: agent.displayName,
        installed,
        version,
        models,
        efforts: await agent.getEffortLevels(),
      };
    }),
  );
}
