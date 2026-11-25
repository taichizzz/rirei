# Agent adapters

Every provider-specific detail — the executable name, how the prompt is passed, and how exit
codes are interpreted — lives behind an `AgentAdapter`. This keeps `lifecycle.ts` and the
command layer provider-agnostic. The interface is in `src/agents/adapter.ts`; the concrete
implementations are in `src/agents/registry.ts`.

## The adapter contract

```ts
type AgentId = 'claude' | 'codex' | 'gemini' | 'antigravity' | 'opencode';

interface AgentAdapter {
  readonly id: AgentId;
  readonly displayName: string;
  readonly executable: string;
  readonly capabilities: AgentCapabilities;
  readonly resumeCapabilities?: ResumeCapabilities;

  detectInstallation(): Promise<InstallationResult>; // ready | not_installed | error
  detectAuthentication(): Promise<AuthenticationSnapshot>;
  getVersion(): Promise<string | null>;
  getModels(): Promise<DiscoveryResult<ModelOption>>;
  getEffortLevels(model?: string): Promise<string[]>;

  buildInteractiveCommand(ctx: AgentRunContext): Promise<CommandSpec>;
  buildResumeCommand?(ctx: AgentResumeContext): Promise<CommandSpec>;
  buildNonInteractiveCommand?(ctx: AgentRunContext): Promise<CommandSpec>; // optional

  prepareUsageCollection?(
    ctx: UsageCollectionContext,
  ): Promise<UsagePreparation>;
  readUsage?(ctx: UsageCollectionContext): Promise<ProviderUsageSnapshot[]>;
  classifyExit(result: ProcessResult): Promise<ExitClassification>;
}

interface AuthenticationSnapshot {
  status:
    | 'authenticated'
    | 'not_authenticated'
    | 'configured'
    | 'unknown'
    | 'unsupported'
    | 'error';
  checkedAt: string;
  source: AuthenticationSource;
  confidence: 'low' | 'medium' | 'high';
  detail?: string;
  scopes?: AuthenticationScope[];
}
interface DiscoveryResult<T> {
  status: 'available' | 'unavailable' | 'unsupported' | 'error';
  values: T[];
  source: string;
  detail?: string;
}
interface ExitClassification {
  reason: AgentExitReason;
  confidence: 'low' | 'medium' | 'high';
  source:
    | 'user_intent'
    | 'spawn'
    | 'provider_event'
    | 'provider_exit_code'
    | 'signal'
    | 'fallback';
  providerCode?: string;
  retryAt?: string;
}

interface CommandSpec {
  executable: string;
  args: string[];
}
interface AgentRunContext {
  projectRoot: string;
  prompt: string;
  providerSettingsPath?: string;
  providerSessionId?: string;
  model?: string;
  effort?: string;
}
interface ModelOption {
  id: string;
  label: string;
  efforts?: string[];
}
interface ProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  spawnErrorCode?: string;
  terminationIntent:
    | 'none'
    | 'user_interrupt'
    | 'user_stop'
    | 'renderer_failure'
    | 'controller_loss'
    | 'bridge_failure';
  observations: ProviderObservation[];
  stdout: string;
  stderr: string;
}
```

`AgentExitReason` is the full vocabulary the interface allows:

```
completed | user_cancelled | usage_limit | rate_limit | authentication_error |
permission_error | command_not_found | provider_unavailable | context_limit |
network_error | interrupted | unknown_failure
```

Claude, Codex, and OpenCode expose provider-specific resume builders. Relay records whether a launch is
new, resumed, or forked, but the provider CLI remains responsible for loading conversation
state. A resume always starts a new process and PTY; Relay does not reattach an old terminal.

## The registered agents

`OfficialCliAdapter` implements the common official-CLI behavior. OpenCode uses a bespoke
`OpenCodeAdapter` because its multi-provider auth scopes, model names, prompt flags, and
resume/fork semantics are distinct:

| id            | displayName | executable | Prompt passed as                   |
| ------------- | ----------- | ---------- | ---------------------------------- |
| `claude`      | Claude      | `claude`   | `[prompt]` (positional)            |
| `codex`       | Codex       | `codex`    | `[prompt]` (positional)            |
| `gemini`      | Gemini      | `gemini`   | `["--prompt-interactive", prompt]` |
| `antigravity` | Antigravity | `agy`      | `["--prompt-interactive", prompt]` |
| `opencode`    | OpenCode    | `opencode` | `["--prompt", prompt]`             |

### Model and effort discovery

- Claude publishes verified aliases (`sonnet`, `opus`, `fable`) and effort levels through the
  adapter.
- Codex reads `codex debug models` and preserves model-specific reasoning levels from the JSON
  catalog.
- Antigravity uses model variants verified against `agy models`; that command requires a TTY,
  so the background catalog is static and custom IDs cover newer variants. The names encode
  effort where applicable, so Relay does not pass a separate effort flag.
- Gemini accepts `--model` but has no verified model-list or effort discovery path here.
- OpenCode reads live `provider/model` lines from `opencode models` and detects configured
  providers through `opencode auth list`. It has no fixed effort vocabulary, and auth status
  is `configured` — Relay never claims the tokens are valid.
- OpenCode resume targets are `--continue` (latest) and `--session <id>`; forks use `--fork`
  alongside either. The adapter stays inert unless the `opencode` binary is installed — Relay
  does not bundle it. Headless `opencode run` exists upstream, but this adapter (like every
  other) does not implement non-interactive execution yet.

`relay agents --json` exposes this metadata to Rirei. Adapter validation rejects model values
that look like flags and effort values unsupported by the selected provider.

### Structured lifecycle

