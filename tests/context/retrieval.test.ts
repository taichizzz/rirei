import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  contextDirectory,
  setContextConsent,
} from '../../src/context/store.js';
import { retrieveWindow } from '../../src/context/retrieval.js';
import { inspectCoveredSnapshot } from '../../src/context/snapshot.js';
import { updateState } from '../../src/state/store.js';
import { retrievalProject } from './retrieval-helpers.js';

const execute = promisify(execFile);
const hash = (value: string | Uint8Array) =>
  createHash('sha256').update(value).digest('hex');

describe('targeted retained evidence retrieval', () => {
  it.each(['json', 'text'] as const)(
    'round-trips exact retained Unicode windows with repeatable cursors and a final %s envelope cap',
    async (format) => {
      const { root, record } = await retrievalProject();
      const text = '😀 quoted "text" \\ 日本語\r\n'.repeat(40);
      const event = await record(text, {
        kind: 'tool_result',
        redacted: true,
        truncated: true,
      });
      const query = {
        type: 'evidence',
        eventId: event.id,
        start: 0,
        length: 100,
      };
      let cursor: string | undefined;
      let combined = '';
      let pages = 0;
      do {
        const result = await retrieveWindow(root, root, query, {
          cursor,
          format,
          maxCharacters: 1200,
        });
        const window = result.envelope.result!;
        expect(result.output.length).toBeLessThanOrEqual(1200);
        expect(result.envelope.budget.usedCharacters).toBe(
          result.output.length,
        );
        expect(result.output.isWellFormed()).toBe(true);
        expect(window.text!.isWellFormed()).toBe(true);
        expect(window.returned.start).toBe(combined.length);
        expect(window.text).toBe(
          text.slice(window.returned.start, window.returned.end),
        );
        expect(window.source).toMatchObject({
          id: event.id,
          digest: hash(text),
          recordDigest: event.hash,
          captured: { redacted: true, truncated: true },
        });
        if (cursor && pages === 1)
          expect(
            (
              await retrieveWindow(root, root, query, {
                cursor,
                format,
                maxCharacters: 1200,
              })
            ).output,
          ).toBe(result.output);
        combined += window.text;
        cursor = window.nextCursor ?? undefined;
        expect(++pages).toBeLessThan(100);
        if (format === 'json')
          expect(JSON.parse(result.output)).toEqual(result.envelope);
      } while (cursor);
      expect(combined).toBe(text);
      expect(pages).toBeGreaterThan(1);
    },
  );

  it('adjusts a requested split surrogate explicitly and still makes progress with length one', async () => {
    const { root, record } = await retrievalProject();
    const event = await record('😀x');
    const query = { type: 'evidence', eventId: event.id, start: 1, length: 1 };
    const first = await retrieveWindow(root, root, query);
    expect(first.envelope.result).toMatchObject({
      requested: { start: 1, length: 1 },
      returned: { start: 0, end: 2 },
      text: '😀',
    });
    const last = await retrieveWindow(root, root, query, {
      cursor: first.envelope.result!.nextCursor!,
    });
    expect(last.envelope.result).toMatchObject({
      returned: { start: 2, end: 3 },
      text: 'x',
      nextCursor: null,
    });
  });

  it('reaches more than twenty submitted requirements without conflating a partial match page with completion', async () => {
    const { root, record } = await retrievalProject();
    const ids: string[] = [];
    for (let index = 0; index < 27; index++)
      ids.push(
        (await record(`Requirement ${index}: preserve exact value ${index}.`))
          .id,
      );
    await record('Tool noise', {
      kind: 'tool_result',
      filePath: 'src/noise.ts',
    });
    const query = { type: 'find', kind: 'prompt_submission', limit: 20 };
    let cursor: string | undefined;
    const found: string[] = [];
    let pages = 0;
    do {
      const result = await retrieveWindow(root, root, query, { cursor });
      const page = result.envelope.result!;
      expect(result.output.length).toBeLessThanOrEqual(2000);
      expect(page.source.totalMatches).toBe(27);
      expect(page.matches!.length).toBeGreaterThan(0);
      found.push(...page.matches!.map((row) => row.id as string));
      cursor = page.nextCursor ?? undefined;
      expect(++pages).toBeLessThan(30);
    } while (cursor);
    expect(found).toEqual(ids);
    expect(pages).toBeGreaterThan(1);
  });

  it('indexes exact file/tool/command fields without deriving file dependencies from shell strings', async () => {
    const { root, record } = await retrievalProject();
    const start = await record('started', {
      kind: 'tool_start',
      toolId: 'test-1',
      command: 'npm test -- src/feed.ts',
    });
    const result = await record('failed', {
      kind: 'tool_result',
      toolId: 'test-1',
      filePath: 'src/feed.ts',
      outcome: 'reported_failure',
      exitCode: 2,
    });
    await record('shell path only', {
      kind: 'tool_result',
      command: 'cat src/feed.ts',
    });
    const matching = (
      await retrieveWindow(root, root, { type: 'find', file: 'src/feed.ts' })
    ).envelope.result!.matches!;
    expect(matching.map((row) => row.id)).toEqual([result.id]);
    expect(matching[0]).toMatchObject({
      reportedOutcome: 'reported_failure',
      reportedExitCode: 2,
    });
    const commandId = matching[0]!.commandId as string;
    expect(commandId).toMatch(/^c-[a-f0-9]{32}$/);
    const command = (
      await retrieveWindow(root, root, { type: 'find', commandId })
    ).envelope.result!;
    expect(command.matches!.map((row) => row.id)).toEqual([
      start.id,
      result.id,
    ]);
    const narrowed = (
      await retrieveWindow(root, root, {
        type: 'find',
        commandId,
        kind: 'tool_result',
        toolId: 'test-1',
      })
    ).envelope.result!;
    expect(narrowed.matches!.map((row) => row.id)).toEqual([result.id]);
    expect(
      (await retrieveWindow(root, root, { type: 'find', file: 'different.ts' }))
        .envelope.result,
    ).toMatchObject({ matches: [], nextCursor: null });
  });

  it('rejects changed filters, ranges, damaged cursors, and newly appended history', async () => {
    const { root, record } = await retrievalProject();
    const event = await record('Long evidence '.repeat(200));
    const query = { type: 'evidence', eventId: event.id, start: 0, length: 20 };
    const cursor = (await retrieveWindow(root, root, query)).envelope.result!
      .nextCursor!;
    for (const changed of [
      { ...query, start: 1 },
      { ...query, length: 21 },
    ])
      await expect(
        retrieveWindow(root, root, changed, { cursor }),
      ).rejects.toMatchObject({ code: 'stale_cursor' });
    await expect(
      retrieveWindow(root, root, query, {
        cursor: cursor.slice(0, -1) + (cursor.endsWith('A') ? 'B' : 'A'),
      }),
    ).rejects.toMatchObject({ code: 'stale_cursor' });
    await expect(
      retrieveWindow(root, root, query, { cursor: '!invalid' }),
    ).rejects.toMatchObject({ code: 'stale_cursor' });
    await record('Later requirement');
    await expect(
      retrieveWindow(root, root, query, { cursor }),
    ).rejects.toMatchObject({ code: 'stale_cursor' });
    expect(
      (
        await retrieveWindow(root, root, {
          type: 'find',
          kind: 'prompt_submission',
        })
      ).envelope.result!.source.totalMatches,
    ).toBe(2);
    const findCursor = (
      await retrieveWindow(root, root, { type: 'find', limit: 1 })
    ).envelope.result!.nextCursor!;
    await expect(
      retrieveWindow(
        root,
        root,
        { type: 'find', limit: 1, kind: 'prompt_submission' },
        { cursor: findCursor },
      ),
    ).rejects.toMatchObject({ code: 'stale_cursor' });
  });

  it('scopes evidence and cursors to current task/workspace and consent epochs', async () => {
    const { root, state, record } = await retrievalProject();
    const other = await retrievalProject();
    const event = await record('Evidence '.repeat(100));
    const query = { type: 'evidence', eventId: event.id, length: 20 };
    const first = await retrieveWindow(root, root, query);
    const cursor = first.envelope.result!.nextCursor!;
    await expect(
      retrieveWindow(root, other.root, query, { cursor }),
    ).rejects.toMatchObject({ code: 'source_not_found' });
    await setContextConsent(root, state.sessionId, false);
    await expect(
      retrieveWindow(root, root, query, { requireConsent: true }),
    ).rejects.toMatchObject({ code: 'disclosure_disabled' });
    await expect(
      retrieveWindow(root, root, query, { cursor }),
    ).rejects.toMatchObject({ code: 'stale_cursor' });
    expect(
      (await retrieveWindow(root, root, query)).envelope.result!.text,
    ).toBe(event.text.slice(0, 20));
    await setContextConsent(root, state.sessionId, true);
    const fresh = await retrieveWindow(root, root, query);
    await updateState(root, (current) => ({
      ...current,
      task: { ...current.task, constraints: ['New constraint'] },
    }));
    await expect(
      retrieveWindow(root, root, query, {
        cursor: fresh.envelope.result!.nextCursor!,
      }),
    ).rejects.toMatchObject({ code: 'stale_cursor' });
  });

  it('revalidates the journal before index reuse and does not expose mutable cached source objects', async () => {
    const { root, state, record } = await retrievalProject();
    const event = await record('Original source');
    const first = await retrieveWindow(root, root, { type: 'find' });
    first.envelope.result!.matches![0]!.preview = 'Modified by caller';
    expect(
      (await retrieveWindow(root, root, { type: 'find' })).envelope.result!
        .matches![0]!.preview,
    ).toBe('Original source');
    const journalPath = path.join(
      contextDirectory(root, state.sessionId),
      'events.jsonl',
    );
    const raw = await readFile(journalPath, 'utf8');
    await writeFile(
      journalPath,
      raw.replace('Original source', 'Corrupt source'),
    );
    await expect(
      retrieveWindow(root, root, { type: 'evidence', eventId: event.id }),
    ).rejects.toThrow('integrity');
    await expect(retrieveWindow(root, root, { type: 'find' })).rejects.toThrow(
      'integrity',
    );
  });

  it('rejects invalid query/range/budget input and distinguishes an empty source from missing evidence', async () => {
    const { root, record } = await retrievalProject();
    const empty = await record('');
    expect(
      (
        await retrieveWindow(root, root, {
          type: 'evidence',
          eventId: empty.id,
        })
      ).envelope.result,
    ).toMatchObject({
      text: '',
      returned: { start: 0, end: 0 },
      nextCursor: null,
    });
    await expect(
      retrieveWindow(root, root, {
        type: 'evidence',
        eventId: empty.id,
        start: 1,
      }),
    ).rejects.toMatchObject({ code: 'range_out_of_bounds' });
    await expect(
      retrieveWindow(root, root, {
        type: 'evidence',
        eventId: `e-${'0'.repeat(32)}`,
      }),
    ).rejects.toMatchObject({ code: 'source_not_found' });
    for (const value of [
      { type: 'find', limit: 21 },
      { type: 'find', query: 'inferred shell paths' },
      { type: 'evidence', eventId: empty.id, start: -1 },
      { type: 'evidence', eventId: empty.id, length: 8001 },
    ])
      await expect(retrieveWindow(root, root, value)).rejects.toMatchObject({
        code: 'invalid_query',
      });
    for (const maxCharacters of [1199, 8001, NaN])
      await expect(
        retrieveWindow(root, root, { type: 'find' }, { maxCharacters }),
      ).rejects.toMatchObject({ code: 'invalid_budget' });
  });
});

