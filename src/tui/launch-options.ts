import type { AgentId } from '../agents/adapter.js';
import type { AgentCatalogEntry } from '../agents/registry.js';

export interface LaunchSelection {
  readonly agent: AgentId;
  readonly model?: string;
  readonly effort?: string;
}

export interface LaunchChoice {
  readonly id: string;
  readonly label: string;
}

export function modelChoices(
  entry: AgentCatalogEntry | undefined,
): LaunchChoice[] {
  return [
    { id: '', label: 'Auto (provider default)' },
    ...(entry?.models.values ?? []).map((model) => ({
      id: model.id,
      label: model.label,
    })),
    { id: '__custom', label: 'Custom model ID' },
  ];
}

export function effortChoices(
  entry: AgentCatalogEntry | undefined,
  model?: string,
): LaunchChoice[] {
  const modelOption = entry?.models.values.find((item) => item.id === model);
  const efforts =
    modelOption?.efforts !== undefined
      ? modelOption.efforts
      : (entry?.efforts ?? []);
  return [
    { id: '', label: 'Auto (provider default)' },
    ...efforts.map((effort) => ({ id: effort, label: effort })),
  ];
}

export function cycleChoice(
  choices: LaunchChoice[],
  selected: string | undefined,
  delta: number,
): string | undefined {
  const current = Math.max(
    0,
    choices.findIndex((choice) => choice.id === (selected ?? '')),
  );
  const next = (current + delta + choices.length) % choices.length;
  return choices[next]?.id || undefined;
}

export function normalizeEffort(
  entry: AgentCatalogEntry | undefined,
  model: string | undefined,
  effort: string | undefined,
): string | undefined {
  return effortChoices(entry, model).some((choice) => choice.id === effort)
    ? effort
    : undefined;
}
