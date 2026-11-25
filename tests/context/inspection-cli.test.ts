import { execFile } from 'node:child_process';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  initializeProject,
  startTask,
} from '../../src/application/project-setup.js';
import { setContextConsent } from '../../src/context/store.js';
import { issueMessageCapability } from '../../src/messages/capability.js';
import { updateState } from '../../src/state/store.js';
import { createRepository, removeRepository } from '../helpers.js';

const execute = promisify(execFile);
const roots: string[] = [];
const source = fileURLToPath(new URL('../../src/index.ts', import.meta.url));
const bundle = fileURLToPath(new URL('../../dist/index.cjs', import.meta.url));
const loader = new URL(
  '../../node_modules/tsx/dist/loader.mjs',
  import.meta.url,
).href;
afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeRepository));
});
async function project(mode: 'source' | 'compiled' = 'source') {
  const root = await realpath(await createRepository());
  roots.push(root);
  await initializeProject(root);
  const state = await startTask(
    root,
    'Inspect the current workspace without changing it',
  );
  const env = { ...process.env };
  const relay = (...args: string[]) =>
    execute(
      process.execPath,
      mode === 'source'
        ? ['--import', loader, source, ...args]
        : [bundle, ...args],
      { cwd: root, env },
    );
  return { root, state, env, relay };
}

describe('inspection CLI', () => {
  it.each(['source', 'compiled'] as const)(
    'bounds the complete response and refuses stale snapshots without mutating state (%s)',
    async (mode) => {
      const context = await project(mode);
      await writeFile(
        path.join(context.root, 'new 日本語.mjs'),
        'export const value = 3;\n',
      );
      const before = await readFile(
        path.join(context.root, '.relay/state.json'),
        'utf8',
      );
      const first = await context.relay(
        'context',
        'inspect',
        '--format',
        'json',
        '--max-characters',
        '2400',
      );
      const packet = JSON.parse(first.stdout);
      expect(first.stderr).toBe('');
      expect(first.stdout.length).toBeLessThanOrEqual(2400);
      expect(packet.budget.usedCharacters).toBe(first.stdout.length);
      expect(packet.workspace).toBe(context.root);
      expect(packet.items).toContainEqual(
        expect.objectContaining({
          kind: 'diff',
          path: 'new 日本語.mjs',
          text: expect.stringContaining('export const value = 3;'),
        }),
      );
      const text = await context.relay(
        'context',
        'inspect',
        '--snapshot',
        packet.snapshot.id,
        '--file',
        'new 日本語.mjs',
      );
      expect(text.stdout).toContain('Current-state'.toUpperCase());
      expect(text.stdout).toContain('export const value = 3;');
      expect(text.stdout.length).toBeLessThanOrEqual(6000);
      const metadata = JSON.parse(
        (
          await context.relay(
            'context',
            'inspect',
            '--format',
            'json',
            '--no-code',
          )
        ).stdout,
      );
      expect(
        metadata.items.some((item: { kind: string }) => item.kind === 'diff'),
      ).toBe(false);
      expect(metadata.gaps).toContain('code-on-demand');
      await writeFile(
        path.join(context.root, 'new 日本語.mjs'),
        'export const value = 4;\n',
      );
      await expect(
        context.relay('context', 'inspect', '--snapshot', packet.snapshot.id),
      ).rejects.toThrow('snapshot is stale');
      expect(
        await readFile(path.join(context.root, '.relay/state.json'), 'utf8'),
      ).toBe(before);
      await expect(
        context.relay('context', 'inspect', '--format', 'xml'),
      ).rejects.toThrow('format must be');
      await expect(
        context.relay('context', 'inspect', '--max-characters', '12001'),
      ).rejects.toThrow('budget');
      await expect(
        context.relay('context', 'inspect', '--file', '../outside'),
      ).rejects.toThrow('workspace-relative');
    },
  );

  it('uses the managed workspace and disclosure consent, including cross-workspace snapshot refusal', async () => {
    const context = await project();
    const main = JSON.parse(
      (await context.relay('context', 'inspect', '--format', 'json')).stdout,
    );
    const worktree = path.join(context.root, '.relay/inspection-worktree');
    await execute('git', ['worktree', 'add', '--detach', worktree, 'HEAD'], {
      cwd: context.root,
    });
    const now = new Date().toISOString();
    const runId = 'inspection-reader';
    await updateState(context.root, (current) => ({
      ...current,
      runs: [
        {
          runId,
          displayLabel: 'Codex inspection reader',
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
    const capability = await issueMessageCapability(
      context.root,
      context.state.sessionId,
      runId,
    );
    Object.assign(context.env, capability.env);
    await expect(context.relay('context', 'inspect')).rejects.toThrow(
      'Context disclosure is disabled',
    );
    await setContextConsent(context.root, context.state.sessionId, true);
    await writeFile(
      path.join(worktree, 'local.mjs'),
      'export const local = true;\n',
    );
    const packet = JSON.parse(
      (await context.relay('context', 'inspect', '--format', 'json')).stdout,
    );
    expect(packet.workspace).toBe(await realpath(worktree));
    expect(packet.items).toContainEqual(
      expect.objectContaining({ path: 'local.mjs', worktree: 'untracked' }),
    );
    await expect(
      context.relay('context', 'inspect', '--snapshot', main.snapshot.id),
    ).rejects.toThrow('stale');
    await setContextConsent(context.root, context.state.sessionId, false);
    await expect(context.relay('context', 'inspect')).rejects.toThrow(
      'Context disclosure is disabled',
    );
  });

  it('supports closed-task operator inspection without creating captured context', async () => {
    const context = await project();
    await updateState(context.root, (current) => ({
      ...current,
      task: { ...current.task, status: 'completed' },
    }));
    const packet = JSON.parse(
      (await context.relay('context', 'inspect', '--format', 'json')).stdout,
    );
    expect(packet.requirements.capture).toBe('disabled');
    expect(packet.changes).toEqual({ observed: 0, complete: true });
    expect(
      packet.items.filter((item: { kind: string }) => item.kind === 'action'),
    ).toEqual([]);
    await expect(
      readFile(path.join(context.root, '.relay/context/policy.json')),
    ).rejects.toHaveProperty('code', 'ENOENT');
  });
});
