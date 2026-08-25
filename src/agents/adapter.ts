export type AgentId =
  'claude' | 'codex' | 'gemini' | 'antigravity' | 'opencode';

export interface InstallationResult {
  status: 'ready' | 'not_installed' | 'error';
  detail?: string;
}

export type AuthenticationStatus =
  | 'authenticated'
  | 'not_authenticated'
  | 'configured'
  | 'unknown'
  | 'unsupported'
  | 'error';

export type AuthenticationSource =
  | 'official_cli_json'
  | 'official_cli_status'
  | 'configured_provider_list'
  | 'none';

/**
 * A conservative, non-secret view of provider authentication. `configured`
 * means only that credentials or provider configuration exist; it never claims
 * that tokens are valid or that the account can currently authenticate.
 */
export interface AuthenticationSnapshot {
  status: AuthenticationStatus;
  checkedAt: string;
  source: AuthenticationSource;
  confidence: 'low' | 'medium' | 'high';
  detail?: string;
  scopes?: AuthenticationScope[];
}

export interface AuthenticationScope {
  providerId?: string;
  status: 'configured' | 'authenticated' | 'not_authenticated' | 'unknown';
}

export interface CommandSpec {
  executable: string;
  args: string[];
}

export interface AgentRunContext {
  projectRoot: string;
  prompt: string;
  providerSettingsPath?: string;
  providerSessionId?: string;
  model?: string;
  effort?: string;
}

export type ResumeTargetKind = 'latest' | 'picker' | 'id';

export interface AgentResumeContext extends AgentRunContext {
  resumeTargetKind: ResumeTargetKind;
  resumeTargetValue?: string;
  fork: boolean;
}

export interface ModelOption {
  id: string;
  label: string;
  efforts?: string[];
}

/**
 * Discovery failures are never silently collapsed into an empty list. Callers
 * can distinguish a genuine empty catalog from an unavailable or malformed
 * source and surface the reason to the user.
 */
export interface DiscoveryResult<T> {
  status: 'available' | 'unavailable' | 'unsupported' | 'error';
  values: T[];
  source: string;
  detail?: string;
}

