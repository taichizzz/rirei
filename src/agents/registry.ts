import path from 'node:path';
import spawn from 'cross-spawn';
import { isExecutableInstalled } from '../platform/executable.js';
import { killProcessTree } from '../platform/process-control.js';
import {
  type AgentAdapter,
  type AgentCapabilities,
  type AgentId,
  type AgentRunContext,
  type AgentResumeContext,
  type AuthenticationSnapshot,
  type CommandSpec,
  type DiscoveryResult,
  type ExitClassification,
  type InstallationResult,
  type ModelOption,
  type ProcessResult,
  type ProviderObservation,
  type ProviderUsageSnapshot,
  type UsageCollectionContext,
  type UsagePreparation,
} from './adapter.js';
import {
  claudePrepareUsage,
  claudeReadUsage,
  codexReadUsage,
} from './usage-collectors.js';

const EXEC_TIMEOUT_MS = 10_000;
const AUTH_PROBE_TIMEOUT_MS = 5_000;
const AUTH_PROBE_MAX_BYTES = 64 * 1024;
const AUTH_CACHE_MS = 45_000;
const authenticationCache = new Map<AgentId, AuthenticationSnapshot>();

interface ExecutableOutput {
  stdout: string;
  stderr: string;
}

interface ExecutableOptions {
  timeout: number;
  maxBuffer?: number;
}

function runExecutable(
  executable: string,
  args: string[],
  options: ExecutableOptions,
): Promise<ExecutableOutput> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const maxBuffer = options.maxBuffer ?? 1024 * 1024;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let killed = false;
    let errorCode: string | undefined;
    let settled = false;

    const output = (): ExecutableOutput => ({
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
    });
    const fail = (message: string, code?: string) => {
      const error = Object.assign(new Error(message), output(), {
        code,
        killed,
      });
      reject(error);
    };
    const abort = (code: string, message: string) => {
      if (settled) return;
      settled = true;
      killed = true;
      errorCode = code;
      globalThis.clearTimeout(timer);
      child.stdout?.destroy();
      child.stderr?.destroy();
      if (child.pid) void killProcessTree(child.pid);
      else child.kill();
      fail(message, code);
    };
    const append = (chunks: Buffer[], chunk: Buffer, current: number) => {
      const remaining = Math.max(0, maxBuffer - current);
      if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
      if (chunk.length > remaining)
        abort(
          'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
          `${executable} exceeded the output limit.`,
        );
      return current + chunk.length;
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBytes = append(stdout, Buffer.from(chunk), stdoutBytes);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBytes = append(stderr, Buffer.from(chunk), stderrBytes);
    });
    child.once('error', (error: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timer);
      fail(`Failed to start ${executable}.`, error.code);
    });
    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timer);
      if (code === 0 && !errorCode) resolve(output());
      else
        fail(
          `${executable} exited with ${code ?? signal ?? 'an error'}.`,
          errorCode ?? (code === null ? (signal ?? undefined) : String(code)),
        );
    });
    const timer = globalThis.setTimeout(
      () => abort('ETIMEDOUT', `${executable} timed out.`),
      options.timeout,
    );
  });
}

function lifecycleWrappedCommand(
  environmentName:
    'RIREI_CODEX_LIFECYCLE_WRAPPER' | 'RIREI_OPENCODE_LIFECYCLE_WRAPPER',
  executable: string,
  args: string[],
): CommandSpec {
  const wrapper = process.env[environmentName];
  const node = process.env.RIREI_NODE_PATH;
  const terminalId = process.env.RIREI_TERMINAL_ID;
  const lifecycleHook = process.env.RIREI_LIFECYCLE_HOOK;
  const lifecycleToken = process.env.RIREI_LIFECYCLE_TOKEN;
  return wrapper &&
    node &&
    terminalId &&
    lifecycleHook &&
    lifecycleToken &&
    path.isAbsolute(wrapper) &&
    path.isAbsolute(node) &&
    path.isAbsolute(lifecycleHook)
    ? { executable: node, args: [wrapper, ...args] }
    : { executable, args };
}

