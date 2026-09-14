import {
  readValidatedActivitySnapshot,
  type ActivitySnapshot,
} from '../../desktop/activity-snapshot.mjs';
import {
  readProviderPlanUsage,
  type ProviderPlanUsage,
} from '../plan-usage.js';
import { activityFilePath } from '../platform/runtime-paths.js';
import { discoverRepositoryAuthority } from '../git/repository.js';
import { resolveCurrentActor } from '../messages/capability.js';
import { readThreadsJournal } from '../messages/store.js';
import { readState } from '../state/store.js';
import {
  buildThreadsData,
  type ThreadsData,
  unavailableThreadsData,
} from './threads.js';

export interface DashboardData {
  readonly activity: ActivitySnapshot | null;
  readonly planUsage: Record<string, ProviderPlanUsage>;
  readonly currentProject: string;
  readonly lastUpdated: string;
  readonly threads: ThreadsData;
}

export async function loadThreadsData(
  currentProject: string,
): Promise<ThreadsData> {
  try {
    const root = await discoverRepositoryAuthority(
      process.env.RIREI_PROJECT_ROOT?.trim() || currentProject,
    );
    if (!root)
      return unavailableThreadsData('Relay Threads require a Git repository.');
    const state = await readState(root);
    const actor = await resolveCurrentActor(root, state);
    const journal = await readThreadsJournal(root, state.sessionId);
    return buildThreadsData({
      journal,
      actor,
      peerRuns: state.runs,
      projectRoot: root,
      writable:
        state.task.status === 'active' || state.task.status === 'blocked',
    });
  } catch (error) {
    return unavailableThreadsData(
      error instanceof Error ? error.message : 'Relay Threads are unavailable.',
    );
  }
}

export async function loadDashboardData(
  currentProject: string = process.cwd(),
): Promise<DashboardData> {
  let activity: ActivitySnapshot | null = null;
  try {
    activity = await readValidatedActivitySnapshot(activityFilePath());
  } catch {
    // Activity snapshot missing or invalid
  }

  const planUsage: Record<string, ProviderPlanUsage> = {};
  try {
    const list = await readProviderPlanUsage(currentProject);
    for (const usage of list) {
      planUsage[usage.id] = usage;
    }
  } catch {
    // Plan usage unavailable
  }

  const threads = await loadThreadsData(currentProject);

  return {
    activity,
    planUsage,
    currentProject,
    lastUpdated: new Date().toLocaleTimeString(),
    threads,
  };
}