Desktop daemon launches provide a terminal-scoped lifecycle token and local reporter. Claude,
Codex, and OpenCode advertise `structuredEvents: true`:

- Claude uses generated official hooks for permission and user-question waits.
- Codex keeps the native TUI but launches it through a capability-token-authenticated loopback
  app-server supervisor with a passive status observer.
- OpenCode keeps the native TUI and observes its random-password loopback SSE/REST API.

These integrations report only `working`, `needs_permission`, or `waiting_for_input`. They do
not answer requests, run commands, or synthesize terminal input. CLI launches outside the
desktop daemon do not use the supervisors. Gemini and Antigravity retain conservative terminal
fallback behavior and advertise no structured event capability.

> Gemini's flag matters: `--prompt-interactive` (`-i`) starts a real interactive session
> seeded with the prompt. Plain `--prompt` would run headless — it answers once and exits,
> and headless mode refuses to launch the first-run auth picker, failing with
> "Please set an Auth method…" until the user has logged in interactively at least once.
>
> **Antigravity** (`agy`) is Google's successor to Gemini CLI for individual accounts,
> including Google AI Pro/Ultra. As of 2026-06-18 the `gemini` CLI stopped serving individual
> (free/Pro/Ultra) "Sign in with Google" accounts — those users migrate to Antigravity. The
> `gemini` adapter is kept for API-key and enterprise users; the desktop agent deck surfaces
> Antigravity in its place. `agy` shares Gemini's flag shape (`--prompt-interactive` for an
> interactive session, `--prompt`/`-p` for headless). Verify the binary and flags against
> `agy --help` on the target machine — this is isolated in the adapter so only one line changes
> if they differ.

### Installation detection

`detectExecutable(name)` delegates to `src/platform/executable.ts`. POSIX search checks
executability; Windows search supports case-insensitive filenames and `PATHEXT` wrappers.
`cross-spawn` handles provider wrapper invocation. Installation is distinct from authentication,
native lifecycle delivery, or model availability. This feeds `relay doctor`'s Installed column.

### Authentication detection

Authentication discovery is adapter-owned and cached for 45 seconds. Claude uses
`claude auth status --json`; Codex uses the bounded output of `codex login status`; OpenCode
uses `opencode auth list` and reports backing scopes as `configured`, never remotely verified.
Gemini and Antigravity remain `unknown`. Relay never reads credential files or tokens. See
[security.md](security.md).

### Version detection

`getVersion()` runs `<executable> --version` with a 10-second timeout and returns the trimmed
output, or `null` on any failure.

### Exit classification

`classifyExit()` today uses documented, machine-readable signals only:

| Evidence                            | Reason                   | Confidence  |
| ----------------------------------- | ------------------------ | ----------- |
| explicit interrupt/stop intent      | `user_cancelled`         | high        |
| spawn `ENOENT`                      | `command_not_found`      | high        |
| other spawn failure                 | `provider_unavailable`   | high        |
| exit code `0`                       | `completed`              | high        |
| structured provider observation     | provider-specific reason | medium/high |
| signal without explicit user intent | `interrupted`            | medium      |
| generic nonzero exit                | `unknown_failure`        | low         |

This is intentionally cautious: it never claims `usage_limit`, `rate_limit`, or
`authentication_error` from free-form TUI text or a bare exit code.

`ProcessResult.observations` accepts at most 16 allow-listed `ProviderObservation` signals.
When present, specific kinds (`rate_limit`, `usage_limit`,
`authentication`, `network`) upgrade the outcome to `provider_event` at high confidence, and a
bare `provider_error` yields `provider_unavailable` at medium confidence. Providers that emit
these observations fulfill Relay's structured-events capability; providers that do not simply
fall back to the conservative exit-code table.

### Non-interactive mode

`buildNonInteractiveCommand` is optional and **not implemented** by `OfficialCliAdapter`.
`relay doctor` prints advertised Interactive/Headless **Yes/No** capability values, not a live
execution probe. A native provider's separate headless command does not mean this adapter
implements it. Benchmark-specific `exec`/print launch paths have separate qualification.

### Rationale and boundaries

Adapter capabilities keep provider-specific launch/model/resume behavior out of generic callers.
The daemon still has a small structured-provider status boundary, and the prototype capture
launcher deliberately targets Claude; the implementation is not perfectly provider-name-free.
Fresh quota evidence can refine a nonzero run result at medium confidence outside the bare exit
adapter, without overriding a clean exit or explicit cancellation. See
[ADR-003 and ADR-013](architecture-decisions.md), [runtime protocols](runtime-protocols.md), and
[continuity architecture](continuity-architecture.md) for those separate data paths.

## Detection priority (design guideline)

When extending `classifyExit` for a provider, prefer signals in this order and fall back to
`unknown_failure` when uncertain:

1. Documented exit codes.
2. Structured JSON output.
3. Stable machine-readable fields.
4. Conservative text-pattern matching (last resort — provider text changes over time).

Keep every provider-specific flag, prompt shape, and pattern inside that provider's adapter,
and cover it with fixture-based tests so CLI output changes are caught.

## Adding a new adapter

1. Add the new id to the `AgentId` union in `src/agents/adapter.ts`.
2. Construct another `OfficialCliAdapter` in `src/agents/registry.ts` (or a bespoke class if
   the provider needs custom prompt/exit handling).
3. If prompt-passing or exit semantics differ, override `buildInteractiveCommand` /
   `classifyExit` in a dedicated adapter class rather than bending the generic one.
4. Add fixture-based tests for installation detection and exit classification.
5. Update this table and [cli-reference.md](cli-reference.md).