async function cachedAuthentication(
  id: AgentId,
  probe: () => Promise<AuthenticationSnapshot>,
): Promise<AuthenticationSnapshot> {
  const cached = authenticationCache.get(id);
  if (cached && Date.now() - Date.parse(cached.checkedAt) < AUTH_CACHE_MS)
    return cached;
  const snapshot = await probe();
  authenticationCache.set(id, snapshot);
  return snapshot;
}

export function clearAuthenticationCache(): void {
  authenticationCache.clear();
}

const CAPABILITIES = {
  claude: {
    interactive: true,
    headless: false,
    modelDiscovery: true,
    modelVariants: true,
    authenticationDiscovery: true,
    usageCollection: true,
    structuredEvents: true,
  } satisfies AgentCapabilities,
  codex: {
    interactive: true,
    headless: false,
    modelDiscovery: true,
    modelVariants: true,
    authenticationDiscovery: true,
    usageCollection: true,
    structuredEvents: true,
  } satisfies AgentCapabilities,
  gemini: {
    interactive: true,
    headless: false,
    modelDiscovery: false,
    modelVariants: false,
    authenticationDiscovery: false,
    usageCollection: false,
    structuredEvents: false,
  } satisfies AgentCapabilities,
  antigravity: {
    interactive: true,
    headless: false,
    modelDiscovery: true,
    modelVariants: true,
    authenticationDiscovery: false,
    usageCollection: false,
    structuredEvents: false,
  } satisfies AgentCapabilities,
  opencode: {
    interactive: true,
    headless: false,
    modelDiscovery: true,
    modelVariants: false,
    authenticationDiscovery: true,
    usageCollection: false,
    structuredEvents: true,
  } satisfies AgentCapabilities,
} as const satisfies Record<AgentId, AgentCapabilities>;

class OfficialCliAdapter implements AgentAdapter {
  constructor(
    readonly id: AgentId,
    readonly displayName: string,
    readonly executable: string,
    readonly capabilities: AgentCapabilities,
    private readonly promptArgs: (context: AgentRunContext) => string[],
    private readonly models: () => Promise<DiscoveryResult<ModelOption>>,
    private readonly effortLevels: string[],
    private readonly resumeArgs?: (context: AgentResumeContext) => string[],
    readonly resumeCapabilities?: {
      targets: Array<'latest' | 'picker' | 'id'>;
      supportsFork: boolean;
      exposesNewSessionId: boolean;
    },
    private readonly authProbe?: () => Promise<AuthenticationSnapshot>,
    private readonly usageCollect?: (
      context: UsageCollectionContext,
    ) => Promise<UsagePreparation>,
    private readonly usageReader?: (
      context: UsageCollectionContext,
    ) => Promise<ProviderUsageSnapshot[]>,
    private readonly commandWrapper?: (args: string[]) => CommandSpec,
  ) {}

  prepareUsageCollection(
    context: UsageCollectionContext,
  ): Promise<UsagePreparation> {
    if (!this.usageCollect)
      return Promise.resolve({
        providerSettingsPath: undefined,
        preparedAt: new Date().toISOString(),
      });
    return this.usageCollect(context);
  }
  readUsage(context: UsageCollectionContext): Promise<ProviderUsageSnapshot[]> {
    if (!this.usageReader)
      return Promise.resolve([
        {
          adapterId: this.id,
          status: 'unknown',
          capturedAt: null,
          source: 'Unavailable',
          metrics: [],
        },
      ]);
    return this.usageReader(context);
  }

