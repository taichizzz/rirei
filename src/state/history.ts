import type { RelayState } from './schema.js';
import { readArchivedStates, readState } from './store.js';

export interface TaskHistoryEntry {
  sessionId: string;
  title: string;
  originalRequest: string;
  status: RelayState['task']['status'];
  createdAt: string;
  updatedAt: string;
  current: boolean;
  runs: Array<{
    runId?: string;
    provider: string;
    model?: string;
    effort?: string;
    exitReason?: string;
    exitClassification?: RelayState['agentHistory'][number]['exitClassification'];
    providerObservations?: RelayState['agentHistory'][number]['providerObservations'];
    launchMode?: 'new' | 'resume' | 'fork';
    providerSessionId?: string;
    terminalId?: string;
    workspaceId?: string;
    branchLabel?: string;
    role?: 'implement' | 'review' | 'verify' | 'investigate';
  }>;
  checkpoints: Array<{ id: string; label?: string }>;
  notes: RelayState['notes'];
}

function historyEntry(state: RelayState, current: boolean): TaskHistoryEntry {
  return {
    sessionId: state.sessionId,
    title: state.task.title,
    originalRequest: state.task.originalRequest,
    status: state.task.status,
    createdAt: state.task.createdAt,
    updatedAt: state.task.updatedAt,
    current,
    runs: state.agentHistory.map((run) => ({
      runId: run.id,
      provider: run.agent,
      model: run.model,
      effort: run.effort,
      exitReason: run.exitReason,
      exitClassification: run.exitClassification,
      providerObservations: run.providerObservations,
      launchMode: run.launchMode,
      providerSessionId: run.providerSessionId,
      terminalId: run.terminalId,
      workspaceId: run.workspaceId,
      branchLabel: run.branchLabel,
      role: run.role,
    })),
    checkpoints: state.checkpoints.map((checkpoint) => ({
      id: checkpoint.id,
      label: checkpoint.label,
    })),
    notes: state.notes,
  };
}

function matchesQuery(entry: TaskHistoryEntry, query: string): boolean {
  const fields = [
    entry.title,
    entry.originalRequest,
    ...entry.runs.flatMap((run) => [
      run.provider,
      run.model,
      run.effort,
      run.exitReason,
    ]),
    ...entry.checkpoints.flatMap((checkpoint) => [
      checkpoint.id,
      checkpoint.label,
    ]),
    ...entry.notes.flatMap((note) => [
      note.type,
      note.text,
      note.reason,
      note.provenance.agent,
    ]),
    ...entry.runs.flatMap((record) => [
      record.exitClassification?.reason,
      record.exitClassification?.providerCode,
      ...(record.providerObservations ?? []).map(
        (observation) => observation.kind,
      ),
    ]),
  ];
  const normalized = query.trim().toLocaleLowerCase();
  return (
    normalized.length === 0 ||
    fields.some((field) => field?.toLocaleLowerCase().includes(normalized))
  );
}

export async function searchTaskHistory(
  projectRoot: string,
  query = '',
): Promise<TaskHistoryEntry[]> {
  let current: RelayState | undefined;
  try {
    current = await readState(projectRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const archives = await readArchivedStates(projectRoot);
  const states = new Map<string, TaskHistoryEntry>();
  for (const state of archives)
    states.set(state.sessionId, historyEntry(state, false));
  if (current) states.set(current.sessionId, historyEntry(current, true));
  return [...states.values()]
    .filter((entry) => matchesQuery(entry, query))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}
