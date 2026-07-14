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
});