  detectInstallation(): Promise<InstallationResult> {
    return detectExecutable(this.executable);
  }
  async detectAuthentication(): Promise<AuthenticationSnapshot> {
    return cachedAuthentication(this.id, () =>
      this.authProbe
        ? this.authProbe()
        : Promise.resolve(conservativeAuthenticationStatus()),
    );
  }
  async getVersion(): Promise<string | null> {
    try {
      const { stdout, stderr } = await runExecutable(
        this.executable,
        ['--version'],
        {
          timeout: EXEC_TIMEOUT_MS,
        },
      );
      return (stdout || stderr).trim() || null;
    } catch {
      return null;
    }
  }
  getModels(): Promise<DiscoveryResult<ModelOption>> {
    return this.models();
  }
  async getEffortLevels(model?: string): Promise<string[]> {
    if (!model) return this.effortLevels;
    const discovery = await this.models();
    if (discovery.status !== 'available') return this.effortLevels;
    return (
      discovery.values.find((option) => option.id === model)?.efforts ??
      this.effortLevels
    );
  }
  async buildInteractiveCommand(
    context: AgentRunContext,
  ): Promise<CommandSpec> {
    this.validateSelection(context);
    const args = this.promptArgs(context);
    return (
      this.commandWrapper?.(args) ?? {
        executable: this.executable,
        args,
      }
    );
  }
  async buildResumeCommand(context: AgentResumeContext): Promise<CommandSpec> {
    if (!this.resumeArgs || !this.resumeCapabilities)
      throw new Error(`${this.displayName} does not support session resume.`);
    if (!this.resumeCapabilities.targets.includes(context.resumeTargetKind))
      throw new Error(
        `${this.displayName} does not support ${context.resumeTargetKind} session resume.`,
      );
    if (context.fork && !this.resumeCapabilities.supportsFork)
      throw new Error(`${this.displayName} does not support session forks.`);
    if (context.resumeTargetKind === 'picker' && context.prompt)
      throw new Error(
        `${this.displayName} session pickers cannot accept an initial prompt; use --latest or --id.`,
      );
    this.validateSelection(context);
    const args = this.resumeArgs(context);
    return (
      this.commandWrapper?.(args) ?? {
        executable: this.executable,
        args,
      }
    );
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
  classifyExit(result: ProcessResult): Promise<ExitClassification> {
    return Promise.resolve(classifyProcessExit(result));
  }
}

class OpenCodeAdapter implements AgentAdapter {
  readonly id = 'opencode' as const;
  readonly displayName = 'OpenCode';
  readonly executable = 'opencode';
  readonly capabilities = CAPABILITIES.opencode;
  readonly resumeCapabilities = {
    targets: ['latest', 'id'] as Array<'latest' | 'id'>,
    supportsFork: true,
    exposesNewSessionId: false,
  };

  detectInstallation(): Promise<InstallationResult> {
    return detectExecutable(this.executable);
  }

  async detectAuthentication(): Promise<AuthenticationSnapshot> {
    return cachedAuthentication(this.id, opencodeAuthProbe);
  }

  async getVersion(): Promise<string | null> {
    try {
      const { stdout, stderr } = await runExecutable(
        this.executable,
        ['--version'],
        { timeout: EXEC_TIMEOUT_MS },
      );
      return (stdout || stderr).trim().slice(0, 200) || null;
    } catch {
      return null;
    }
  }

  getModels(): Promise<DiscoveryResult<ModelOption>> {
    return opencodeModels();
  }

  getEffortLevels(): Promise<string[]> {
    return Promise.resolve([]);
  }

  async buildInteractiveCommand(
    context: AgentRunContext,
  ): Promise<CommandSpec> {
    this.validateContext(context);
    return lifecycleWrappedCommand(
      'RIREI_OPENCODE_LIFECYCLE_WRAPPER',
      this.executable,
      [
        ...(context.model ? ['--model', context.model] : []),
        ...(context.prompt ? ['--prompt', context.prompt] : []),
      ],
    );
  }

  async buildResumeCommand(context: AgentResumeContext): Promise<CommandSpec> {
    this.validateContext(context);
    if (context.resumeTargetKind === 'picker')
      throw new Error(
        'OpenCode does not expose a CLI session picker; use --latest or --id.',
      );
    if (context.resumeTargetKind === 'id' && !context.resumeTargetValue?.trim())
      throw new Error('OpenCode exact resume requires a session ID.');
    return lifecycleWrappedCommand(
      'RIREI_OPENCODE_LIFECYCLE_WRAPPER',
      this.executable,
      [
        ...(context.model ? ['--model', context.model] : []),
        ...(context.resumeTargetKind === 'latest'
          ? ['--continue']
          : ['--session', context.resumeTargetValue!]),
        ...(context.fork ? ['--fork'] : []),
        ...(context.prompt ? ['--prompt', context.prompt] : []),
      ],
    );
  }

