import { execFile } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { stripVTControlCharacters, promisify } from 'node:util';
import { redactSecrets } from '../safety/redaction.js';
import {
  SNAPSHOT_TEXT_LIMITS,
  type CoveredSnapshot,
  type SnapshotInspectionEntry,
} from './snapshot.js';
import type { InspectionExcerpt } from './inspection-schema.js';

const execute = promisify(execFile);
const MAX_EXCERPTS = 24;
const MAX_LINES = 32;
const MAX_CHARACTERS = 1600;

export function changedInput(entry: SnapshotInspectionEntry): boolean {
  return entry.staged !== 'none' || entry.worktree !== 'none';
}

function display(text: string) {
  const clean = redactSecrets(stripVTControlCharacters(text));
  let end = Math.min(clean.redactedText.length, MAX_CHARACTERS);
  if (/^[\uD800-\uDBFF]$/.test(clean.redactedText.slice(end - 1, end))) end--;
  return {
    text: clean.redactedText.slice(0, end),
    redacted:
      clean.redactions.length > 0 || stripVTControlCharacters(text) !== text,
    truncated: end < clean.redactedText.length,
  };
}

interface Line {
  prefix: ' ' | '-' | '+';
  text: string;
  old: number;
  current: number;
}

/** Bounded line comparison for display only, never an executable/applyable patch. */
function hunks(before: string, after: string) {
  const left = before === '' ? [] : before.split('\n');
  const right = after === '' ? [] : after.split('\n');
  let prefix = 0;
  while (
    prefix < left.length &&
    prefix < right.length &&
    left[prefix] === right[prefix]
  )
    prefix++;
  let suffix = 0;
  while (
    suffix < left.length - prefix &&
    suffix < right.length - prefix &&
    left[left.length - suffix - 1] === right[right.length - suffix - 1]
  )
    suffix++;
  const a = left.slice(prefix, left.length - suffix);
  const b = right.slice(prefix, right.length - suffix);
  if (!a.length && !b.length) return [];
  const complex =
    (a.length + 1) * (b.length + 1) > 250000 || a.length + b.length > 2000;
  const operations: Line[] = [];
  let old = prefix + 1;
  let current = prefix + 1;
  for (let index = Math.max(0, prefix - 2); index < prefix; index++)
    operations.push({
      prefix: ' ',
      text: left[index]!,
      old: index + 1,
      current: index + 1,
    });
  const push = (kind: Line['prefix'], text: string) => {
    operations.push({ prefix: kind, text, old, current });
    if (kind !== '+') old++;
    if (kind !== '-') current++;
  };
  if (complex) {
    for (const line of a.slice(0, 12)) push('-', line);
    // The added window starts at the true changed-region coordinate, even if old lines were omitted.
    for (const line of b.slice(0, 12)) push('+', line);
  } else {
    const width = b.length + 1;
    const table = new Uint16Array((a.length + 1) * width);
    for (let i = a.length - 1; i >= 0; i--)
      for (let j = b.length - 1; j >= 0; j--)
        table[i * width + j] =
          a[i] === b[j]
            ? table[(i + 1) * width + j + 1]! + 1
            : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
    let i = 0;
    let j = 0;
    while (i < a.length || j < b.length) {
      if (i < a.length && j < b.length && a[i] === b[j]) {
        push(' ', a[i++]!);
        j++;
      } else if (
        i < a.length &&
        (j === b.length ||
          table[(i + 1) * width + j]! >= table[i * width + j + 1]!)
      )
        push('-', a[i++]!);
      else push('+', b[j++]!);
    }
    for (let index = 0; index < Math.min(2, suffix); index++)
      push(' ', left[left.length - suffix + index]!);
  }
  const groups: Array<{ start: number; end: number }> = [];
  for (let index = 0; index < operations.length; index++)
    if (operations[index]!.prefix !== ' ') {
      const start = Math.max(0, index - 2);
      const end = Math.min(operations.length, index + 3);
      const last = groups.at(-1);
      if (last && start <= last.end) last.end = end;
      else groups.push({ start, end });
    }
  return groups.slice(0, 4).map((group) => {
    const lines = operations.slice(
      group.start,
      Math.min(group.end, group.start + MAX_LINES),
    );
    const first = lines[0]!;
    const oldCount = lines.filter((line) => line.prefix !== '+').length;
    const newCount = lines.filter((line) => line.prefix !== '-').length;
    const shown = display(
      `@@ -${first.old},${oldCount} +${first.current},${newCount} @@\n${lines.map((line) => line.prefix + line.text).join('\n')}`,
    );
    return {
      ...shown,
      startLine: first.current,
      endLine: first.current + Math.max(0, newCount - 1),
      truncated:
        shown.truncated ||
        complex ||
        groups.length > 4 ||
        group.end - group.start > MAX_LINES,
    };
  });
}