describe('exact current-file windows', () => {
  it('round-trips BOM, CRLF, Unicode, and a line larger than the response budget', async () => {
    const { root } = await retrievalProject();
    const text =
      '\uFEFFfirst line\r\n' + '😀日本語'.repeat(400) + '\r\nlast line\n';
    await writeFile(path.join(root, 'source.txt'), text);
    const snapshot = await inspectCoveredSnapshot(root);
    const retained = await inspectCoveredSnapshot(
      root,
      {},
      { readFiles: ['source.txt'] },
    );
    expect(retained.identity).toEqual(snapshot.identity);
    const query = {
      type: 'read',
      file: 'source.txt',
      snapshot: snapshot.identity.id,
      lineCount: 1,
    };
    let cursor: string | undefined;
    let combined = '';
    let pages = 0;
    let partialLine = false;
    do {
      const result = await retrieveWindow(root, root, query, { cursor });
      const window = result.envelope.result!;
      expect(window.kind).toBe('file-window');
      expect(window.source.digest).toBe(hash(text));
      expect(window.returned.start).toBe(combined.length);
      expect(window.text).toBe(
        text.slice(window.returned.start, window.returned.end),
      );
      expect(window.text!.isWellFormed()).toBe(true);
      expect(result.output.length).toBeLessThanOrEqual(2000);
      partialLine ||= window.returned.startColumn! > 0;
      combined += window.text;
      cursor = window.nextCursor ?? undefined;
      expect(++pages).toBeLessThan(30);
    } while (cursor);
    expect(combined).toBe(text);
    expect(partialLine).toBe(true);
  });

  it('reads a selected late line beyond the M3 display capture limit and keeps file scope distinct', async () => {
    const { root } = await retrievalProject();
    const text = Array.from(
      { length: 10000 },
      (_, index) => `line ${index}\n`,
    ).join('');
    await writeFile(path.join(root, 'large.txt'), text);
    const result = await retrieveWindow(root, root, {
      type: 'read',
      file: 'large.txt',
      contentHash: hash(text),
      startLine: 9000,
      lineCount: 1,
    });
    expect(result.envelope.result).toMatchObject({
      text: 'line 8999\n',
      source: {
        coverage: 'file-content-only',
        snapshot: null,
        digest: hash(text),
        lines: 10000,
      },
      returned: { startLine: 9000, endLine: 9001, endColumn: 0 },
    });
  });

  it('requires a matching anchor and invalidates file cursors across content or workspace changes', async () => {
    const { root } = await retrievalProject();
    const other = await retrievalProject();
    const text = 'a'.repeat(5000);
    await writeFile(path.join(root, 'source.txt'), text);
    await writeFile(path.join(other.root, 'source.txt'), text);
    const query = { type: 'read', file: 'source.txt', contentHash: hash(text) };
    const first = await retrieveWindow(root, root, query);
    await expect(
      retrieveWindow(root, root, { type: 'read', file: 'source.txt' }),
    ).rejects.toMatchObject({ code: 'anchor_required' });
    await expect(
      retrieveWindow(root, other.root, query, {
        cursor: first.envelope.result!.nextCursor!,
      }),
    ).rejects.toMatchObject({ code: 'stale_cursor' });
    const snapshot = await inspectCoveredSnapshot(root);
    await writeFile(path.join(root, 'source.txt'), 'b'.repeat(5000));
    await expect(
      retrieveWindow(root, root, query, {
        cursor: first.envelope.result!.nextCursor!,
      }),
    ).rejects.toMatchObject({ code: 'stale_content' });
    await expect(
      retrieveWindow(root, root, {
        type: 'read',
        file: 'source.txt',
        snapshot: snapshot.identity.id,
      }),
    ).rejects.toMatchObject({ code: 'stale_snapshot' });
  });

  it('allows a verified file hash with explicitly partial global coverage, never an incomplete snapshot anchor', async () => {
    const { root } = await retrievalProject();
    await writeFile(path.join(root, '.env'), 'private input');
    await execute('git', ['add', '-f', '.env'], { cwd: root });
    const snapshot = await inspectCoveredSnapshot(root);
    expect(snapshot.identity.coverage.status).toBe('partial');
    const result = await retrieveWindow(root, root, {
      type: 'read',
      file: 'README.md',
      contentHash: hash('# Test\n'),
    });
    expect(result.envelope.result!.source.coverage).toBe('file-content-only');
    await expect(
      retrieveWindow(root, root, {
        type: 'read',
        file: 'README.md',
        snapshot: snapshot.identity.id,
      }),
    ).rejects.toMatchObject({ code: 'stale_snapshot' });
  });

  it('rejects ignored, sensitive, binary, invalid UTF-8 and oversized sources without returning altered text', async () => {
    const { root } = await retrievalProject();
    await writeFile(path.join(root, '.gitignore'), 'ignored.txt\n');
    await writeFile(path.join(root, 'ignored.txt'), 'ignored source');
    await expect(
      retrieveWindow(root, root, {
        type: 'read',
        file: 'ignored.txt',
        contentHash: hash('ignored source'),
      }),
    ).rejects.toMatchObject({ code: 'file_not_covered' });
    await expect(
      retrieveWindow(root, root, {
        type: 'read',
        file: '.env',
        contentHash: hash('x'),
      }),
    ).rejects.toMatchObject({ code: 'invalid_path' });
    for (const [file, content] of [
      ['binary.dat', Buffer.from([0, 1, 2])],
      ['invalid.txt', Buffer.from([255])],
      ['oversized.txt', Buffer.alloc(1024 * 1024 + 1, 65)],
    ] as const) {
      await writeFile(path.join(root, file), content);
      await expect(
        retrieveWindow(root, root, {
          type: 'read',
          file,
          contentHash: hash(content),
        }),
      ).rejects.toMatchObject({
        code:
          file === 'oversized.txt' ? 'file_not_covered' : 'file_unavailable',
      });
    }
    const secret = `export const key = 'sk-ant-${'x'.repeat(40)}';`;
    await writeFile(path.join(root, 'config.ts'), secret);
    await expect(
      retrieveWindow(root, root, {
        type: 'read',
        file: 'config.ts',
        contentHash: hash(secret),
      }),
    ).rejects.toMatchObject({ code: 'sensitive_content' });
  });

  it.skipIf(process.platform === 'win32')(
    'refuses leaf and ancestor symlinks and path escapes',
    async () => {
      const { root } = await retrievalProject();
      const outside = await retrievalProject();
      await writeFile(path.join(outside.root, 'source.txt'), 'OUTSIDE');
      await symlink(
        path.join(outside.root, 'source.txt'),
        path.join(root, 'link'),
      );
      await expect(
        retrieveWindow(root, root, {
          type: 'read',
          file: 'link',
          contentHash: hash('OUTSIDE'),
        }),
      ).rejects.toMatchObject({ code: 'file_not_covered' });
      await mkdir(path.join(root, 'nested'));
      await writeFile(path.join(root, 'nested/source.txt'), 'inside');
      await execute('git', ['add', 'nested/source.txt'], { cwd: root });
      await rm(path.join(root, 'nested'), { recursive: true });
      await symlink(outside.root, path.join(root, 'nested'));
      await expect(
        retrieveWindow(root, root, {
          type: 'read',
          file: 'nested/source.txt',
          contentHash: hash('OUTSIDE'),
        }),
      ).rejects.toMatchObject({ code: 'file_not_covered' });
      for (const file of [
        '../outside',
        '/absolute',
        'C:\\outside',
        '.git/config',
        '.relay/state.json',
      ])
        await expect(
          retrieveWindow(root, root, {
            type: 'read',
            file,
            contentHash: hash('x'),
          }),
        ).rejects.toMatchObject({ code: 'invalid_path' });
    },
  );
});
