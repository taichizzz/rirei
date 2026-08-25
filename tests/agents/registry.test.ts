import { describe, expect, it } from 'vitest';
import { getAgent } from '../../src/agents/registry.js';

const context = {
  projectRoot: '/tmp/project',
  prompt: 'Continue safely',
};

describe('agent model and effort commands', () => {
  it('passes Claude model, effort, and generated settings as documented flags', async () => {
    await expect(
      getAgent('claude').buildInteractiveCommand({
        ...context,
        providerSettingsPath: '/tmp/claude-settings.json',
        model: 'opus',
        effort: 'high',
      }),
    ).resolves.toEqual({
      executable: 'claude',
      args: [
        '--settings',
        '/tmp/claude-settings.json',
        '--model',
        'opus',
        '--effort',
        'high',
        'Continue safely',
      ],
    });
    expect(
      (await getAgent('opencode').buildInteractiveCommand(context)).args,
    ).not.toContain('--auto');
  });

  it('passes Codex reasoning effort as a session-only config override', async () => {
    await expect(
      getAgent('codex').buildInteractiveCommand({
        ...context,
        model: 'gpt-5.6-sol',
        effort: 'xhigh',
      }),
    ).resolves.toEqual({
      executable: 'codex',
      args: [
        '--model',
        'gpt-5.6-sol',
        '--config',
        'model_reasoning_effort="xhigh"',
        'Continue safely',
      ],
    });
  });

  it('supports Antigravity model variants but rejects unsupported effort flags', async () => {
    await expect(
      getAgent('antigravity').buildInteractiveCommand({
        ...context,
        model: 'Gemini 3.5 Flash (High)',
      }),
    ).resolves.toEqual({
      executable: 'agy',
      args: [
        '--model',
        'Gemini 3.5 Flash (High)',
        '--prompt-interactive',
        'Continue safely',
      ],
    });
    await expect(
      getAgent('antigravity').buildInteractiveCommand({
        ...context,
        effort: 'high',
      }),
    ).rejects.toThrow(/unsupported effort/i);
  });

  it('seeds the OpenCode TUI composer with the prompt and provider/model', async () => {
    await expect(
      getAgent('opencode').buildInteractiveCommand({
        ...context,
        model: 'anthropic/claude-sonnet-4-6',
      }),
    ).resolves.toEqual({
      executable: 'opencode',
      args: [
        '--model',
        'anthropic/claude-sonnet-4-6',
        '--prompt',
        'Continue safely',
      ],
    });
    await expect(
      getAgent('opencode').buildInteractiveCommand({ ...context, prompt: '' }),
    ).resolves.toEqual({ executable: 'opencode', args: [] });
    await expect(
      getAgent('opencode').buildInteractiveCommand({
        ...context,
        effort: 'high',
      }),
    ).rejects.toThrow(/effort.*unsupported/i);
  });

  it('builds OpenCode latest, exact, and forked resume commands', async () => {
    await expect(
      getAgent('opencode').buildResumeCommand!({
        ...context,
        prompt: '',
        resumeTargetKind: 'latest',
        fork: false,
      }),
    ).resolves.toEqual({ executable: 'opencode', args: ['--continue'] });
    await expect(
      getAgent('opencode').buildResumeCommand!({
        ...context,
        prompt: 'Check tests',
        resumeTargetKind: 'id',
        resumeTargetValue: 'oc-session',
        fork: true,
        model: 'anthropic/claude-sonnet-4-6',
      }),
    ).resolves.toEqual({
      executable: 'opencode',
      args: [
        '--model',
        'anthropic/claude-sonnet-4-6',
        '--session',
        'oc-session',
        '--fork',
        '--prompt',
        'Check tests',
      ],
    });
    await expect(
      getAgent('opencode').buildResumeCommand!({
        ...context,
        resumeTargetKind: 'picker',
        fork: false,
      }),
    ).rejects.toThrow(/does not expose a CLI session picker/);
  });

  it('exposes verified Claude aliases and effort levels', async () => {
    await expect(getAgent('claude').getModels()).resolves.toMatchObject({
      status: 'available',
      source: 'static aliases',
      values: expect.arrayContaining([{ id: 'sonnet', label: 'Sonnet' }]),
    });
    await expect(getAgent('claude').getEffortLevels()).resolves.toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ]);
  });

  it('builds Claude latest, picker, exact, and fork resume commands', async () => {
    await expect(
      getAgent('claude').buildResumeCommand!({
        ...context,
        prompt: '',
        resumeTargetKind: 'latest',
        fork: false,
      }),
    ).resolves.toEqual({ executable: 'claude', args: ['--continue'] });
    await expect(
      getAgent('claude').buildResumeCommand!({
        ...context,
        prompt: '',
        resumeTargetKind: 'picker',
        fork: false,
      }),
    ).resolves.toEqual({ executable: 'claude', args: ['--resume'] });
    await expect(
      getAgent('claude').buildResumeCommand!({
        ...context,
        prompt: 'Check tests',
        resumeTargetKind: 'id',
        resumeTargetValue: 'claude-session',
        fork: true,
        model: 'opus',
        effort: 'high',
      }),
    ).resolves.toEqual({
      executable: 'claude',
      args: [
        '--model',
        'opus',
        '--effort',
        'high',
        '--resume',
        'claude-session',
        '--fork-session',
        'Check tests',
      ],
    });
  });

  it('builds Codex picker, latest, and exact resume commands without empty prompts', async () => {
    await expect(
      getAgent('codex').buildResumeCommand!({
        ...context,
        prompt: '',
        resumeTargetKind: 'picker',
        fork: false,
      }),
    ).resolves.toEqual({ executable: 'codex', args: ['resume'] });
    await expect(
      getAgent('codex').buildResumeCommand!({
        ...context,
        prompt: '',
        resumeTargetKind: 'latest',
        fork: false,
      }),
    ).resolves.toEqual({
      executable: 'codex',
      args: ['resume', '--last'],
    });
    await expect(
      getAgent('codex').buildResumeCommand!({
        ...context,
        prompt: 'Continue review',
        resumeTargetKind: 'id',
        resumeTargetValue: 'codex-session',
        fork: false,
        model: 'gpt-5.6-sol',
        effort: 'xhigh',
      }),
    ).resolves.toEqual({
      executable: 'codex',
      args: [
        'resume',
        '--model',
        'gpt-5.6-sol',
        '--config',
        'model_reasoning_effort="xhigh"',
        'codex-session',
        'Continue review',
      ],
    });
  });

  it('rejects Codex forks and does not expose resume for other providers', async () => {
    await expect(
      getAgent('codex').buildResumeCommand!({
        ...context,
        resumeTargetKind: 'latest',
        fork: true,
      }),
    ).rejects.toThrow('does not support session forks');
    await expect(
      getAgent('codex').buildResumeCommand!({
        ...context,
        prompt: 'Misread as a session ID',
        resumeTargetKind: 'picker',
        fork: false,
      }),
    ).rejects.toThrow('pickers cannot accept an initial prompt');
    expect(getAgent('gemini').resumeCapabilities).toBeUndefined();
    expect(getAgent('antigravity').resumeCapabilities).toBeUndefined();
  });

  it('advertises capabilities instead of hard-coded provider checks', async () => {
    const claude = getAgent('claude');
    expect(claude.resumeCapabilities).toEqual({
      targets: ['latest', 'picker', 'id'],
      supportsFork: true,
      exposesNewSessionId: true,
    });
    expect(claude.capabilities).toMatchObject({
      interactive: true,
      modelDiscovery: true,
      modelVariants: true,
      authenticationDiscovery: true,
      usageCollection: true,
      structuredEvents: true,
    });
    const codex = getAgent('codex');
    expect(codex.resumeCapabilities).toEqual({
      targets: ['latest', 'picker', 'id'],
      supportsFork: false,
      exposesNewSessionId: false,
    });
    expect(codex.capabilities.structuredEvents).toBe(true);
    expect(getAgent('gemini').capabilities).toMatchObject({
      modelDiscovery: false,
      authenticationDiscovery: false,
      usageCollection: false,
    });
    expect(getAgent('antigravity').capabilities).toMatchObject({
      authenticationDiscovery: false,
    });
    const opencode = getAgent('opencode');
    expect(opencode.resumeCapabilities).toEqual({
      targets: ['latest', 'id'],
      supportsFork: true,
      exposesNewSessionId: false,
    });
    expect(opencode.capabilities).toMatchObject({
      interactive: true,
      modelDiscovery: true,
      authenticationDiscovery: true,
      usageCollection: false,
      structuredEvents: true,
    });
  });

  it('uses lifecycle supervisors only inside authenticated desktop terminals', async () => {
    const previous = {
      node: process.env.RIREI_NODE_PATH,
      terminal: process.env.RIREI_TERMINAL_ID,
      codex: process.env.RIREI_CODEX_LIFECYCLE_WRAPPER,
      opencode: process.env.RIREI_OPENCODE_LIFECYCLE_WRAPPER,
      hook: process.env.RIREI_LIFECYCLE_HOOK,
      token: process.env.RIREI_LIFECYCLE_TOKEN,
    };
    process.env.RIREI_NODE_PATH = '/usr/local/bin/node';
    process.env.RIREI_TERMINAL_ID = 'terminal';
    process.env.RIREI_CODEX_LIFECYCLE_WRAPPER = '/app/codex-wrapper.mjs';
    process.env.RIREI_OPENCODE_LIFECYCLE_WRAPPER = '/app/opencode-wrapper.mjs';
    process.env.RIREI_LIFECYCLE_HOOK = '/app/lifecycle-hook.cjs';
    process.env.RIREI_LIFECYCLE_TOKEN = 'token';
    try {
      await expect(
        getAgent('codex').buildInteractiveCommand(context),
      ).resolves.toEqual({
        executable: '/usr/local/bin/node',
        args: ['/app/codex-wrapper.mjs', 'Continue safely'],
      });
      await expect(
        getAgent('opencode').buildInteractiveCommand(context),
      ).resolves.toEqual({
        executable: '/usr/local/bin/node',
        args: ['/app/opencode-wrapper.mjs', '--prompt', 'Continue safely'],
      });
    } finally {
      const restore = (key: string, value: string | undefined) => {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      };
      restore('RIREI_NODE_PATH', previous.node);
      restore('RIREI_TERMINAL_ID', previous.terminal);
      restore('RIREI_CODEX_LIFECYCLE_WRAPPER', previous.codex);
      restore('RIREI_OPENCODE_LIFECYCLE_WRAPPER', previous.opencode);
      restore('RIREI_LIFECYCLE_HOOK', previous.hook);
      restore('RIREI_LIFECYCLE_TOKEN', previous.token);
    }
  });

  it('reports unsupported model discovery instead of an empty catalog', async () => {
    await expect(getAgent('gemini').getModels()).resolves.toMatchObject({
      status: 'unsupported',
      values: [],
    });
  });

  it('classifies exits with evidence source and provider code', async () => {
    await expect(
      getAgent('codex').classifyExit({
        exitCode: 0,
        signal: null,
        terminationIntent: 'none',
        observations: [],
        stdout: '',
        stderr: '',
      }),
    ).resolves.toEqual({
      reason: 'completed',
      confidence: 'high',
      source: 'provider_exit_code',
      providerCode: '0',
    });
    await expect(
      getAgent('codex').classifyExit({
        exitCode: 130,
        signal: 'SIGINT',
        terminationIntent: 'user_interrupt',
        observations: [],
        stdout: '',
        stderr: '',
      }),
    ).resolves.toEqual({
      reason: 'user_cancelled',
      confidence: 'high',
      source: 'user_intent',
      providerCode: 'user_interrupt',
    });
    await expect(
      getAgent('codex').classifyExit({
        exitCode: 42,
        signal: null,
        terminationIntent: 'none',
        observations: [],
        stdout: '',
        stderr: '',
      }),
    ).resolves.toMatchObject({
      reason: 'unknown_failure',
      confidence: 'low',
      source: 'fallback',
      providerCode: '42',
    });
  });

  it('upgrades classification from structured provider observations', async () => {
    await expect(
      getAgent('claude').classifyExit({
        exitCode: 42,
        signal: null,
        terminationIntent: 'none',
        observations: [{ kind: 'rate_limit' }],
        stdout: '',
        stderr: '',
      }),
    ).resolves.toEqual({
      reason: 'rate_limit',
      confidence: 'high',
      source: 'provider_event',
    });
    await expect(
      getAgent('claude').classifyExit({
        exitCode: 42,
        signal: null,
        terminationIntent: 'none',
        observations: [{ kind: 'usage_limit' }],
        stdout: '',
        stderr: '',
      }),
    ).resolves.toMatchObject({
      reason: 'usage_limit',
      confidence: 'high',
      source: 'provider_event',
    });
    await expect(
      getAgent('claude').classifyExit({
        exitCode: 42,
        signal: null,
        terminationIntent: 'none',
        observations: [{ kind: 'authentication', detail: 'invalid_token' }],
        stdout: '',
        stderr: '',
      }),
    ).resolves.toEqual({
      reason: 'authentication_error',
      confidence: 'high',
      source: 'provider_event',
      providerCode: 'invalid_token',
    });
    await expect(
      getAgent('claude').classifyExit({
        exitCode: 42,
        signal: null,
        terminationIntent: 'none',
        observations: [{ kind: 'network' }],
        stdout: '',
        stderr: '',
      }),
    ).resolves.toMatchObject({
      reason: 'network_error',
      confidence: 'high',
      source: 'provider_event',
    });
    await expect(
      getAgent('claude').classifyExit({
        exitCode: 42,
        signal: null,
        terminationIntent: 'none',
        observations: [{ kind: 'provider_error' }],
        stdout: '',
        stderr: '',
      }),
    ).resolves.toMatchObject({
      reason: 'provider_unavailable',
      confidence: 'medium',
      source: 'provider_event',
    });
  });

  it('keeps a successful exit completed even with provider observations', async () => {
    await expect(
      getAgent('codex').classifyExit({
        exitCode: 0,
        signal: null,
        terminationIntent: 'none',
        observations: [{ kind: 'network' }],
        stdout: '',
        stderr: '',
      }),
    ).resolves.toEqual({
      reason: 'completed',
      confidence: 'high',
      source: 'provider_exit_code',
      providerCode: '0',
    });
  });

  it('includes a Relay-assigned Claude session ID on new commands', async () => {
    await expect(
      getAgent('claude').buildInteractiveCommand({
        ...context,
        providerSessionId: '2aebf21b-40e5-41a9-832f-098b367513f6',
      }),
    ).resolves.toEqual({
      executable: 'claude',
      args: [
        '--session-id',
        '2aebf21b-40e5-41a9-832f-098b367513f6',
        'Continue safely',
      ],
    });
  });
});
