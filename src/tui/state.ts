import {
  readValidatedActivitySnapshot,
  type ActivitySnapshot,
} from '../../desktop/activity-snapshot.mjs';
import {
  readProviderPlanUsage,
  type ProviderPlanUsage,
} from '../plan-usage.js';
import { activityFilePath } from '../platform/runtime-paths.js';

export interface DashboardData {
  readonly activity: ActivitySnapshot | null;
  readonly planUsage: Record<string, ProviderPlanUsage>;
  readonly currentProject: string;
  readonly lastUpdated: string;
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

  return {
    activity,
    planUsage,
    currentProject,
    lastUpdated: new Date().toLocaleTimeString(),
  };
}
