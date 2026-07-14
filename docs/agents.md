# Agent adapters

Every provider-specific detail — the executable name, how the prompt is passed, and how exit
codes are interpreted — lives behind an `AgentAdapter`. This keeps `lifecycle.ts` and the
command layer provider-agnostic. The interface is in `src/agents/adapter.ts`; the concrete
implementations are in `src/agents/registry.ts`.

## The adapter contract

```ts
type AgentId = 'claude' | 'codex' | 'gemini' | 'antigravity';

interface AgentAdapter {
  readonly id: AgentId;
  readonly displayName: string;
  readonly executable: string;

  detectInstallation(): Promise<InstallationResult>; // ready | not_installed | error
  detectAuthentication(): Promise<AuthResult>; // ready | not_authenticated |
  //   unknown | unsupported | error
  getVersion(): Promise<string | null>;
  getModels(): Promise<ModelOption[]>;
  getEffortLevels(model?: string): Promise<string[]>;

  buildInteractiveCommand(ctx: AgentRunContext): Promise<CommandSpec>;
  buildNonInteractiveCommand?(ctx: AgentRunContext): Promise<CommandSpec>; // optional

  classifyExit(result: ProcessResult): Promise<{
    reason: AgentExitReason;
    confidence: 'low' | 'medium' | 'high';
  }>;
}

interface CommandSpec {
  executable: string;
  args: string[];
}
interface AgentRunContext {
  projectRoot: string;
  prompt: string;
  providerSettingsPath?: string;
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
  stdout: string;
  stderr: string;
}
```

`AgentExitReason` is the full vocabulary the interface allows:

```
completed | user_cancelled | usage_limit | rate_limit | authentication_error |
permission_error | command_not_found | provider_unavailable | context_limit |
network_error | unknown_failure
```

## The registered agents

`OfficialCliAdapter` implements the contract generically; the registry constructs one per
provider:

| id            | displayName | executable | Prompt passed as                   |
| ------------- | ----------- | ---------- | ---------------------------------- |
| `claude`      | Claude      | `claude`   | `[prompt]` (positional)            |
| `codex`       | Codex       | `codex`    | `[prompt]` (positional)            |
| `gemini`      | Gemini      | `gemini`   | `["--prompt-interactive", prompt]` |
| `antigravity` | Antigravity | `agy`      | `["--prompt-interactive", prompt]` |

### Model and effort discovery

- Claude publishes verified aliases (`sonnet`, `opus`, `fable`) and effort levels through the
  adapter.
- Codex reads `codex debug models` and preserves model-specific reasoning levels from the JSON
  catalog.
- Antigravity uses model variants verified against `agy models`; that command requires a TTY,
  so the background catalog is static and custom IDs cover newer variants. The names encode
  effort where applicable, so Relay does not pass a separate effort flag.
- Gemini accepts `--model` but has no verified model-list or effort discovery path here.

`relay agents --json` exposes this metadata to Rirei. Adapter validation rejects model values
that look like flags and effort values unsupported by the selected provider.

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

`detectExecutable(name)` scans each `PATH` entry for a file with the executable bit
(`constants.X_OK`) and returns `ready` or `not_installed`. This is what `relay doctor`'s
`Installed` column reports.

### Authentication detection

`detectAuthentication()` returns a **conservative** result: status `unknown` with the detail
"Relay does not inspect provider credential files." Relay deliberately never reads provider
credential files or tokens, so it cannot (and will not) claim `ready` from the outside. See
[security.md](security.md).

### Version detection

`getVersion()` runs `<executable> --version` with a 10-second timeout and returns the trimmed
output, or `null` on any failure.

### Exit classification

`classifyExit()` today uses documented, machine-readable signals only:

| Signal                                      | Reason              | Confidence |
| ------------------------------------------- | ------------------- | ---------- |
| `exitCode === 0`                            | `completed`         | high       |
| `signal === "SIGINT"` or `exitCode === 130` | `user_cancelled`    | high       |
| `exitCode === 127`                          | `command_not_found` | medium     |
| anything else                               | `unknown_failure`   | low        |

This is intentionally cautious: it **never** claims `usage_limit`, `rate_limit`, or
`authentication_error` from a bare exit code, because doing so would risk falsely telling the
user a limit was hit. The tradeoff is that Relay's headline "usage-limit-aware switching" is
not yet realized — a rate-limited agent currently classifies as `unknown_failure`.

### Non-interactive mode

`buildNonInteractiveCommand` is optional and **not implemented** by `OfficialCliAdapter`.
That is why `relay doctor` prints `Unknown` for the `Interactive` and `Headless` columns:
capabilities are not probed, and headless execution has no code path yet.

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