export interface ProcessResult {
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

export const AGENT_EXIT_REASONS = [
  'completed',
  'user_cancelled',
  'usage_limit',
  'rate_limit',
  'authentication_error',
  'permission_error',
  'command_not_found',
  'provider_unavailable',
  'context_limit',
  'network_error',
  'interrupted',
  'unknown_failure',
] as const;

export type AgentExitReason = (typeof AGENT_EXIT_REASONS)[number];

export const EXIT_CLASSIFICATION_SOURCES = [
  'user_intent',
  'spawn',
  'provider_event',
  'provider_exit_code',
  'signal',
  'fallback',
] as const;

export type ExitClassificationSource =
  (typeof EXIT_CLASSIFICATION_SOURCES)[number];

/**
 * The complete, durable classification of a provider exit. Confidence and
 * evidence source are retained so recovery and UI can distinguish a verified
 * outcome from a best-effort guess.
 */
export interface ExitClassification {
  reason: AgentExitReason;
  confidence: 'low' | 'medium' | 'high';
  source: ExitClassificationSource;
  providerCode?: string;
  retryAt?: string;
}

/**
 * Advertised capabilities describe what a provider adapter can do without
 * hard-coding provider names in CLI or desktop validation layers.
 */
export interface AgentCapabilities {
  interactive: boolean;
  headless: boolean;
  modelDiscovery: boolean;
  modelVariants: boolean;
  authenticationDiscovery: boolean;
  usageCollection: boolean;
  structuredEvents: boolean;
}

export interface ResumeCapabilities {
  /** Which resume targets the CLI supports, e.g. `latest`, `picker`, or `id`. */
  targets: ResumeTargetKind[];
  supportsFork: boolean;
  /**
   * Whether a new session can be started under a Relay-assigned provider
   * session ID (for example Claude's `--session-id`). When false, new sessions
   * have no durable provider session ID.
   */
  exposesNewSessionId: boolean;
}

export interface UsagePreparation {
  providerSettingsPath?: string;
  preparedAt: string;
}

export type UsageMetricStatus = 'available' | 'stale';
export type UsageMetricStatusReason =
  'live' | 'sample_stale' | 'window_expired' | 'invalid_capture';

export type UsageMetricKind =
  'quota' | 'requests' | 'tokens' | 'credits' | 'cost';
export type UsageMetricUnit =
  'percent' | 'requests' | 'tokens' | 'credits' | 'currency';

export interface UsageWindow {
  label: string;
  durationSeconds?: number;
}

/**
 * One bounded, sanitized usage observation. Windows are arbitrary: a provider
 * may report a five-hour quota, a weekly percentage, request counts, or token
 * usage without forcing Relay into a fixed two-window model.
 */
export interface UsageMetric {
  id: string;
  kind: UsageMetricKind;
  unit: UsageMetricUnit;
  window?: UsageWindow;
  used?: number;
  remaining?: number;
  limit?: number;
  resetsAt?: string;
  retryAfterSeconds?: number;
  status: UsageMetricStatus;
  statusReason: UsageMetricStatusReason;
}

export type ProviderUsageStatus =
  'available' | 'stale' | 'unknown' | 'unsupported' | 'error';

export interface ProviderUsageSnapshot {
  adapterId: AgentId;
  backingProviderId?: string;
  status: ProviderUsageStatus;
  capturedAt: string | null;
  source: string;
  metrics: UsageMetric[];
  detail?: string;
}

export interface UsageCollectionContext {
  projectRoot: string;
  home?: string;
  codexHome?: string;
  claudeUsagePath?: string;
  now?: Date;
  staleAfterMs?: number;
}

/**
 * Bounded, sanitized observations fed to exit classification. Values must be
 * enums or documented provider fields, never free-form terminal output.
 */
export interface ProviderObservation {
  kind:
    | 'provider_error'
    | 'rate_limit'
    | 'usage_limit'
    | 'authentication'
    | 'network';
  detail?:
    | 'invalid_token'
    | 'expired_token'
    | 'quota_exhausted'
    | 'rate_limited'
    | 'network_unavailable'
    | 'provider_unavailable';
}

/**
 * Classification produced when a lease is recovered or a task closes with a
 * run still unfinished: Relay cannot verify what the provider process did, so
 * the outcome is a fallback guess at medium confidence.
 */
export function interruptedExitClassification(): ExitClassification {
  return {
    reason: 'interrupted',
    confidence: 'medium',
    source: 'fallback',
  };
}

export interface AgentAdapter {
  readonly id: AgentId;
  readonly displayName: string;
  readonly executable: string;
  readonly capabilities: AgentCapabilities;
  readonly resumeCapabilities?: ResumeCapabilities;
  detectInstallation(): Promise<InstallationResult>;
  detectAuthentication(): Promise<AuthenticationSnapshot>;
  getVersion(): Promise<string | null>;
  getModels(): Promise<DiscoveryResult<ModelOption>>;
  getEffortLevels(model?: string): Promise<string[]>;
  buildInteractiveCommand(context: AgentRunContext): Promise<CommandSpec>;
  buildResumeCommand?(context: AgentResumeContext): Promise<CommandSpec>;
  buildNonInteractiveCommand?(context: AgentRunContext): Promise<CommandSpec>;
  /**
   * Prepare provider usage collection for a run (for example generating a
   * Claude status-line collector). Returns the settings path to inject.
   */
  prepareUsageCollection?(
    context: UsageCollectionContext,
  ): Promise<UsagePreparation>;
  /** Read structured provider usage through the provider's own machinery. */
  readUsage?(context: UsageCollectionContext): Promise<ProviderUsageSnapshot[]>;
  classifyExit(result: ProcessResult): Promise<ExitClassification>;
}
