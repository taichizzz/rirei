import type { AgentAdapter, AgentId } from '../agents/adapter.js';
import { getAgent, registeredAgents } from '../agents/registry.js';
import {
  checkPreflightLimit,
  formatLocalReset,
} from '../agents/limit-detection.js';
import { hasContinuationNotes } from '../handoff.js';
import type { RelayState } from '../state/schema.js';

export interface HandoffTargetSuggestion {
  id: AgentId;
  reason: string;
}

export interface HandoffOffer {
  exhaustedAgent: AgentId;
  exhaustedDisplayName: string;
  reason: 'usage_limit' | 'rate_limit';
  retryAt?: string;
  target?: {
    id: AgentId;
    displayName: string;
    reason: string;
  };
  otherTargets: Array<{
    id: AgentId;
    displayName: string;
    reason: string;
  }>;
  hasContinuationNotes: boolean;
  headline: string;
  notesWarning?: string;
}

/**
 * Suggests ordered handoff targets when a provider hits a usage or rate limit.
 *
 * Ranking rules:
 * 1. Candidates = installed adapters other than the exhausted one
 * 2. Drop any whose own usage reports exhausted (fresh samples only)
 * 3. Prefer a provider already used on this task — continuity over novelty
 * 4. Providers with unknown usage stay eligible; unknown is not disqualifying, just unranked
 * 5. Return the reason each was ranked so the UI can explain itself
 *
 * Does NOT rank finely by remaining percentage.
 */
export async function suggestHandoffTargets(
  projectRoot: string,
  state: RelayState,
  exhaustedAdapterId: AgentId,
): Promise<Array<{ id: AgentId; reason: string }>> {
  const candidates: Array<{
    adapter: AgentAdapter;
    usedOnTask: boolean;
    hasKnownQuota: boolean;
    lastUsedIndex: number;
  }> = [];

  for (const adapter of registeredAgents()) {
    // 1. Candidates = installed adapters other than the exhausted one
    if (adapter.id === exhaustedAdapterId) continue;

    try {
      const installation = await adapter.detectInstallation();
      if (installation.status !== 'ready') continue;
    } catch {
      continue;
    }

    // 2. Drop any whose own usage reports exhausted (fresh samples only)
    let preflightWarning = null;
    try {
      preflightWarning = await checkPreflightLimit(adapter, { projectRoot });
    } catch {
      // Collector error -> keep eligible as unknown usage
    }
    if (preflightWarning) {
      // Exclude exhausted candidate
      continue;
    }

    // Check whether usage is known available vs unknown
    let hasKnownQuota = false;
    if (typeof adapter.readUsage === 'function') {
      try {
        const snapshots = await adapter.readUsage({ projectRoot });
        if (Array.isArray(snapshots)) {
          for (const s of snapshots) {
            if (
              s.status === 'available' &&
              (s.metrics ?? []).some(
                (m) => m.kind === 'quota' && m.status !== 'stale',
              )
            ) {
              hasKnownQuota = true;
              break;
            }
          }
        }
      } catch {
        hasKnownQuota = false;
      }
    }

    // 3. Prefer a provider already used on this task — continuity over novelty
    const history = state.agentHistory ?? [];
    const lastUsedIndex = history.findLastIndex(
      (run) => run.agent === adapter.id,
    );
    const usedOnTask = lastUsedIndex !== -1;

    candidates.push({
      adapter,
      usedOnTask,
      hasKnownQuota,
      lastUsedIndex,
    });
  }

  // Sort candidates according to ranking rules
  candidates.sort((a, b) => {
    // Continuity: used on this task first
    if (a.usedOnTask && !b.usedOnTask) return -1;
    if (!a.usedOnTask && b.usedOnTask) return 1;

    if (a.usedOnTask && b.usedOnTask) {
      if (a.hasKnownQuota && !b.hasKnownQuota) return -1;
      if (!a.hasKnownQuota && b.hasKnownQuota) return 1;
      return b.lastUsedIndex - a.lastUsedIndex;
    }

    // Unused on task: known quota before unknown usage
    if (a.hasKnownQuota && !b.hasKnownQuota) return -1;
    if (!a.hasKnownQuota && b.hasKnownQuota) return 1;

    return 0;
  });

  return candidates.map((item) => {
    let reason: string;
    if (item.usedOnTask) {
      reason = item.hasKnownQuota
        ? 'Previously used on this task with available quota'
        : 'Previously used on this task';
    } else {
      reason = item.hasKnownQuota
        ? 'Installed alternative with available quota'
        : 'Installed alternative';
    }
    return {
      id: item.adapter.id,
      reason,
    };
  });
}

