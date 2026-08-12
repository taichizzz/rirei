import type { RelayConfig } from './config/schema.js';
import type { GitSnapshot } from './git/repository.js';
import { noteFreshness, type NoteFreshness } from './state/notes.js';
import type { HandoffNote, RelayState } from './state/schema.js';

const CHARACTERS_PER_TOKEN_ESTIMATE = 4;
const TASK_ITEM_FRACTION = 0.7;
const CONTINUATION_TYPES: ReadonlySet<HandoffNote['type']> = new Set([
  'next',
  'blocker',
  'rejected',
  'decision',
  'question',
]);

export interface HandoffCapsuleNote extends HandoffNote {
  freshness: NoteFreshness;
}

export interface HandoffCapsule {
  schemaVersion: 1;
  task: {
    title: string;
    originalRequest: string;
    status: RelayState['task']['status'];
  };
  git: {
    commit: string;
    branch: string;
    fingerprint: string;
    changedFiles: string[];
    omittedChangedFiles: number;
  };
  notes: HandoffCapsuleNote[];
  tests: RelayState['tests'];
  legacy: {
    completedWork: RelayState['completedWork'];
    remainingWork: RelayState['remainingWork'];
    decisions: RelayState['decisions'];
    blockers: RelayState['blockers'];
  };
}

export interface RenderedHandoff {
  capsule: HandoffCapsule;
  text: string;
  budget: {
    maxCharacters: number;
    maxTokens: number;
    usedCharacters: number;
    estimatedTokens: number;
    omittedItems: number;
  };
  contentChecks: {
    duplicateTaskOccurrences: number;
    containsNoteInstruction: boolean;
  };
}

/** True when at least one unresolved continuation note exists. */
export function hasContinuationNotes(notes: readonly HandoffNote[]): boolean {
  return notes.some(
    (note) => !note.resolvedAt && CONTINUATION_TYPES.has(note.type),
  );
}