  classifyExit(result: ProcessResult): Promise<ExitClassification> {
    return Promise.resolve(classifyProcessExit(result));
  }

  private validateContext(context: AgentRunContext): void {
    if (context.effort)
      throw new Error(
        'OpenCode effort variants are selected inside its TUI; --effort is unsupported.',
      );
    if (
      context.model &&
      (context.model.length > 120 ||
        context.model.startsWith('-') ||
        !OPENCODE_MODEL_TOKEN.test(context.model))
    )
      throw new Error(
        'OpenCode models must use a valid provider/model identifier.',
      );
  }
}

function classifyProcessExit(result: ProcessResult): ExitClassification {
  const terminationIntent = result.terminationIntent ?? 'none';
  const observations = result.observations ?? [];
  if (
    terminationIntent === 'user_interrupt' ||
    terminationIntent === 'user_stop'
  )
    return {
      reason: 'user_cancelled',
      confidence: 'high',
      source: 'user_intent',
      providerCode: terminationIntent,
    };
  if (
    terminationIntent === 'renderer_failure' ||
    terminationIntent === 'controller_loss' ||
    terminationIntent === 'bridge_failure'
  )
    return {
      reason: 'interrupted',
      confidence: 'high',
      source: 'fallback',
      providerCode: terminationIntent,
    };
  if (result.spawnErrorCode)
    return {
      reason:
        result.spawnErrorCode === 'ENOENT'
          ? 'command_not_found'
          : 'provider_unavailable',
      confidence: 'high',
      source: 'spawn',
      providerCode: result.spawnErrorCode,
    };
  if (result.exitCode === 0)
    return {
      reason: 'completed',
      confidence: 'high',
      source: 'provider_exit_code',
      providerCode: '0',
    };
  const observationPriority: ProviderObservation['kind'][] = [
    'rate_limit',
    'usage_limit',
    'authentication',
    'network',
    'provider_error',
  ];
  const providerEvent = observationPriority
    .map((kind) => observations.find((entry) => entry.kind === kind))
    .find((entry) => entry !== undefined);
  if (providerEvent) {
    const reason: ExitClassification['reason'] =
      providerEvent.kind === 'rate_limit'
        ? 'rate_limit'
        : providerEvent.kind === 'usage_limit'
          ? 'usage_limit'
          : providerEvent.kind === 'authentication'
            ? 'authentication_error'
            : providerEvent.kind === 'network'
              ? 'network_error'
              : 'provider_unavailable';
    return {
      reason,
      confidence: providerEvent.kind === 'provider_error' ? 'medium' : 'high',
      source: 'provider_event',
      ...(providerEvent.detail ? { providerCode: providerEvent.detail } : {}),
    };
  }
  if (result.signal || result.exitCode === 130)
    return {
      reason: 'interrupted',
      confidence: 'medium',
      source: 'signal',
      providerCode: result.signal ?? '130',
    };
  return {
    reason: 'unknown_failure',
    confidence: 'low',
    source: 'fallback',
    providerCode:
      result.exitCode !== null ? String(result.exitCode) : undefined,
  };
}

function unavailableModels(source: string): DiscoveryResult<ModelOption> {
  return { status: 'unavailable', values: [], source };
}

async function codexModels(): Promise<DiscoveryResult<ModelOption>> {
  const source = 'codex debug models';
  try {
    const { stdout } = await runExecutable('codex', ['debug', 'models'], {
      timeout: EXEC_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
    });
    const parsed = JSON.parse(stdout) as {
      models?: Array<{
        slug?: unknown;
        display_name?: unknown;
        supported_reasoning_levels?: Array<{ effort?: unknown }>;
      }>;
    };
    return {
      status: 'available',
      values: (parsed.models ?? []).flatMap((model) =>
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
      ),
      source,
    };
  } catch {
    return {
      status: 'error',
      values: [],
      source,
      detail: 'Codex model discovery failed.',
    };
  }
}

function staticModels(
  source: string,
  options: ModelOption[],
): DiscoveryResult<ModelOption> {
  return { status: 'available', values: options, source };
}

const antigravityModels = () =>
  Promise.resolve(
    staticModels(
      'static catalog',
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
    ),
  );

const noModels = (source: string, detail: string) =>
  Promise.resolve<DiscoveryResult<ModelOption>>({
    status: 'unsupported',
    values: [],
    source,
    detail,
  });
const claudeModels = () =>
  Promise.resolve(
    staticModels('static aliases', [
      { id: 'sonnet', label: 'Sonnet' },
      { id: 'opus', label: 'Opus' },
      { id: 'fable', label: 'Fable' },
    ]),
  );

const agents: ReadonlyArray<AgentAdapter> = [
  new OfficialCliAdapter(
    'claude',
    'Claude',
    'claude',
    CAPABILITIES.claude,
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
    {
      targets: ['latest', 'picker', 'id'],
      supportsFork: true,
      exposesNewSessionId: true,
    },
    claudeAuthProbe,
    claudePrepareUsage,
    claudeReadUsage,
  ),
  new OfficialCliAdapter(
    'codex',
    'Codex',
    'codex',
    CAPABILITIES.codex,
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
    {
      targets: ['latest', 'picker', 'id'],
      supportsFork: false,
      exposesNewSessionId: false,
    },
    codexAuthProbe,
    undefined,
    codexReadUsage,
    (args) =>
      lifecycleWrappedCommand('RIREI_CODEX_LIFECYCLE_WRAPPER', 'codex', args),
  ),
  // --prompt-interactive starts a real session; --prompt would run headless
  // and exit (and headless mode refuses to launch the first-run auth picker).
  new OfficialCliAdapter(
    'gemini',
    'Gemini',
    'gemini',
    CAPABILITIES.gemini,
    (context) => [
      ...(context.model ? ['--model', context.model] : []),
      '--prompt-interactive',
      ...(context.prompt ? [context.prompt] : []),
    ],
    () =>
      noModels(
        'none',
        'Gemini model discovery is not exposed by a stable CLI command.',
      ),
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
    CAPABILITIES.antigravity,
    (context) => [
      ...(context.model ? ['--model', context.model] : []),
      '--prompt-interactive',
      ...(context.prompt ? [context.prompt] : []),
    ],
    antigravityModels,
    [],
  ),
  new OpenCodeAdapter(),
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
  const installed = await isExecutableInstalled(executable);
  return { status: installed ? 'ready' : 'not_installed' };
}

export function conservativeAuthenticationStatus(): AuthenticationSnapshot {
  return {
    status: 'unknown',
    checkedAt: new Date().toISOString(),
    source: 'none',
    confidence: 'low',
    detail: 'Relay does not inspect provider credential files.',
  };
}

type PartialSnapshot = Omit<AuthenticationSnapshot, 'checkedAt' | 'source'>;

interface AuthProbe {
  executable: string;
  args: string[];
  source: AuthenticationSnapshot['source'];
  parse: (stdout: string, stderr: string) => PartialSnapshot | undefined;
}

/**
 * Run a short, bounded, non-credential auth probe through the provider's own
 * CLI. Any failure collapses to a conservative `unknown`; Relay never reads
 * credential files and never treats the probe as proof of remote validity.
 */
async function runAuthProbe(probe: AuthProbe): Promise<AuthenticationSnapshot> {
  const checkedAt = new Date().toISOString();
  try {
    const { stdout, stderr } = await runExecutable(
      probe.executable,
      probe.args,
      {
        timeout: AUTH_PROBE_TIMEOUT_MS,
        maxBuffer: AUTH_PROBE_MAX_BYTES,
      },
    );
    const parsed = probe.parse(stdout, stderr);
    if (parsed) return { ...parsed, checkedAt, source: probe.source };
    return {
      status: 'unknown',
      checkedAt,
      source: probe.source,
      confidence: 'low',
      detail: 'Authentication status could not be interpreted.',
    };
  } catch (error) {
    const execError = error as {
      code?: string;
      killed?: boolean;
      stdout?: string | Buffer;
      stderr?: string | Buffer;
    };
    const stdout =
      typeof execError.stdout === 'string'
        ? execError.stdout
        : execError.stdout
          ? String(execError.stdout)
          : '';
    const stderr =
      typeof execError.stderr === 'string'
        ? execError.stderr
        : execError.stderr
          ? String(execError.stderr)
          : '';
    const timedOutOrOversized =
      execError.killed === true ||
      execError.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
    // Providers like Claude write structured output on stdout while exiting
    // non-zero; parse it. Partial output from a timeout or oversize is never
    // trusted.
    if (!timedOutOrOversized) {
      const parsed = probe.parse(stdout, stderr);
      if (parsed) return { ...parsed, checkedAt, source: probe.source };
    }
    return {
      status: 'unknown',
      checkedAt,
      source: probe.source,
      confidence: 'low',
      detail: 'The authentication probe failed.',
    };
  }
}

function parseClaudeAuth(stdout: string): PartialSnapshot | undefined {
  let parsed: {
    loggedIn?: unknown;
    authMethod?: unknown;
    apiProvider?: unknown;
  };
  try {
    parsed = JSON.parse(stdout) as typeof parsed;
  } catch {
    return undefined;
  }
  if (typeof parsed.loggedIn !== 'boolean') return undefined;
  const safeIdentifier = (value: unknown): string | undefined =>
    typeof value === 'string' && /^[a-zA-Z0-9._-]{1,40}$/.test(value)
      ? value
      : undefined;
  const method = safeIdentifier(parsed.authMethod) ?? 'unknown';
  const provider = safeIdentifier(parsed.apiProvider);
  return {
    status: parsed.loggedIn ? 'authenticated' : 'not_authenticated',
    confidence: 'high',
    scopes: [
      {
        providerId: provider ?? 'firstParty',
        status: parsed.loggedIn ? 'authenticated' : 'not_authenticated',
      },
    ],
    detail: `Claude CLI reports ${
      parsed.loggedIn ? 'an active login' : 'no active login'
    } (auth method: ${method}${provider ? `, API provider: ${provider}` : ''}).`,
  };
}

function claudeAuthProbe(): Promise<AuthenticationSnapshot> {
  return runAuthProbe({
    executable: 'claude',
    args: ['auth', 'status', '--json'],
    source: 'official_cli_json',
    parse: parseClaudeAuth,
  });
}

function parseCodexAuth(
  stdout: string,
  stderr: string,
): PartialSnapshot | undefined {
  const text = `${stdout}\n${stderr}`.trim();
  if (!text) return undefined;
  if (/not logged in/i.test(text))
    return {
      status: 'not_authenticated',
      confidence: 'high',
      detail: 'Codex CLI reports no active login.',
    };
  const match =
    text.match(/logged in using\s+(.+)/i) ??
    text.match(/logged in(?: as\s+(.+))?/i);
  if (match) {
    return {
      status: 'authenticated',
      confidence: 'medium',
      detail: 'Codex CLI reports an active login.',
    };
  }
  return undefined;
}

function codexAuthProbe(): Promise<AuthenticationSnapshot> {
  return runAuthProbe({
    executable: 'codex',
    args: ['login', 'status'],
    source: 'official_cli_status',
    parse: parseCodexAuth,
  });
}

const OPENCODE_MODEL_TOKEN =
  /^([A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._:/-]*)$/;

/** Strip ANSI SGR sequences without embedding a literal control character. */
const ANSI_ESCAPE_CODES = new RegExp(
  `${String.fromCharCode(0x1b)}\\[[0-9;]*m`,
  'g',
);

/**
 * OpenCode advertises models as `provider/model` lines from `opencode models`.
 * The CLI is provider-agnostic (it proxies whatever providers are configured),
 * so the catalog is not a fixed provider list and cannot be cached statically.
 */
async function opencodeModels(): Promise<DiscoveryResult<ModelOption>> {
  const source = 'opencode models';
  try {
    const { stdout } = await runExecutable('opencode', ['models'], {
      timeout: EXEC_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
    });
    const values: ModelOption[] = [];
    for (const line of stdout.split(/\r?\n/)) {
      const match = line
        .replace(ANSI_ESCAPE_CODES, '')
        .trim()
        .match(OPENCODE_MODEL_TOKEN);
      if (!match) continue;
      const id = match[1]!;
      if (!values.some((option) => option.id === id))
        values.push({ id, label: id });
    }
    if (values.length === 0)
      return {
        status: 'error',
        values: [],
        source,
        detail: 'opencode models produced no provider/model lines.',
      };
    values.sort((left, right) => left.id.localeCompare(right.id));
    return { status: 'available', values, source };
  } catch {
    return {
      status: 'error',
      values: [],
      source,
      detail: 'OpenCode model discovery failed.',
    };
  }
}

function parseOpencodeAuth(stdout: string): PartialSnapshot | undefined {
  const scopes: NonNullable<PartialSnapshot['scopes']> = [];
  for (const line of stdout.split(/\r?\n/)) {
    const cleaned = line
      .replace(ANSI_ESCAPE_CODES, '')
      .trim()
      .replace(/^[│┌└]\s*/u, '')
      .replace(/^[✓✔✗✘■●]\s*/u, '')
      .replace(/^[-*+]\s*/, '')
      .trim();
    const credential = cleaned.match(
      /^([A-Za-z0-9][A-Za-z0-9 ._-]*?)\s+(?:oauth|api[- ]?key)$/i,
    );
    const candidate = credential
      ? credential[1]!.trim().toLowerCase().replace(/\s+/g, '-')
      : cleaned;
    if (
      /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(candidate) &&
      candidate.toLowerCase() !== 'credentials' &&
      !scopes.some((scope) => scope.providerId === candidate)
    )
      scopes.push({ providerId: candidate, status: 'configured' });
  }
  if (scopes.length > 0)
    return {
      status: 'configured',
      confidence: 'medium',
      scopes,
      detail: `OpenCode reports ${scopes.length} configured provider(s).`,
    };
  if (/no (credentials|providers|login)/i.test(stdout))
    return {
      status: 'not_authenticated',
      confidence: 'medium',
      detail: 'OpenCode auth list reports no configured providers.',
    };
  return undefined;
}

function opencodeAuthProbe(): Promise<AuthenticationSnapshot> {
  return runAuthProbe({
    executable: 'opencode',
    args: ['auth', 'list'],
    source: 'configured_provider_list',
    parse: parseOpencodeAuth,
  });
}

export function isAgentId(value: string): value is AgentId {
  return agents.some((agent) => agent.id === value);
}

export interface AgentCatalogEntry {
  id: AgentId;
  displayName: string;
  installed: boolean;
  version: string | null;
  capabilities: AgentCapabilities;
  resumeCapabilities?: AgentAdapter['resumeCapabilities'];
  authentication?: AuthenticationSnapshot;
  models: DiscoveryResult<ModelOption>;
  efforts: string[];
}

export async function agentCatalog(): Promise<AgentCatalogEntry[]> {
  return Promise.all(
    agents.map(async (agent) => {
      const installation = await agent.detectInstallation();
      const installed = installation.status === 'ready';
      const [version, models] = installed
        ? await Promise.all([agent.getVersion(), agent.getModels()])
        : [null, unavailableModels(`${agent.executable} not installed`)];
      return {
        id: agent.id,
        displayName: agent.displayName,
        installed,
        version,
        capabilities: agent.capabilities,
        resumeCapabilities: agent.resumeCapabilities,
        authentication: installed
          ? await agent.detectAuthentication()
          : undefined,
        models,
        efforts: await agent.getEffortLevels(),
      };
    }),
  );
}