export async function buildHandoffOffer(
  projectRoot: string,
  state: RelayState,
  exhaustedAdapterId: AgentId,
  exitClassification: { reason: string; retryAt?: string },
): Promise<HandoffOffer | null> {
  const reason =
    exitClassification.reason === 'rate_limit'
      ? ('rate_limit' as const)
      : ('usage_limit' as const);

  let suggestions: Array<{ id: AgentId; reason: string }> = [];
  try {
    suggestions = await suggestHandoffTargets(
      projectRoot,
      state,
      exhaustedAdapterId,
    );
  } catch {
    suggestions = [];
  }

  let exhaustedDisplayName = String(exhaustedAdapterId);
  try {
    const exhaustedAdapter = getAgent(exhaustedAdapterId);
    if (exhaustedAdapter?.displayName) {
      exhaustedDisplayName = exhaustedAdapter.displayName;
    }
  } catch {
    // Fall back to id
  }

  const resetText = formatLocalReset(exitClassification.retryAt);
  const resetPart = resetText ? ` (resets ${resetText})` : '';

  const reasonPhrase =
    reason === 'rate_limit' ? 'was rate limited' : 'reached its usage limit';

  const top = suggestions[0];
  let targetDisplayName: string | undefined;
  if (top) {
    try {
      targetDisplayName = getAgent(top.id)?.displayName ?? top.id;
    } catch {
      targetDisplayName = top.id;
    }
  }

  const headline = top
    ? `${exhaustedDisplayName} ${reasonPhrase}${resetPart}. Hand off to ${targetDisplayName}?`
    : `${exhaustedDisplayName} ${reasonPhrase}${resetPart}.`;

  const hasNotes = hasContinuationNotes(state.notes);
  const notesWarning = hasNotes
    ? undefined
    : 'No continuation notes recorded. Add one to hand off, or switch anyway.';

  return {
    exhaustedAgent: exhaustedAdapterId,
    exhaustedDisplayName,
    reason,
    retryAt: exitClassification.retryAt,
    target: top
      ? {
          id: top.id,
          displayName: targetDisplayName!,
          reason: top.reason,
        }
      : undefined,
    otherTargets: suggestions.slice(1).map((s) => {
      let name = String(s.id);
      try {
        name = getAgent(s.id)?.displayName ?? s.id;
      } catch {
        // Fall back to id
      }
      return {
        id: s.id,
        displayName: name,
        reason: s.reason,
      };
    }),
    hasContinuationNotes: hasNotes,
    headline,
    notesWarning,
  };
}

export async function printHandoffSuggestion(
  projectRoot: string,
  state: RelayState,
  exhaustedAdapterId: AgentId,
  exitClassification: { reason: string; retryAt?: string },
): Promise<void> {
  try {
    const offer = await buildHandoffOffer(
      projectRoot,
      state,
      exhaustedAdapterId,
      exitClassification,
    );
    if (!offer) return;

    process.stdout.write(`\n${offer.headline}\n`);
    if (offer.notesWarning) {
      process.stdout.write(`${offer.notesWarning}\n`);
    }
    if (offer.target) {
      process.stdout.write(
        `Suggested command: relay switch ${offer.target.id}\n`,
      );
    }
  } catch {
    // Suggestion lookup must not block or break
  }
}
