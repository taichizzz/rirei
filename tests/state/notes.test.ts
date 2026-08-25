import { mkdir, readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { inspectGitSnapshot } from '../../src/git/repository.js';
import { relayPath } from '../../src/safety/path-policy.js';
import {
  importHandoffNotes,
  NOTE_IMPORT_MAX_ITEMS,
  parseNoteType,
  type NoteImportItem,
} from '../../src/state/notes.js';
import { type RelayState } from '../../src/state/schema.js';
import { readState, writeState } from '../../src/state/store.js';
import { createRepository, removeRepository } from '../helpers.js';

const directories: string[] = [];

function state(root: string): RelayState {
  const now = '2026-01-01T00:00:00.000Z';
  return {
    schemaVersion: 8,
    revision: 0,
    recentOperations: [],
    runs: [],
    sessionId: 'session',
    projectRoot: root,
    task: {
      title: 'Task',
      originalRequest: 'Task',
      requirements: [],
      constraints: [],
      status: 'active',
      createdAt: now,
      updatedAt: now,
    },
    git: { startingCommit: 'abc', startingBranch: 'main', dirtyAtStart: false },
    agentHistory: [],
    decisions: [],
    completedWork: [],
    remainingWork: [],
    tests: [],
    checkpoints: [],
    blockers: [],
    notes: [],
  };
}

async function withState(): Promise<string> {
  const root = await createRepository();
  directories.push(root);
  await mkdir(relayPath(root), { recursive: true });
  await writeState(root, state(root));
  return root;
}

async function persisted(root: string): Promise<RelayState> {
  return JSON.parse(await readFile(relayPath(root, 'state.json'), 'utf8'));
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(removeRepository));
});

describe('note type parsing', () => {
  it('accepts canonical types', () => {
    for (const type of [
      'done',
      'next',
      'decision',
      'rejected',
      'blocker',
      'question',
    ]) {
      expect(parseNoteType(type)).toBe(type);
    }
  });

  it('rejects ambiguous work words with next/done guidance', () => {
    for (const type of ['progress', 'implementation', 'wip', 'todo']) {
      expect(() => parseNoteType(type)).toThrow(/Unsupported note type/);
      expect(() => parseNoteType(type)).toThrow(/in "next".*in "done"/s);
    }
  });

  it('includes the canonical type list in every diagnostic', () => {
    for (const type of ['progress', 'donee', 'whatever']) {
      expect(() => parseNoteType(type)).toThrow(
        /done, next, decision, rejected, blocker, question/,
      );
    }
  });
});

describe('atomic batch note import', () => {
  it('writes all notes with one shared Git anchor and agent provenance', async () => {
    const root = await withState();
    const items: NoteImportItem[] = [
      { type: 'done', text: 'foundation' },
      { type: 'rejected', text: 'parseInt', reason: 'accepts junk prefixes' },
      { type: 'next', text: 'IMF-fixdate' },
    ];
    const notes = await importHandoffNotes(root, await readState(root), {
      notes: items,
      source: 'agent',
      agent: 'antigravity',
    });
    expect(notes).toHaveLength(3);
    const snapshot = await inspectGitSnapshot(root, 1);
    const anchors = new Set(notes.map((note) => JSON.stringify(note.git)));
    expect(anchors).toHaveLength(1);
    for (const note of notes) {
      expect(note.provenance).toMatchObject({
        source: 'agent',
        agent: 'antigravity',
      });
      expect(note.git.commit).toBe(snapshot.commit);
      expect(note.createdAt).toBe(notes[0]!.createdAt);
    }
    const persistedState = await persisted(root);
    expect(persistedState.notes).toHaveLength(3);
  });

  it('rejects the entire batch when any item is invalid and writes nothing', async () => {
    const root = await withState();
    const items: NoteImportItem[] = [
      { type: 'done', text: 'ok' },
      { type: 'not-a-type', text: 'bad' },
    ];
    await expect(
      importHandoffNotes(root, await readState(root), {
        notes: items,
        source: 'user',
      }),
    ).rejects.toThrow(/Unsupported note type "not-a-type"/);
    expect((await persisted(root)).notes).toHaveLength(0);
  });

  it('rejects an empty batch and more than 20 items', async () => {
    const root = await withState();
    await expect(
      importHandoffNotes(root, await readState(root), {
        notes: [],
        source: 'user',
      }),
    ).rejects.toThrow(/at least one note/);
    const many: NoteImportItem[] = Array.from(
      { length: NOTE_IMPORT_MAX_ITEMS + 1 },
      (_, index) => ({ type: 'done', text: `note ${index}` }),
    );
    await expect(
      importHandoffNotes(root, await readState(root), {
        notes: many,
        source: 'user',
      }),
    ).rejects.toThrow(/at most \d+ notes/);
    expect((await persisted(root)).notes).toHaveLength(0);
  });

  it('requires --agent for agent provenance and rejects it for user provenance', async () => {
    const root = await withState();
    const items: NoteImportItem[] = [{ type: 'next', text: 'work' }];
    await expect(
      importHandoffNotes(root, await readState(root), {
        notes: items,
        source: 'agent',
      }),
    ).rejects.toThrow(/require --agent/);
    await expect(
      importHandoffNotes(root, await readState(root), {
        notes: items,
        source: 'user',
        agent: 'claude',
      }),
    ).rejects.toThrow(/only be used with --source agent/);
    expect((await persisted(root)).notes).toHaveLength(0);
  });

  it('rejects a replaced session before committing', async () => {
    const root = await withState();
    const current = await readState(root);
    const stale = {
      ...current,
      sessionId: '00000000-0000-0000-0000-000000000000',
    };
    await expect(
      importHandoffNotes(root, stale, {
        notes: [{ type: 'next', text: 'work' }],
        source: 'user',
      }),
    ).rejects.toThrow(/active Relay task changed/i);
    expect((await persisted(root)).notes).toHaveLength(0);
  });

  it('enforces the 500-note session limit on the final combined count', async () => {
    const root = await withState();
    const filled = state(root);
    filled.notes = Array.from({ length: 500 }, (_, index) => ({
      id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      type: 'done' as const,
      text: 'full',
      createdAt: '2026-01-01T00:00:00.000Z',
      provenance: { source: 'user' as const, recordedBy: 'relay-cli' },
      git: {
        commit: 'abc',
        branch: 'main',
        fingerprint: 'f'.repeat(64),
      },
    }));
    await writeState(root, filled);
    await expect(
      importHandoffNotes(root, filled, {
        notes: [{ type: 'next', text: 'one too many' }],
        source: 'user',
      }),
    ).rejects.toThrow(/500/);
    expect((await persisted(root)).notes).toHaveLength(500);
  });
});
