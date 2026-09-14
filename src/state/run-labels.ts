import { updateState } from './store.js';
import { sessionDisplayLabelSchema, type RelayState } from './schema.js';

const PROVIDER_TITLES: Record<string, string> = {
  claude: 'Claude',
  codex: 'Codex',
  gemini: 'Gemini',
  antigravity: 'Antigravity',
  opencode: 'OpenCode',
};

export function formatProviderTitle(agent: string): string {
  const normalized = agent.trim().toLowerCase();
  if (PROVIDER_TITLES[normalized]) return PROVIDER_TITLES[normalized];
  if (!agent) return 'Agent';
  return agent.charAt(0).toUpperCase() + agent.slice(1);
}

export function formatDefaultSessionLabel(
  agent: string,
  count: number,
): string {
  const title = formatProviderTitle(agent);
  return `${title} ${Math.max(1, count)}`;
}

export function validateSessionLabel(raw: unknown): string {
  return sessionDisplayLabelSchema.parse(raw);
}

/**
 * Atomically renames the displayLabel for a run in both active leases (runs)
 * and durable agentHistory records.
 */
export async function renameSessionLabel(
  projectRoot: string,
  runId: string,
  newLabel: string,
): Promise<RelayState> {
  const validatedLabel = validateSessionLabel(newLabel);
  const canonicalRunId = runId.startsWith('run:') ? runId.slice(4) : runId;

  return updateState(projectRoot, (state) => {
    let found = false;
    const nextHistory = state.agentHistory.map((entry) => {
      if (entry.id === canonicalRunId) {
        found = true;
        return { ...entry, displayLabel: validatedLabel };
      }
      return entry;
    });

    const nextRuns = state.runs.map((lease) => {
      if (lease.runId === canonicalRunId) {
        found = true;
        return { ...lease, displayLabel: validatedLabel };
      }
      return lease;
    });

    if (!found) {
      throw new Error(
        `Run "${canonicalRunId}" was not found in active runs or history.`,
      );
    }

    return {
      ...state,
      runs: nextRuns,
      agentHistory: nextHistory,
    };
  });
}