function compact(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function truncate(text: string, maxCharacters: number): string {
  if (text.length <= maxCharacters) return text;
  if (maxCharacters <= 1) return '…'.slice(0, maxCharacters);
  let end = maxCharacters - 1;
  const finalCodeUnit = text.charCodeAt(end - 1);
  if (finalCodeUnit >= 0xd800 && finalCodeUnit <= 0xdbff) end -= 1;
  return `${text.slice(0, end).trimEnd()}…`;
}

export function buildHandoffCapsule(
  state: RelayState,
  snapshot: GitSnapshot,
  maxChangedFiles: number,
): HandoffCapsule {
  const allChangedFiles = snapshot.status.split('\n').filter(Boolean);
  const changedFiles = allChangedFiles.slice(0, maxChangedFiles);
  return {
    schemaVersion: 1,
    task: {
      title: state.task.title,
      originalRequest: state.task.originalRequest,
      status: state.task.status,
    },
    git: {
      commit: snapshot.commit,
      branch: snapshot.branch,
      fingerprint: snapshot.fingerprint,
      changedFiles,
      omittedChangedFiles: Math.max(
        0,
        allChangedFiles.length - changedFiles.length,
      ),
    },
    notes: state.notes.map((note) => ({
      ...note,
      freshness: noteFreshness(note, snapshot),
    })),
    tests: state.tests,
    legacy: {
      completedWork: state.completedWork,
      remainingWork: state.remainingWork,
      decisions: state.decisions,
      blockers: state.blockers,
    },
  };
}

function noteTitle(type: HandoffNote['type']): string {
  switch (type) {
    case 'next':
      return 'Next';
    case 'blocker':
      return 'Blocked';
    case 'rejected':
      return 'Avoid';
    case 'decision':
      return 'Decision';
    case 'question':
      return 'Question';
    default:
      return 'Done';
  }
}

function formatNote(note: HandoffCapsuleNote): string {
  const freshness = note.freshness === 'current' ? '' : ` [${note.freshness}]`;
  const reason = note.reason ? ` — ${compact(note.reason)}` : '';
  return `${compact(note.text)}${reason}${freshness}`;
}

function failedTestItem(tests: RelayState['tests']): string | null {
  const failed = [...tests].reverse().find((test) => test.status === 'failed');
  if (!failed) return null;
  const detail = failed.summary ? ` — ${compact(failed.summary)}` : '';
  return `failed ${compact(failed.command)}${detail}`;
}

function normalizeForComparison(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function renderCompactHandoff(
  capsule: HandoffCapsule,
  config: RelayConfig['handoff'],
): RenderedHandoff {
  const effectiveMaxTokens = Math.min(config.maxTokens, config.targetTokens);
  const effectiveMaxCharacters = Math.min(
    config.maxCharacters,
    config.targetCharacters,
    effectiveMaxTokens * CHARACTERS_PER_TOKEN_ESTIMATE,
  );

  const notes = capsule.notes
    .filter((note) => !note.resolvedAt)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  const notesOf = (type: HandoffNote['type']) =>
    notes.filter((note) => note.type === type).map(formatNote);

  const request = compact(capsule.task.originalRequest);
  const taskItem = `Task: ${truncate(
    request,
    Math.floor(effectiveMaxCharacters * TASK_ITEM_FRACTION),
  )}`;
  const dirty =
    capsule.git.changedFiles.length > 0 || capsule.git.omittedChangedFiles > 0;
  const gitAnchor = `Git: ${capsule.git.branch}@${capsule.git.commit.slice(0, 7)}${dirty ? '; dirty' : ''}`;
  const safety = 'Inspect the working tree and preserve existing changes.';

  const separator = '\n\n';
  let mandatory = [taskItem, gitAnchor, safety].join(separator);
  if (mandatory.length > effectiveMaxCharacters) {
    const nonTask = `${gitAnchor}${separator}${safety}`;
    const taskBudget =
      effectiveMaxCharacters - nonTask.length - separator.length;
    mandatory =
      taskBudget > 0
        ? [truncate(`Task: ${request}`, taskBudget), gitAnchor, safety].join(
            separator,
          )
        : truncate(
            `${taskItem}${separator}${gitAnchor}${separator}${safety}`,
            effectiveMaxCharacters,
          );
  }

  const blocks: Array<{
    title: string;
    items: string[];
    mandatory?: boolean;
  }> = [];
  const remainingBlocks: Array<{ title: string; items: string[] }> = [];
  for (const type of [
    'next',
    'blocker',
    'rejected',
    'decision',
    'question',
  ] as const) {
    const items = notesOf(type);
    if (items.length === 0) continue;
    blocks.push({
      title: noteTitle(type),
      items: items.slice(0, 1),
      mandatory: type === 'next' || type === 'blocker',
    });
    if (items.length > 1)
      remainingBlocks.push({
        title: noteTitle(type),
        items: items.slice(1),
      });
  }
  blocks.push(...remainingBlocks);
  const failedTest = failedTestItem(capsule.tests);
  if (failedTest) blocks.push({ title: 'Test', items: [failedTest] });

  let body = mandatory;
  let omittedItems = 0;
  for (const block of blocks) {
    const accepted: string[] = [];
    for (const item of block.items) {
      const candidateBlock = `${block.title}: ${[...accepted, item].join('; ')}`;
      if (
        `${body}${separator}${candidateBlock}`.length <= effectiveMaxCharacters
      ) {
        accepted.push(item);
      } else if (block.mandatory && accepted.length === 0) {
        const itemBudget =
          effectiveMaxCharacters -
          body.length -
          separator.length -
          block.title.length -
          2;
        if (itemBudget > 1) accepted.push(truncate(item, itemBudget));
        else omittedItems += 1;
      } else {
        omittedItems += 1;
      }
    }
    if (accepted.length > 0)
      body += `${separator}${block.title}: ${accepted.join('; ')}`;
  }
  if (omittedItems > 0) {
    const omission = `Omitted: ${omittedItems} lower-priority item${omittedItems === 1 ? '' : 's'}; inspect the working tree if needed.`;
    if (`${body}${separator}${omission}`.length <= effectiveMaxCharacters)
      body += `${separator}${omission}`;
  }

  const text = body;
  const normalizedText = normalizeForComparison(text);
  const normalizedRequest = normalizeForComparison(request);
  const normalizedTaskBlock = normalizeForComparison(
    text.split(separator, 1)[0] ?? '',
  );
  const countOccurrences = (haystack: string, needle: string) => {
    let count = 0;
    let index = 0;
    while (index < haystack.length) {
      const found = haystack.indexOf(needle, index);
      if (found < 0) break;
      count += 1;
      index = found + needle.length;
    }
    return count;
  };
  let duplicateTaskOccurrences = normalizedTaskBlock.startsWith('Task:')
    ? 1
    : 0;
  if (normalizedRequest.length > 0) {
    duplicateTaskOccurrences +=
      countOccurrences(normalizedText, normalizedRequest) -
      countOccurrences(normalizedTaskBlock, normalizedRequest);
  }
  return {
    capsule,
    text,
    budget: {
      maxCharacters: effectiveMaxCharacters,
      maxTokens: effectiveMaxTokens,
      usedCharacters: text.length,
      estimatedTokens: Math.ceil(text.length / CHARACTERS_PER_TOKEN_ESTIMATE),
      omittedItems,
    },
    contentChecks: {
      duplicateTaskOccurrences,
      containsNoteInstruction: /relay\s+note/i.test(text),
    },
  };
}
