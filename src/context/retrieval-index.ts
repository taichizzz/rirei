import type { ContextEvent, ContextJournal } from './schema.js';
import type { RetrievalQuery } from './retrieval-schema.js';
import { retrievalHash } from './retrieval-cursor.js';

export interface IndexedEvidence {
  readonly event: Readonly<ContextEvent>;
  readonly commandId?: string;
}
interface IndexData {
  version: 1;
  rows: IndexedEvidence[];
  byId: Map<string, IndexedEvidence>;
  byFile: Map<string, IndexedEvidence[]>;
  byTool: Map<string, IndexedEvidence[]>;
  byCommand: Map<string, IndexedEvidence[]>;
  byKind: Map<string, IndexedEvidence[]>;
}
interface EvidenceIndex {
  readonly version: 1;
  get(id: string): IndexedEvidence | undefined;
  find(query: Extract<RetrievalQuery, { type: 'find' }>): IndexedEvidence[];
}
const indexes = new Map<string, EvidenceIndex>();

export function evidenceIndex(
  taskId: string,
  workspace: string,
  journal: ContextJournal,
): EvidenceIndex {
  // The caller revalidates the hash-linked journal on every invocation, including cache hits.
  const key = retrievalHash(
    JSON.stringify({ version: 1, taskId, workspace, digest: journal.digest }),
  );
  const cached = indexes.get(key);
  if (cached) return cached;
  const events = journal.events.filter(
    (event) => event.taskId === taskId && event.workspace === workspace,
  );
  const identity = (event: ContextEvent) =>
    event.toolId
      ? `${event.provider}\0${event.runId}\0tool:${event.toolId}`
      : event.command
        ? `${event.provider}\0${event.runId}\0command:${event.command}`
        : null;
  const commands = new Set(
    events.filter((event) => event.command).map(identity),
  );
  const index: IndexData = {
    version: 1,
    rows: [],
    byId: new Map(),
    byFile: new Map(),
    byTool: new Map(),
    byCommand: new Map(),
    byKind: new Map(),
  };
  const add = (
    map: Map<string, IndexedEvidence[]>,
    value: string | undefined,
    row: IndexedEvidence,
  ) => {
    if (value !== undefined) {
      const rows = map.get(value);
      if (rows) rows.push(row);
      else map.set(value, [row]);
    }
  };
  for (const source of events) {
    const id = identity(source);
    const row = Object.freeze({
      event: Object.freeze({ ...source }),
      ...(id && commands.has(id)
        ? { commandId: `c-${retrievalHash(id).slice(0, 32)}` }
        : {}),
    });
    index.rows.push(row);
    index.byId.set(source.id, row);
    add(index.byFile, source.filePath, row);
    add(index.byTool, source.toolId, row);
    add(index.byCommand, row.commandId, row);
    add(index.byKind, source.kind, row);
  }
  if (indexes.size >= 4) indexes.delete(indexes.keys().next().value!);
  const lookup: EvidenceIndex = Object.freeze({
    version: 1 as const,
    get: (id: string) => index.byId.get(id),
    find: (query: Extract<RetrievalQuery, { type: 'find' }>) =>
      findInIndex(index, query),
  });
  indexes.set(key, lookup);
  return lookup;
}

export function findEvidence(
  index: EvidenceIndex,
  query: Extract<RetrievalQuery, { type: 'find' }>,
): IndexedEvidence[] {
  return index.find(query);
}

function findInIndex(
  index: IndexData,
  query: Extract<RetrievalQuery, { type: 'find' }>,
): IndexedEvidence[] {
  const candidates = [
    query.file === undefined ? undefined : (index.byFile.get(query.file) ?? []),
    query.toolId === undefined
      ? undefined
      : (index.byTool.get(query.toolId) ?? []),
    query.commandId === undefined
      ? undefined
      : (index.byCommand.get(query.commandId) ?? []),
    query.kind === undefined ? undefined : (index.byKind.get(query.kind) ?? []),
  ].filter((rows): rows is IndexedEvidence[] => rows !== undefined);
  const smallest =
    candidates.sort((a, b) => a.length - b.length)[0] ?? index.rows;
  return smallest.filter(
    (row) =>
      (query.file === undefined || row.event.filePath === query.file) &&
      (query.toolId === undefined || row.event.toolId === query.toolId) &&
      (query.commandId === undefined || row.commandId === query.commandId) &&
      (query.kind === undefined || row.event.kind === query.kind),
  );
}
