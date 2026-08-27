import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createRepository, removeRepository } from '../helpers.js';

const execFileAsync = promisify(execFile);
const entrypoint = fileURLToPath(
  new URL('../../src/index.ts', import.meta.url),
);
const tsxLoader = new URL(
  '../../node_modules/tsx/dist/loader.mjs',
  import.meta.url,
).href;
const directories: Array<{ path: string; repository?: boolean }> = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((entry) =>
        entry.repository
          ? removeRepository(entry.path)
          : rm(entry.path, { recursive: true, force: true }),
      ),
  );
});

async function relay(
  cwd: string,
  home: string,
  codexHome: string,
  ...args: string[]
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(
    process.execPath,
    ['--import', tsxLoader, entrypoint, ...args],
    {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, HOME: home, CODEX_HOME: codexHome },
    },
  );
}

describe('relay usage', () => {
  it('prints provider plan rows and preserves the JSON summary fields', async () => {
    const root = await createRepository();
    directories.push({ path: root, repository: true });
    const home = await mkdtemp(path.join(tmpdir(), 'relay-usage-home-'));
    const codexHome = await mkdtemp(path.join(tmpdir(), 'relay-usage-codex-'));
    directories.push({ path: home }, { path: codexHome });
    await relay(root, home, codexHome, 'init');
    await relay(root, home, codexHome, 'start', 'Inspect usage');

    const usageDirectory = path.join(home, '.relay', 'provider-usage');
    await mkdir(usageDirectory, { recursive: true });
    await writeFile(
      path.join(usageDirectory, 'claude.json'),
      JSON.stringify({
        provider: 'claude',
        capturedAt: new Date().toISOString(),
        fiveHour: { usedPercentage: 25 },
        week: { usedPercentage: 60 },
      }),
    );

    const human = await relay(root, home, codexHome, 'usage');
    expect(human.stdout).toContain('Agent        Runs');
    expect(human.stdout).toContain('Provider plan usage');
    expect(human.stdout).toContain('Claude');
    expect(human.stdout).toContain('25% used');

    const json = await relay(root, home, codexHome, 'usage', '--json');
    expect(JSON.parse(json.stdout)).toMatchObject({
      schemaVersion: 2,
      task: { title: 'Inspect usage', status: 'active' },
      checkpoints: 0,
      fiveHours: { runs: 0, totalMs: 0 },
      week: { runs: 0, totalMs: 0 },
      agents: expect.any(Array),
      plans: expect.arrayContaining([
        expect.objectContaining({
          id: 'claude',
          status: 'available',
          fiveHour: expect.objectContaining({ usedPercentage: 25 }),
        }),
      ]),
    });
  });

  it('reads global provider plans without a repository or Relay task', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'relay-usage-cwd-'));
    const home = await mkdtemp(path.join(tmpdir(), 'relay-usage-home-'));
    const codexHome = await mkdtemp(path.join(tmpdir(), 'relay-usage-codex-'));
    directories.push({ path: cwd }, { path: home }, { path: codexHome });
    const usageDirectory = path.join(home, '.relay', 'provider-usage');
    await mkdir(usageDirectory, { recursive: true });
    await writeFile(
      path.join(usageDirectory, 'claude.json'),
      JSON.stringify({
        provider: 'claude',
        capturedAt: new Date().toISOString(),
        fiveHour: { usedPercentage: 12 },
      }),
    );
    const result = await relay(
      cwd,
      home,
      codexHome,
      'usage',
      '--plans-only',
      '--json',
    );
    expect(JSON.parse(result.stdout)).toMatchObject({
      task: { title: 'Provider plans' },
      plans: expect.arrayContaining([
        expect.objectContaining({
          id: 'claude',
          fiveHour: expect.objectContaining({ usedPercentage: 12 }),
        }),
      ]),
    });
  });
});
