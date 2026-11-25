import { execFile } from 'node:child_process';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  E1_CASES,
  E1_MODE,
  installReadOnlyHelper,
  validateE1Protocol,
} from '../../benchmarks/continuity/e1.mjs';

const execute = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function protocol() {
  return {
    mode: E1_MODE,
    sessionLimit: 8,
    timeoutMs: 180000,
    automaticReruns: 0,
    newPredecessors: 0,
    candidateProfile: 'control; no M5 output/layout treatment',
    cases: structuredClone(E1_CASES),
    models: {
      codex: { model: 'gpt-5.6-sol', effort: 'low' },
      claude: { model: 'sonnet', effort: 'low' },
    },
  };
}

describe('E1 experiment boundaries', () => {
  it('rejects expanded budgets, longer sessions, retries, predecessors, and extra policy treatments', () => {
    expect(() => validateE1Protocol(protocol())).not.toThrow();
    for (const change of [
      { sessionLimit: 9 },
      { timeoutMs: 180001 },
      { automaticReruns: 1 },
      { newPredecessors: 1 },
      { candidateProfile: 'stable-focused' },
    ])
      expect(() => validateE1Protocol({ ...protocol(), ...change })).toThrow();
    const changedOrder = protocol();
    changedOrder.cases[0]!.arms.reverse();
    expect(() => validateE1Protocol(changedOrder)).toThrow();
    const changedModel = protocol();
    changedModel.models.codex.model = 'different-model';
    expect(() => validateE1Protocol(changedModel)).toThrow();
  });

  it.skipIf(process.platform === 'win32')(
    'blocks mutation/launch commands and routes read-only queries through the selected build',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'rirei-e1-helper-'));
      roots.push(root);
      await mkdir(path.join(root, '.benchmark-tools'));
      const marker = path.join(root, 'called.json');
      const cli = path.join(root, 'selected cli.cjs');
      await writeFile(
        cli,
        `require('node:fs').writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() })); process.stdout.write('selected-build');\n`,
      );
      const [helper] = await installReadOnlyHelper(
        root,
        cli,
        path.join(root, 'unused dependencies'),
      );
      for (const args of [
        ['run'],
        ['switch'],
        ['context', 'enable'],
        ['context', 'clear'],
        ['context', 'ingest'],
        ['message', 'send'],
      ]) {
        await expect(
          execute(helper!, args, { cwd: root }),
        ).rejects.toMatchObject({ code: 2 });
        await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
      }
      const result = await execute(
        helper!,
        ['context', 'task', '--limit', '20'],
        { cwd: path.join(root, '.benchmark-tools') },
      );
      expect(result.stdout).toBe('selected-build');
      expect(JSON.parse(await readFile(marker, 'utf8'))).toEqual({
        args: ['context', 'task', '--limit', '20'],
        cwd: await realpath(root),
      });
    },
  );
});
