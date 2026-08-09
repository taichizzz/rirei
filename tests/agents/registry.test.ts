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
    ).rejects.toThrow('Unsupported effort');
  });

  it('exposes verified Claude aliases and effort levels', async () => {
    await expect(getAgent('claude').getModels()).resolves.toContainEqual({
      id: 'sonnet',
      label: 'Sonnet',
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
