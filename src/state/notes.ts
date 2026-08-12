import { randomUUID } from 'node:crypto';
import { inspectGitSnapshot, type GitSnapshot } from '../git/repository.js';
import {
  handoffNoteSchema,
  handoffNoteTypeSchema,
  type HandoffNote,
  type HandoffNoteType,
  type RelayState,
} from './schema.js';
import { updateState } from './store.js';

export type NoteFreshness = 'current' | 'changed' | 'diverged';

export interface AddHandoffNoteInput {
  type: HandoffNoteType;
  text: string;
  reason?: string;
  source: 'user' | 'agent';
  agent?: string;
}

export interface NoteImportItem {
  type: string;
  text: string;
  reason?: string;
}

export interface ImportHandoffNotesInput {
  notes: NoteImportItem[];
  source: 'user' | 'agent';
  agent?: string;
}

export const NOTE_IMPORT_MAX_ITEMS = 20;

/**
 * Parse a canonical note type with a concise correction for common ambiguous
 * values. Never silently maps an unsupported type to a canonical one.
 */
export function parseNoteType(value: string): HandoffNoteType {
  const parsed = handoffNoteTypeSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  const hint = /^(?:progress|implementation|completed|wip|todo)$/i.test(value)
    ? ' Unfinished work belongs in "next"; finished work belongs in "done".'
    : '';
  throw new Error(
    `Unsupported note type "${value}". Use one of: ${handoffNoteTypeSchema.options.join(', ')}.${hint}`,
  );
}

export function noteFreshness(
  note: HandoffNote,
  snapshot: GitSnapshot,
): NoteFreshness {
  if (
    note.git.commit !== snapshot.commit ||
    note.git.branch !== snapshot.branch
  )
    return 'diverged';
  return note.git.fingerprint === snapshot.fingerprint ? 'current' : 'changed';
}

export async function addHandoffNote(
  projectRoot: string,
  state: RelayState,
  input: AddHandoffNoteInput,
): Promise<HandoffNote> {
  if (input.source === 'agent' && !input.agent)
    throw new Error('Agent-reported notes require --agent <name>.');
  if (input.source === 'user' && input.agent)
    throw new Error('--agent can only be used with --source agent.');

  const snapshot = await inspectGitSnapshot(projectRoot, 1);
  const createdAt = new Date().toISOString();
  const note = handoffNoteSchema.parse({
    id: randomUUID(),
    type: input.type,
    text: input.text,
    reason: input.reason,
    createdAt,
    provenance: {
      source: input.source,
      agent: input.agent,
      recordedBy: 'relay-cli',
    },
    git: {
      commit: snapshot.commit,
      branch: snapshot.branch,
      fingerprint: snapshot.fingerprint,
    },
  });
  await updateState(projectRoot, (current) => {
    if (current.sessionId !== state.sessionId)
      throw new Error(
        'The active Relay task changed before the note was saved.',
      );
    if (current.notes.length >= 500)
      throw new Error(
        'This task already has 500 Relay notes. Finish or replace the task before recording more.',
      );
    return {
      ...current,
      notes: [...current.notes, note],
      task: { ...current.task, updatedAt: createdAt },
    };
  });
  return note;
}

/**
 * Atomically import a validated batch of notes with one shared Git anchor.
 * Every item is validated before any state is written; provenance always comes
 * from trusted CLI options, never from the payload.
 */
export async function importHandoffNotes(
  projectRoot: string,
  state: RelayState,
  input: ImportHandoffNotesInput,
): Promise<HandoffNote[]> {
  if (input.source === 'agent' && !input.agent)
    throw new Error('Agent-reported notes require --agent <name>.');
  if (input.source === 'user' && input.agent)
    throw new Error('--agent can only be used with --source agent.');
  if (input.notes.length < 1)
    throw new Error('A note import requires at least one note.');
  if (input.notes.length > NOTE_IMPORT_MAX_ITEMS)
    throw new Error(
      `A note import accepts at most ${NOTE_IMPORT_MAX_ITEMS} notes.`,
    );

  const parsed: Array<{
    type: HandoffNoteType;
    text: string;
    reason?: string;
  }> = input.notes.map((item) => ({
    type: parseNoteType(item.type),
    text: item.text,
    reason: item.reason,
  }));

  const snapshot = await inspectGitSnapshot(projectRoot, 1);
  const createdAt = new Date().toISOString();
  const notes = parsed.map((item) =>
    handoffNoteSchema.parse({
      id: randomUUID(),
      type: item.type,
      text: item.text,
      reason: item.reason,
      createdAt,
      provenance: {
        source: input.source,
        agent: input.agent,
        recordedBy: 'relay-cli',
      },
      git: {
        commit: snapshot.commit,
        branch: snapshot.branch,
        fingerprint: snapshot.fingerprint,
      },
    }),
  );
  await updateState(projectRoot, (current) => {
    if (current.sessionId !== state.sessionId)
      throw new Error(
        'The active Relay task changed before the notes were saved.',
      );
    if (current.notes.length + notes.length > 500)
      throw new Error(
        'This task already has 500 Relay notes. Finish or replace the task before recording more.',
      );
    return {
      ...current,
      notes: [...current.notes, ...notes],
      task: { ...current.task, updatedAt: createdAt },
    };
  });
  return notes;
}

export async function resolveHandoffNote(
  projectRoot: string,
  state: RelayState,
  id: string,
): Promise<HandoffNote> {
  let resolved: HandoffNote | undefined;
  const resolvedAt = new Date().toISOString();
  await updateState(projectRoot, (current) => {
    if (current.sessionId !== state.sessionId)
      throw new Error(
        'The active Relay task changed before the note was resolved.',
      );
    const notes = current.notes.map((note) => {
      if (note.id !== id) return note;
      if (note.resolvedAt)
        throw new Error(`Relay note ${id} is already resolved.`);
      resolved = { ...note, resolvedAt };
      return resolved;
    });
    if (!resolved) throw new Error(`Unknown Relay note: ${id}.`);
    return {
      ...current,
      notes,
      task: { ...current.task, updatedAt: resolvedAt },
    };
  });
  return resolved!;
}
