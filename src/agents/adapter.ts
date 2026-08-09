export type AgentId = 'claude' | 'codex' | 'gemini' | 'antigravity';

export interface InstallationResult {
  status: 'ready' | 'not_installed' | 'error';
  detail?: string;
}

export interface AuthResult {
  status: 'ready' | 'not_authenticated' | 'unknown' | 'unsupported' | 'error';
  detail?: string;
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

export interface ProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export type AgentExitReason =
  | 'completed'
  | 'user_cancelled'
  | 'usage_limit'
  | 'rate_limit'
  | 'authentication_error'
  | 'permission_error'
  | 'command_not_found'
  | 'provider_unavailable'
  | 'context_limit'
  | 'network_error'
  | 'interrupted'
  | 'unknown_failure';

export interface ResumeCapabilities {
  supportsFork: boolean;
}

export interface AgentAdapter {
  readonly id: AgentId;
  readonly displayName: string;
  readonly executable: string;
  readonly resumeCapabilities?: ResumeCapabilities;
  detectInstallation(): Promise<InstallationResult>;
  detectAuthentication(): Promise<AuthResult>;
  getVersion(): Promise<string | null>;
  getModels(): Promise<ModelOption[]>;
  getEffortLevels(model?: string): Promise<string[]>;
  buildInteractiveCommand(context: AgentRunContext): Promise<CommandSpec>;
  buildResumeCommand?(context: AgentResumeContext): Promise<CommandSpec>;
  buildNonInteractiveCommand?(context: AgentRunContext): Promise<CommandSpec>;
  classifyExit(result: ProcessResult): Promise<{
    reason: AgentExitReason;
    confidence: 'low' | 'medium' | 'high';
  }>;
}
