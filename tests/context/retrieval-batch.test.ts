import { createHash } from 'node:crypto';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  retrieveBatch,
  retrieveBatchFile,
  retrieveWindow,
} from '../../src/context/retrieval.js';
import { inspectCoveredSnapshot } from '../../src/context/snapshot.js';
import { retrievalProject } from './retrieval-helpers.js';

const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');
describe('bounded batch retrieval', () => {
  it.each(['json', 'text'] as const)(
    'retains every query status and continues other results after a missing source (%s)',
    async (format) => {
      const { root, record } = await retrievalProject();
      const event = await record('Exact evidence 😀', {
        kind: 'tool_result',
        filePath: 'README.md',
      });
      const request = {
        schemaVersion: 1,
        queries: [
          { id: 'missing', type: 'evidence', eventId: `e-${'0'.repeat(32)}` },
          { id: 'evidence', type: 'evidence', eventId: event.id },
          {
            id: 'file',
            type: 'read',
            file: 'README.md',
            contentHash: hash('# Test\n'),
          },
          { id: 'find', type: 'find', file: 'README.md' },
        ],
      };
      const before = await readFile(
        path.join(root, '.relay/state.json'),
        'utf8',
      );
      const result = await retrieveBatch(root, root, request, { format });
      expect(result.output.length).toBeLessThanOrEqual(12000);
      expect(result.envelope.budget.usedCharacters).toBe(result.output.length);
      expect(result.envelope.results!.map((item) => item.id)).toEqual([
        'missing',
        'evidence',
        'file',
        'find',
      ]);
      expect(result.envelope.results![0]).toMatchObject({
        status: 'error',
        error: { code: 'source_not_found' },
      });
      expect(result.envelope.results![1]).toMatchObject({
        status: 'ok',
        result: { kind: 'evidence-window', text: event.text },
      });
      expect(result.envelope.results![2]).toMatchObject({
        status: 'ok',
        result: { kind: 'file-window', text: '# Test\n' },
      });
      expect(result.envelope.results![3]!.result!.matches![0]!.id).toBe(
        event.id,
      );
      expect(result.envelope.nextCursor).toBeNull();
      expect(await readFile(path.join(root, '.relay/state.json'), 'utf8')).toBe(
        before,
      );
      if (format === 'json')
        expect(JSON.parse(result.output)).toEqual(result.envelope);
    },
  );

  it('rotates deferred queries and reconstructs eight Unicode sources without skipped or duplicated segments', async () => {
    const { root, record } = await retrievalProject();
    const expected: string[] = [];
    const ids: string[] = [];
    for (let index = 0; index < 8; index++) {
      const text = `${index} 😀 "text"\n`.repeat(12);
      expected.push(text);
      ids.push((await record(text)).id);
    }
    const request = {
      schemaVersion: 1,
      queries: ids.map((eventId, index) => ({
        id: `q${index}`,
        type: 'evidence',
        eventId,
        length: 8000,
      })),
    };
    const collected = Array.from({ length: 8 }, () => '');
    let cursor: string | undefined;
    let pages = 0;
    let deferred = false;
    do {
      const result = await retrieveBatch(root, root, request, {
        cursor,
        maxCharacters: 2400,
      });
      expect(result.output.length).toBeLessThanOrEqual(2400);
      expect(result.envelope.results).toHaveLength(8);
      if (pages === 1)
        expect(
          (
            await retrieveBatch(root, root, request, {
              cursor,
              maxCharacters: 2400,
            })
          ).output,
        ).toBe(result.output);
      for (const [index, item] of result.envelope.results!.entries()) {
        deferred ||= item.status === 'deferred';
        if (item.status !== 'ok') continue;
        expect(item.result!.returned.start).toBe(collected[index]!.length);
        collected[index] += item.result!.text;
      }
      cursor = result.envelope.nextCursor ?? undefined;
      expect(++pages).toBeLessThan(60);
    } while (cursor);
    expect(collected).toEqual(expected);
    expect(deferred).toBe(true);
    expect(pages).toBeGreaterThan(1);
  });

  it('lets an individual continuation resume a batch item with the same semantic query', async () => {
    const { root, record } = await retrievalProject();
    const text = 'content '.repeat(2000);
    const event = await record(text);
    const query = {
      id: 'selected',
      type: 'evidence',
      eventId: event.id,
      length: 8000,
    };
    const batch = await retrieveBatch(
      root,
      root,
      { schemaVersion: 1, queries: [query] },
      { maxCharacters: 2400 },
    );
    const first = batch.envelope.results![0]!.result!;
    expect(first.nextCursor).not.toBeNull();
    const next = await retrieveWindow(
      root,
      root,
      { type: 'evidence', eventId: event.id, length: 8000 },
      { cursor: first.nextCursor!, maxCharacters: 8000, format: 'text' },
    );
    expect(next.envelope.result!.returned.start).toBe(first.returned.end);
    expect(next.envelope.result!.text).toBe(
      text.slice(
        next.envelope.result!.returned.start,
        next.envelope.result!.returned.end,
      ),
    );
  });

  it('invalidates aggregate continuations when any query, source, or query label changes', async () => {
    const { root, record } = await retrievalProject();
    const event = await record('a'.repeat(12000));
    const request = {
      schemaVersion: 1,
      queries: [
        {
          id: 'file',
          type: 'read',
          file: 'README.md',
          contentHash: hash('# Test\n'),
        },
        { id: 'text', type: 'evidence', eventId: event.id, length: 8000 },
      ],
    };
    const result = await retrieveBatch(root, root, request, {
      maxCharacters: 2400,
    });
    const cursor = result.envelope.nextCursor!;
    expect(cursor).not.toBeNull();
    await expect(
      retrieveBatch(
        root,
        root,
        { ...request, queries: [...request.queries].reverse() },
        { cursor },
      ),
    ).rejects.toMatchObject({ code: 'stale_cursor' });
    await expect(
      retrieveBatch(
        root,
        root,
        {
          ...request,
          queries: request.queries.map((query) => ({
            ...query,
            id: `changed-${query.id}`,
          })),
        },
        { cursor },
      ),
    ).rejects.toMatchObject({ code: 'stale_cursor' });
    await writeFile(path.join(root, 'README.md'), '# Changed\n');
    await expect(
      retrieveBatch(root, root, request, { cursor }),
    ).rejects.toMatchObject({ code: 'stale_cursor' });
    const fresh = await retrieveBatch(root, root, request);
    expect(fresh.envelope.results![0]).toMatchObject({
      status: 'error',
      error: { code: 'stale_content' },
    });
    expect(fresh.envelope.results![1]!.status).toBe('ok');
  });

  it('uses an external snapshot flag for a covered request file and preserves state/index bytes', async () => {
    const { root } = await retrievalProject();
    const request = {
      schemaVersion: 1,
      queries: [
        { type: 'read', file: 'README.md', startLine: 1, lineCount: 1 },
      ],
    };
    await writeFile(path.join(root, 'queries.json'), JSON.stringify(request));
    const snapshot = await inspectCoveredSnapshot(root);
    const before = await readFile(path.join(root, '.git/index'));
    const result = await retrieveBatchFile(root, root, 'queries.json', {
      snapshot: snapshot.identity.id,
    });
    expect(result.envelope.results![0]).toMatchObject({
      status: 'ok',
      result: { source: { snapshot: snapshot.identity.id }, text: '# Test\n' },
    });
    expect(await readFile(path.join(root, '.git/index'))).toEqual(before);
    await writeFile(
      path.join(root, 'queries.json'),
      JSON.stringify(request) + '\n',
    );
    const stale = await retrieveBatchFile(root, root, 'queries.json', {
      snapshot: snapshot.identity.id,
    });
    expect(stale.envelope.results![0]).toMatchObject({
      status: 'error',
      error: { code: 'stale_snapshot' },
    });
  });

  it('validates batch size, IDs, schema and request-file bounds before returning any result', async () => {
    const { root } = await retrievalProject();
    const query = { type: 'find' };
    for (const request of [
      { schemaVersion: 1, queries: [] },
      { schemaVersion: 1, queries: Array.from({ length: 9 }, () => query) },
      {
        schemaVersion: 1,
        queries: [
          { ...query, id: 'same' },
          { ...query, id: 'same' },
        ],
      },
      { schemaVersion: 1, queries: [query], launch: true },
    ])
      await expect(retrieveBatch(root, root, request)).rejects.toMatchObject({
        code: 'invalid_batch',
      });
    await writeFile(path.join(root, 'too-large.json'), ' '.repeat(32769));
    await expect(
      retrieveBatchFile(root, root, 'too-large.json'),
    ).rejects.toMatchObject({ code: 'request_unavailable' });
    await writeFile(path.join(root, 'invalid.json'), '{invalid');
    await expect(
      retrieveBatchFile(root, root, 'invalid.json'),
    ).rejects.toMatchObject({ code: 'invalid_batch' });
    await expect(
      retrieveBatchFile(root, root, '../outside.json'),
    ).rejects.toMatchObject({ code: 'invalid_path' });
    await expect(
      retrieveBatch(
        root,
        root,
        { schemaVersion: 1, queries: [query] },
        { maxCharacters: 12001 },
      ),
    ).rejects.toMatchObject({ code: 'invalid_budget' });
  });

  it.skipIf(process.platform === 'win32')(
    'refuses symlink request files and symlink ancestors',
    async () => {
      const { root } = await retrievalProject();
      const outside = await retrievalProject();
      await writeFile(
        path.join(outside.root, 'queries.json'),
        JSON.stringify({ schemaVersion: 1, queries: [{ type: 'find' }] }),
      );
      await symlink(
        path.join(outside.root, 'queries.json'),
        path.join(root, 'link.json'),
      );
      await symlink(outside.root, path.join(root, 'linked-directory'));
      await expect(
        retrieveBatchFile(root, root, 'link.json'),
      ).rejects.toMatchObject({ code: 'request_unavailable' });
      await expect(
        retrieveBatchFile(root, root, 'linked-directory/queries.json'),
      ).rejects.toMatchObject({ code: 'request_unavailable' });
    },
  );

  it('allows ignored regular request transport while keeping errors explicit in an all-failed batch', async () => {
    const { root } = await retrievalProject();
    await mkdir(path.join(root, 'requests'));
    await writeFile(path.join(root, '.gitignore'), 'requests/\n');
    await writeFile(
      path.join(root, 'requests/query.json'),
      JSON.stringify({
        schemaVersion: 1,
        queries: [
          { type: 'evidence', eventId: `e-${'0'.repeat(32)}` },
          { type: 'read', file: 'README.md' },
        ],
      }),
    );
    const result = await retrieveBatchFile(root, root, 'requests/query.json');
    expect(result.envelope.results!.map((item) => item.status)).toEqual([
      'error',
      'error',
    ]);
    expect(result.envelope.results![1]!.error!.code).toBe('anchor_required');
    expect(result.envelope.nextCursor).toBeNull();
  });
});
