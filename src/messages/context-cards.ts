import { readCheckpointDiff } from '../checkpoints.js';
import type { RelayState } from '../state/schema.js';
import { contextCardsSchema, type ContextCard } from './schema.js';
import { assertNoSecrets } from '../safety/redaction.js';

export async function resolveNoteContextCard(
  state: RelayState,
  noteId: string,
  allowRedact = false,
): Promise<ContextCard> {
  const canonicalId = noteId.startsWith('note:') ? noteId.slice(5) : noteId;
  const note = state.notes.find((n) => n.id === canonicalId);
  if (!note) {
    throw new Error(`Note "${canonicalId}" was not found in task state.`);
  }

  const lines = [`Type: ${note.type}`, `Text: ${note.text}`];
  if (note.reason) lines.push(`Reason: ${note.reason}`);
  lines.push(`Git: ${note.git.branch}@${note.git.commit.slice(0, 7)}`);
  lines.push(`Recorded: ${note.createdAt}`);

  const rawText = lines.join('\n');
  const { cleanText } = assertNoSecrets(rawText, allowRedact);

  const title = `Note: ${note.type} (${note.id.slice(0, 8)})`;
  const { cleanText: cleanTitle } = assertNoSecrets(title, allowRedact);

  return {
    kind: 'note',
    sourceId: note.id,
    title: cleanTitle,
    text: cleanText,
    capturedAt: new Date().toISOString(),
  };
}

export async function resolveCheckpointContextCard(
  projectRoot: string,
  state: RelayState,
  checkpointId: string,
  allowRedact = false,
): Promise<ContextCard> {
  const canonicalId = checkpointId.startsWith('checkpoint:')
    ? checkpointId.slice(11)
    : checkpointId;
  const checkpoint = state.checkpoints.find((c) => c.id === canonicalId);
  if (!checkpoint) {
    throw new Error(`Checkpoint "${canonicalId}" was not found in task state.`);
  }

  const artifact = await readCheckpointDiff(projectRoot, canonicalId);

  const lines = [`Checkpoint ID: ${checkpoint.id}`];
  if (checkpoint.label) lines.push(`Label: ${checkpoint.label}`);
  lines.push(`Created: ${checkpoint.createdAt}`);

  lines.push(`Branch: ${artifact.metadata.branch}`);
  lines.push(`Commit: ${artifact.metadata.commit.slice(0, 7)}`);

  if (artifact.status.trim()) {
    lines.push('\nGit Status:');
    lines.push(artifact.status.trim().slice(0, 500));
  }

  if (artifact.diffStat.trim()) {
    lines.push('\nDiff Stat:');
    lines.push(artifact.diffStat.trim().slice(0, 1500));
  }

  const rawText = lines.join('\n');
  const { cleanText } = assertNoSecrets(rawText, allowRedact);

  const title = `Checkpoint: ${checkpoint.id}${checkpoint.label ? ` (${checkpoint.label})` : ''}`;
  const { cleanText: cleanTitle } = assertNoSecrets(title, allowRedact);

  return {
    kind: 'checkpoint_summary',
    sourceId: checkpoint.id,
    title: cleanTitle,
    text: cleanText,
    capturedAt: new Date().toISOString(),
  };
}

export function validateContextCards(cards: ContextCard[]): void {
  contextCardsSchema.parse(cards);
}
