import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { inspectCoveredSnapshot } from '../../src/context/snapshot.js';
import { setContextConsent } from '../../src/context/store.js';
import { issueMessageCapability } from '../../src/messages/capability.js';
import { updateState } from '../../src/state/store.js';
import { retrievalProject } from './retrieval-helpers.js';

const execute = promisify(execFile);
const source = fileURLToPath(new URL('../../src/index.ts', import.meta.url));
const compiled = fileURLToPath(
  new URL('../../dist/index.cjs', import.meta.url),
);
const loader = new URL(
  '../../node_modules/tsx/dist/loader.mjs',
  import.meta.url,
).href;
async function project(mode: 'source' | 'compiled' = 'source') {
  const context = await retrievalProject();
  const env = { ...process.env };
  const relay = (...args: string[]) =>
    execute(
      process.execPath,
      mode === 'source'
        ? ['--import', loader, source, ...args]
        : [compiled, ...args],
      { cwd: context.root, env },
    );
  return { ...context, env, relay };
}

describe('targeted retrieval CLI', () => {
  it.each(['source', 'compiled'] as const)(
    'preserves full evidence lookup and exposes bounded find/window/read/batch commands (%s)',
    async (mode) => {
      const context = await project(mode);
      const event = await context.record('retained 😀 text '.repeat(100), {
        kind: 'tool_result',
        filePath: 'README.md',
        command: 'npm test',
        toolId: 'fixture-test',
      });
      const before = await readFile(
        path.join(context.root, '.relay/state.json'),
        'utf8',
      );
      const full = JSON.parse(
        (await context.relay('context', 'evidence', event.id)).stdout,
      );
      expect(full.event).toEqual(event);
      expect(full.historicalEvidence).toBe(true);
      expect(
        JSON.parse(
          (await context.relay('context', 'evidence', event.id, '--full'))
            .stdout,
        ),
      ).toEqual(full);
      const first = await context.relay(
        'context',
        'evidence',
        event.id,
        '--start',
        '0',
        '--length',
        '50',
      );
      const window = JSON.parse(first.stdout);
      expect(first.stdout.length).toBeLessThanOrEqual(2000);
      expect(window.result.kind).toBe('evidence-window');
      expect(window.result.text).toBe(event.text.slice(0, 50));
      const next = JSON.parse(
        (
          await context.relay(
            'context',
            'evidence',
            event.id,
            '--start',
            '0',
            '--length',
            '50',
            '--cursor',
            window.result.nextCursor,
          )
        ).stdout,
      );
      expect(next.result.returned.start).toBe(window.result.returned.end);
      const found = JSON.parse(
        (
          await context.relay(
            'context',
            'find',
            '--file',
            'README.md',
            '--kind',
            'tool_result',
            '--format',
            'json',
          )
        ).stdout,
      );
      expect(
        found.result.matches.map((item: { id: string }) => item.id),
      ).toEqual([event.id]);
      expect(
        (
          await context.relay(
            'context',
            'find',
            '--command-id',
            found.result.matches[0].commandId,
          )
        ).stdout,
      ).toContain(event.id);
      const contentHash = createHash('sha256').update('# Test\n').digest('hex');
      const file = JSON.parse(
        (
          await context.relay(
            'context',
            'read',
            '--file',
            'README.md',
            '--content-hash',
            contentHash,
            '--format',
            'json',
          )
        ).stdout,
      );
      expect(file.result).toMatchObject({
        kind: 'file-window',
        text: '# Test\n',
      });
      await writeFile(
        path.join(context.root, 'queries.json'),
        JSON.stringify({
          schemaVersion: 1,
          queries: [
            { id: 'event', type: 'evidence', eventId: event.id, length: 50 },
            { id: 'file', type: 'read', file: 'README.md', lineCount: 1 },
          ],
        }),
      );
      const snapshot = await inspectCoveredSnapshot(context.root);
      const batch = JSON.parse(
        (
          await context.relay(
            'context',
            'batch',
            '--request-file',
            'queries.json',
            '--snapshot',
            snapshot.identity.id,
          )
        ).stdout,
      );
      expect(
        batch.results.map((item: { status: string }) => item.status),
      ).toEqual(['ok', 'ok']);
      expect(batch.results[1].result.source.snapshot).toBe(
        snapshot.identity.id,
      );
      expect(
        await readFile(path.join(context.root, '.relay/state.json'), 'utf8'),
      ).toBe(before);
      await expect(
        context.relay(
          'context',
          'evidence',
          event.id,
          '--full',
          '--length',
          '20',
        ),
      ).rejects.toThrow('Use --full alone');
      await expect(
        context.relay('context', 'read', '--file', 'README.md'),
      ).rejects.toThrow('require --snapshot or --content-hash');
      await expect(
        context.relay('context', 'find', '--max-characters', '8001'),
      ).rejects.toThrow('budget');
    },
  );

  it('validates managed disclosure consent and binds file cursors to the assigned worktree', async () => {
    const context = await project();
    const event = await context.record('Task-scoped evidence');
    const worktree = path.join(context.root, '.relay/reader-worktree');
    await execute('git', ['worktree', 'add', '--detach', worktree, 'HEAD'], {
      cwd: context.root,
    });
    const file = 'x'.repeat(4000);
    await writeFile(path.join(context.root, 'same.txt'), file);
    await writeFile(path.join(worktree, 'same.txt'), file);
    const contentHash = createHash('sha256').update(file).digest('hex');
    const initial = JSON.parse(
      (
        await context.relay(
          'context',
          'read',
          '--file',
          'same.txt',
          '--content-hash',
          contentHash,
          '--format',
          'json',
        )
      ).stdout,
    );
    const now = new Date().toISOString();
    const runId = 'bounded-reader';
    await updateState(context.root, (current) => ({
      ...current,
      runs: [
        {
          runId,
          displayLabel: 'Reader',
          agent: 'codex',
          worktreePath: worktree,
          projectRoot: context.root,
          launchMode: 'new',
          controllerId: 'cli:fixture',
          controller: { kind: 'cli', instanceId: 'fixture', bootId: 'fixture' },
          startedAt: now,
          lastSeenAt: now,
          status: 'running',
          lifecycleStatus: 'working',
          activeRuntimeSeconds: 0,
          runtimeSequence: 0,
        },
      ],
    }));
    Object.assign(
      context.env,
      (
        await issueMessageCapability(
          context.root,
          context.state.sessionId,
          runId,
        )
      ).env,
    );
    await expect(
      context.relay(
        'context',
        'read',
        '--file',
        'same.txt',
        '--content-hash',
        contentHash,
        '--cursor',
        initial.result.nextCursor,
      ),
    ).rejects.toThrow('cursor is invalid or stale');
    await expect(
      context.relay('context', 'evidence', event.id, '--length', '50'),
    ).rejects.toThrow('not found in the current task and workspace');
    const current = JSON.parse(
      (await context.relay('context', 'find', '--format', 'json')).stdout,
    );
    expect(current.result.matches).toEqual([]);
    await setContextConsent(context.root, context.state.sessionId, false);
    await expect(context.relay('context', 'find')).rejects.toThrow(
      'disclosure is disabled',
    );
    await expect(
      context.relay(
        'context',
        'read',
        '--file',
        'same.txt',
        '--content-hash',
        contentHash,
      ),
    ).rejects.toThrow('disclosure is disabled');
  });
});