export async function inspectionCode(
  snapshot: CoveredSnapshot,
  references: string[],
  options: { file?: string; timeoutMs?: number } = {},
): Promise<{
  excerpts: InspectionExcerpt[];
  omissions: Map<string, string>;
  gaps: string[];
}> {
  const excerpts: InspectionExcerpt[] = [];
  const omissions = new Map<string, string>();
  const gaps: string[] = [];
  if (snapshot.identity.coverage.status !== 'complete')
    return {
      excerpts,
      omissions,
      gaps: ['metadata-only: covered inputs incomplete'],
    };
  const deadline =
    performance.now() + Math.min(1000, options.timeoutMs ?? 1000);
  let bytes = 0;
  const blobs = new Map<string, string>();
  const env = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => !key.toUpperCase().startsWith('GIT_'),
      ),
    ),
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
  };
  async function blob(oid: string | null): Promise<string> {
    if (!oid) return '';
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(oid))
      throw new Error('git-object-unavailable');
    const cached = blobs.get(oid);
    if (cached !== undefined) return cached;
    if (
      bytes >= SNAPSHOT_TEXT_LIMITS.totalBytes ||
      performance.now() >= deadline
    )
      throw new Error('source-read-limit');
    const { stdout } = await execute('git', ['cat-file', 'blob', oid], {
      cwd: snapshot.workspace,
      encoding: 'buffer',
      maxBuffer: Math.min(
        SNAPSHOT_TEXT_LIMITS.fileBytes,
        SNAPSHOT_TEXT_LIMITS.totalBytes - bytes,
      ),
      timeout: Math.max(1, Math.floor(deadline - performance.now())),
      killSignal: 'SIGKILL',
      windowsHide: true,
      env,
    }).catch(() => {
      throw new Error('git-object-unavailable-or-limited');
    });
    bytes += stdout.length;
    if (stdout.includes(0)) throw new Error('binary-or-invalid-utf8');
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(stdout);
    } catch {
      throw new Error('binary-or-invalid-utf8');
    }
    blobs.set(oid, text);
    return text;
  }
  const all = snapshot.inspection ?? [];
  const selected = all
    .filter((entry) =>
      options.file
        ? entry.path === options.file
        : changedInput(entry) || references.includes(entry.path),
    )
    .sort(
      (a, b) =>
        Number(changedInput(b)) - Number(changedInput(a)) ||
        (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
    );
  if (options.file && !selected.length)
    omissions.set(options.file, 'path-not-in-covered-manifest');
  for (const entry of selected) {
    if (excerpts.length >= MAX_EXCERPTS || performance.now() >= deadline) {
      omissions.set(entry.path, 'excerpt-or-deadline-limit');
      continue;
    }
    if (!['file', 'deleted'].includes(entry.kind) || entry.omission) {
      omissions.set(
        entry.path,
        entry.omission ?? `${entry.kind}-content-not-covered`,
      );
      continue;
    }
    try {
      const append = (
        before: string,
        after: string,
        layer: 'staged' | 'worktree',
        oid: string | null,
      ) => {
        for (const hunk of hunks(before, after)) {
          if (excerpts.length >= MAX_EXCERPTS) {
            omissions.set(entry.path, 'excerpt-limit');
            break;
          }
          excerpts.push({
            kind: 'diff',
            path: entry.path,
            layer,
            ...(oid ? { baseOid: oid } : {}),
            ...(layer === 'staged' && entry.indexOid
              ? { resultOid: entry.indexOid }
              : {}),
            ...(layer === 'worktree' && entry.contentHash
              ? { contentHash: entry.contentHash }
              : {}),
            ...hunk,
          });
          if (hunk.truncated)
            omissions.set(entry.path, 'diff-display-truncated');
        }
      };
      if (entry.staged !== 'none')
        append(
          await blob(entry.headOid),
          await blob(entry.indexOid),
          'staged',
          entry.headOid,
        );
      if (entry.worktree !== 'none') {
        const current = entry.kind === 'deleted' ? '' : entry.text;
        if (current === undefined)
          omissions.set(entry.path, 'current-source-not-captured');
        else
          append(
            await blob(entry.indexOid),
            current,
            'worktree',
            entry.indexOid,
          );
      }
      if (!changedInput(entry) && entry.text !== undefined) {
        const lines = entry.text.split('\n');
        const shown = display(lines.slice(0, 24).join('\n'));
        excerpts.push({
          kind: 'current-file',
          path: entry.path,
          layer: 'current',
          ...(entry.contentHash ? { contentHash: entry.contentHash } : {}),
          startLine: 1,
          endLine: Math.min(lines.length, 24),
          ...shown,
          truncated: shown.truncated || lines.length > 24,
        });
      }
    } catch (error) {
      omissions.set(
        entry.path,
        error instanceof Error ? error.message : 'source-unavailable',
      );
    }
  }
  return { excerpts, omissions, gaps };
}
