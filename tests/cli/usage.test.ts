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
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        CODEX_HOME: codexHome,
        RIREI_DATA_HOME: path.join(home, 'data'),
      },
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

  it('manages token usage opt-in state via CLI flags', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'relay-tokens-cwd-'));
    const home = await mkdtemp(path.join(tmpdir(), 'relay-tokens-home-'));
    const codexHome = await mkdtemp(path.join(tmpdir(), 'relay-tokens-codex-'));
    directories.push({ path: cwd }, { path: home }, { path: codexHome });

    const optIn = await relay(
      cwd,
      home,
      codexHome,
      'usage',
      'tokens',
      '--opt-in',
    );
    expect(optIn.stdout).toContain('Token usage analytics enabled.');

    const optOut = await relay(
      cwd,
      home,
      codexHome,
      'usage',
      'tokens',
      '--opt-out',
    );
    expect(optOut.stdout).toContain('Token usage analytics disabled.');
  });

  it('supports relay usage tokens --json and returns valid report schema', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'relay-tokens-cwd-'));
    const home = await mkdtemp(path.join(tmpdir(), 'relay-tokens-home-'));
    const codexHome = await mkdtemp(path.join(tmpdir(), 'relay-tokens-codex-'));
    directories.push({ path: cwd }, { path: home }, { path: codexHome });

    // Enable opt-in first
    await relay(cwd, home, codexHome, 'usage', 'tokens', '--opt-in');

    const result = await relay(
      cwd,
      home,
      codexHome,
      'usage',
      'tokens',
      '--json',
      '--days',
      '7',
    );
    const parsed = JSON.parse(result.stdout) as {
      schemaVersion: number;
      range: { days: number };
      source: { kind: string; version: string };
      agents: Array<{ id: string; status: string }>;
    };

    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.range.days).toBe(7);
    expect(parsed.source.kind).toBe('ccusage');
    expect(parsed.source.version).toBe('20.0.24');
    expect(parsed.agents).toHaveLength(5);
  });

  it('prints stderr notice when scanning tokens without opt-in', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'relay-tokens-notice-cwd-'));
    const home = await mkdtemp(
      path.join(tmpdir(), 'relay-tokens-notice-home-'),
    );
    const codexHome = await mkdtemp(
      path.join(tmpdir(), 'relay-tokens-notice-codex-'),
    );
    directories.push({ path: cwd }, { path: home }, { path: codexHome });

    const result = await relay(
      cwd,
      home,
      codexHome,
      'usage',
      'tokens',
      '--json',
    );
    expect(result.stderr).toContain(
      'Notice: Token usage analytics reads local coding-agent logs.',
    );
  });

  it('runs --plans-only without invoking ccusage or touching token cache', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'relay-plans-only-cwd-'));
    const home = await mkdtemp(path.join(tmpdir(), 'relay-plans-only-home-'));
    const codexHome = await mkdtemp(
      path.join(tmpdir(), 'relay-plans-only-codex-'),
    );
    directories.push({ path: cwd }, { path: home }, { path: codexHome });

    const result = await relay(
      cwd,
      home,
      codexHome,
      'usage',
      '--plans-only',
      '--json',
    );
    const parsed = JSON.parse(result.stdout);
    expect(parsed).toMatchObject({
      task: { title: 'Provider plans' },
    });
    // Never attached ccusage token report
    expect(parsed).not.toHaveProperty('source');
    expect(result.stderr).not.toContain('Notice: Token usage analytics');
  });
});
