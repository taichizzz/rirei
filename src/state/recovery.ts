import { appendEvent } from './events.js';
import { releaseLease } from './leases.js';
import type { RelayState } from './schema.js';
import { updateState } from './store.js';

export async function recoverStaleRun(
  projectRoot: string,
  state: RelayState,
): Promise<RelayState | null> {
  if (
    !state.currentAgent &&
    !state.currentRunId &&
    !state.agentHistory.some((run) => !run.endedAt)
  )
    return null;
  const endedAt = new Date().toISOString();
  let recoveredRun: RelayState['agentHistory'][number] | undefined;
  const recovered = await updateState(projectRoot, (current) => {
    // Re-derive the target run against the locked, current state so a race
    // that already recovered it does not resurrect a "current" agent.
    if (
      !current.currentAgent &&
      !current.currentRunId &&
      !current.agentHistory.some((run) => !run.endedAt)
    )
      return current;
    let runIndex = -1;
    if (current.currentRunId) {
      runIndex = current.agentHistory.findIndex(
        (run) => run.id === current.currentRunId && !run.endedAt,
      );
    } else if (current.currentAgent) {
      runIndex = current.agentHistory.findLastIndex(
        (run) => run.agent === current.currentAgent && !run.endedAt,
      );
    } else {
      runIndex = current.agentHistory.findLastIndex((run) => !run.endedAt);
    }
    if (runIndex < 0)
      throw new Error(
        'Relay state names a current agent but has no matching unfinished run.',
      );
    const run = current.agentHistory[runIndex]!;
    recoveredRun = run;
    const agentHistory = [...current.agentHistory];
    agentHistory[runIndex] = {
      ...run,
      endedAt,
      exitCode: null,
      exitReason: 'interrupted',
    };
    // Force recovery releases the lease and records who asked for it.
    return releaseLease(
      {
        ...current,
        agentHistory,
        task: { ...current.task, updatedAt: endedAt },
      },
      run.id ?? current.currentRunId ?? '',
    );
  });
  if (recoveredRun)
    await appendEvent(projectRoot, 'agent_recovered', {
      runId: recoveredRun.id ?? null,
      agent: recoveredRun.agent,
      reason: 'interrupted',
    });
  return recovered;
}
