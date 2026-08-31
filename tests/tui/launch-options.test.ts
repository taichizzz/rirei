import type { AgentCatalogEntry } from '../../src/agents/registry.js';
import { describe, expect, it } from 'vitest';
import {
  cycleChoice,
  effortChoices,
  modelChoices,
  normalizeEffort,
} from '../../src/tui/launch-options.js';

const catalog = {
  id: 'codex',
  displayName: 'Codex',
  installed: true,
  version: 'test',
  capabilities: {},
  models: {
    status: 'available',
    source: 'test',
    values: [
      { id: 'fast', label: 'Fast', efforts: ['low', 'medium'] },
      { id: 'deep', label: 'Deep', efforts: ['high', 'xhigh'] },
    ],
  },
  efforts: ['low', 'medium', 'high', 'xhigh'],
} as unknown as AgentCatalogEntry;

describe('TUI launch options', () => {
  it('derives provider models and model-specific effort choices', () => {
    expect(modelChoices(catalog).map((choice) => choice.id)).toEqual([
      '',
      'fast',
      'deep',
      '__custom',
    ]);
    expect(effortChoices(catalog, 'deep').map((choice) => choice.id)).toEqual([
      '',
      'high',
      'xhigh',
    ]);
  });

  it('cycles choices and clears effort when the model does not support it', () => {
    const models = modelChoices(catalog);
    expect(cycleChoice(models, undefined, 1)).toBe('fast');
    expect(cycleChoice(models, 'deep', 1)).toBe('__custom');
    expect(cycleChoice(models, '__custom', 1)).toBeUndefined();
    expect(normalizeEffort(catalog, 'deep', 'medium')).toBeUndefined();
    expect(normalizeEffort(catalog, 'deep', 'high')).toBe('high');
  });

  it('does not fall back to provider efforts for a model with no efforts', () => {
    const noEffortModel = {
      ...catalog,
      models: {
        ...catalog.models,
        values: [{ id: 'none', label: 'None', efforts: [] }],
      },
    } as unknown as AgentCatalogEntry;

    expect(effortChoices(noEffortModel, 'none')).toEqual([
      { id: '', label: 'Auto (provider default)' },
    ]);
    expect(normalizeEffort(noEffortModel, 'none', 'high')).toBeUndefined();
  });
});
