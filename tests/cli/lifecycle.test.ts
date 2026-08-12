import { execFile, spawn } from 'node:child_process';
import { access, chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { activityFilePath } from '../../src/state/activity.js';
import { createRepository, removeRepository } from '../helpers.js';

const execFileAsync = promisify(execFile);
const directories: string[] = [];
const entrypoint = fileURLToPath(
  new URL('../../src/index.ts', import.meta.url),
);
const tsxLoader = fileURLToPath(
  new URL('../../node_modules/tsx/dist/loader.mjs', import.meta.url),
);

async function relay(
  cwd: string,
  ...args: string[]
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(
    process.execPath,
    ['--import', tsxLoader, entrypoint, ...args],
    {
      cwd,
      encoding: 'utf8',
    },
  );
}

async function relayWithEnv(
  cwd: string,
  env: NodeJS.ProcessEnv,
  ...args: string[]
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(
    process.execPath,
    ['--import', tsxLoader, entrypoint, ...args],
    {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, ...env },
    },
  );
}

async function relayWithInput(
  cwd: string,
  input: string,
  ...args: string[]
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--import', tsxLoader, entrypoint, ...args],
      { cwd, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      const result = {
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      };
      if (code === 0) resolve(result);
      else reject(new Error(result.stderr || result.stdout));
    });
    child.stdin.end(input);
  });
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(removeRepository));
});

describe('Relay lifecycle commands', () => {
  it('initializes once without overwriting existing state', async () => {
    const root = await createRepository();
    directories.push(root);
    await expect(relay(root, 'init')).resolves.toMatchObject({
      stdout: expect.stringContaining('Initialized Relay'),
    });
    await expect(access(`${root}/.relay/config.json`)).resolves.toBeUndefined();
    await expect(relay(root, 'init')).rejects.toThrow('refusing to overwrite');
  });

  it('records a task baseline and publishes the global activity snapshot', async () => {
    const root = await createRepository();
    directories.push(root);
    await relay(root, 'init');
    await relay(root, 'start', 'Implement a reliable handoff\nwith safe state');
    const state = JSON.parse(
      await readFile(`${root}/.relay/state.json`, 'utf8'),
    ) as {
      task: { title: string; originalRequest: string; status: string };
      git: { dirtyAtStart: boolean };
    };
    expect(state.task).toMatchObject({
      title: 'Implement a reliable handoff',
      originalRequest: 'Implement a reliable handoff\nwith safe state',
      status: 'active',
    });
    expect(state.git.dirtyAtStart).toBe(false);
    const activity = JSON.parse(await readFile(activityFilePath(), 'utf8')) as {
      schemaVersion: number;
      sessions: unknown[];
    };
    expect(activity).toMatchObject({ schemaVersion: 1, sessions: [] });
    expect(activity).not.toHaveProperty('events');
    const status = await relay(root, 'status', '--json');
    expect(JSON.parse(status.stdout)).toMatchObject({
      task: { title: 'Implement a reliable handoff', status: 'active' },
      git: { currentBranch: 'main', dirty: false, changedFiles: 0 },
      currentAgent: null,
      agentHistory: [],
      remainingWork: [],
      decisions: [],
      blockers: [],
    });
  });

  it('requires explicit acknowledgement of a dirty baseline', async () => {
    const root = await createRepository();
    directories.push(root);
    await relay(root, 'init');
    await writeFile(`${root}/README.md`, '# Modified\n');
    await expect(relay(root, 'start', 'Task')).rejects.toThrow('--allow-dirty');
    await expect(
      relay(root, 'start', 'Task', '--allow-dirty'),
    ).resolves.toMatchObject({
      stdout: expect.stringContaining('Warning'),
    });
  });

  it('repairs local exclusion before inspecting an older task baseline', async () => {
    const root = await createRepository();
    directories.push(root);
    await relay(root, 'init');
    const exclude = (
      await execFileAsync(
        'git',
        ['rev-parse', '--path-format=absolute', '--git-path', 'info/exclude'],
        { cwd: root, encoding: 'utf8' },
      )
    ).stdout.trim();
    const contents = await readFile(exclude, 'utf8');
    await writeFile(exclude, contents.replace('/.relay/\n', ''));

    await expect(
      relay(root, 'start', 'Repair before baseline'),
    ).resolves.toBeDefined();
    const state = JSON.parse(
      await readFile(`${root}/.relay/state.json`, 'utf8'),
    ) as { git: { dirtyAtStart: boolean } };
    expect(state.git.dirtyAtStart).toBe(false);
    await expect(readFile(exclude, 'utf8')).resolves.toContain('/.relay/');
  });

  it('creates a bounded checkpoint and a concise handoff without changing Git', async () => {
    const root = await createRepository();
    directories.push(root);
    await relay(root, 'init');
    await relay(root, 'start', 'Preserve current work');
    await writeFile(`${root}/README.md`, '# Changed\n');
    await writeFile(`${root}/untracked.txt`, 'new\n');
    const before = await execFileAsync('git', ['status', '--porcelain=v1'], {
      cwd: root,
    });
    await relay(root, 'checkpoint', '--message', 'Working');
    const state = JSON.parse(
      await readFile(`${root}/.relay/state.json`, 'utf8'),
    ) as {
      checkpoints: Array<{ path: string }>;
    };
    const checkpoint = path.join(root, '.relay', state.checkpoints[0]!.path);
    await expect(
      readFile(path.join(checkpoint, 'status.txt'), 'utf8'),
    ).resolves.toContain('untracked.txt');
    await expect(
      readFile(path.join(checkpoint, 'changes.patch'), 'utf8'),
    ).resolves.toContain('# Changed');
    const handoff = await relay(root, 'handoff');
    expect(handoff.stdout).toContain('Task: Preserve current work');
    expect(handoff.stdout).toMatch(/Git: main@[0-9a-f]{7}; dirty/);
    expect(handoff.stdout).toContain(
      'Inspect the working tree and preserve existing changes.',
    );
    expect(handoff.stdout).not.toContain('diff --git');
    const after = await execFileAsync('git', ['status', '--porcelain=v1'], {
      cwd: root,
    });
    expect(after.stdout).toBe(before.stdout);
  });

  it('records provenance-aware notes and marks them stale when Git changes', async () => {
    const root = await createRepository();
    directories.push(root);
    await relay(root, 'init');
    await relay(root, 'start', 'Finish OAuth refresh');
    const decision = JSON.parse(
      (
        await relay(
          root,
          'note',
          'decision',
          'Store refresh tokens in Keychain',
          '--reason',
          'Avoid browser storage exposure',
          '--json',
        )
      ).stdout,
    ) as { note: { id: string } };
    const rejected = JSON.parse(
      (
        await relay(
          root,
          'note',
          'rejected',
          'Use access tokens as sessions',
          '--reason',
          'They expire',
          '--source',
          'agent',
          '--agent',
          'claude',
          '--json',
        )
      ).stdout,
    ) as { note: { id: string } };
    await relay(root, 'note', 'next', 'Fix the refresh endpoint');

    const current = JSON.parse(
      (await relay(root, 'handoff', '--json')).stdout,
    ) as {
      text: string;
      capsule: { notes: Array<{ id: string; freshness: string }> };
      budget: { usedCharacters: number; estimatedTokens: number };
    };
    expect(current.text).toContain('Task: Finish OAuth refresh');
    expect(current.text).toMatch(/Git: main@[0-9a-f]{7}/);
    expect(current.text).toContain(
      'Avoid: Use access tokens as sessions — They expire',
    );
    expect(current.text).toContain('Next: Fix the refresh endpoint');
    expect(current.capsule.notes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: rejected.note.id, freshness: 'current' }),
      ]),
    );
    expect(current.budget.usedCharacters).toBeLessThanOrEqual(1_200);
    expect(current.budget.estimatedTokens).toBeLessThanOrEqual(300);

    const status = JSON.parse(
      (await relay(root, 'status', '--json')).stdout,
    ) as {
      remainingWork: Array<{ description: string }>;
      decisions: Array<{ summary: string }>;
      rejectedApproaches: Array<{ id: string }>;
    };
    expect(status.remainingWork).toContainEqual({
      description: 'Fix the refresh endpoint',
      updatedAt: expect.any(String),
    });
    expect(status.decisions).toContainEqual(
      expect.objectContaining({ summary: 'Store refresh tokens in Keychain' }),
    );
    expect(status.rejectedApproaches).toContainEqual(
      expect.objectContaining({ id: rejected.note.id }),
    );

    await writeFile(`${root}/README.md`, '# Changed after note\n');
    const changed = JSON.parse(
      (await relay(root, 'handoff', '--json')).stdout,
    ) as { capsule: { notes: Array<{ id: string; freshness: string }> } };
    expect(changed.capsule.notes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: rejected.note.id, freshness: 'changed' }),
      ]),
    );

    await relay(root, 'note', 'resolve', rejected.note.id);
    const resolved = JSON.parse(
      (await relay(root, 'handoff', '--json')).stdout,
    ) as {
      text: string;
      capsule: { notes: Array<{ id: string; resolvedAt?: string }> };
    };
    expect(resolved.capsule.notes).toContainEqual(
      expect.objectContaining({
        id: rejected.note.id,
        resolvedAt: expect.any(String),
      }),
    );
    expect(resolved.text).not.toContain('Use access tokens as sessions');

    await relay(root, 'note', 'resolve', decision.note.id);
    const afterDecisionResolution = JSON.parse(
      (await relay(root, 'status', '--json')).stdout,
    ) as { decisions: Array<{ summary: string }> };
    expect(afterDecisionResolution.decisions).toContainEqual(
      expect.objectContaining({ summary: 'Store refresh tokens in Keychain' }),
    );
  });

  it('rejects oversized or schema-expanded note imports without mutation', async () => {
    const root = await createRepository();
    directories.push(root);
    await relay(root, 'init');
    await relay(root, 'start', 'Capture notes atomically');

    await expect(
      relayWithInput(
        root,
        'x'.repeat(16 * 1024 + 1),
        'note',
        'import',
        '--stdin',
        '--source',
        'agent',
        '--agent',
        'antigravity',
      ),
    ).rejects.toThrow(/exceeds 16384 bytes/);
    await expect(
      relayWithInput(
        root,
        JSON.stringify({
          schemaVersion: 1,
          notes: [
            {
              type: 'next',
              text: 'Continue',
              provenance: { source: 'agent' },
            },
          ],
        }),
        'note',
        'import',
        '--stdin',
        '--source',
        'agent',
        '--agent',
        'antigravity',
      ),
    ).rejects.toThrow(/only accept type, text, and reason/);
    const state = JSON.parse(
      await readFile(`${root}/.relay/state.json`, 'utf8'),
    ) as { notes: unknown[] };
    expect(state.notes).toHaveLength(0);
  });

  it('keeps Unicode handoffs inside both configured budgets', async () => {
    const root = await createRepository();
    directories.push(root);
    await relay(root, 'init');
    const configPath = `${root}/.relay/config.json`;
    const config = JSON.parse(await readFile(configPath, 'utf8')) as {
      handoff: { maxCharacters: number; maxTokens: number };
    };
    config.handoff.maxCharacters = 248;
    config.handoff.maxTokens = 62;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await relay(root, 'start', `Continue safely ${'🚀'.repeat(200)}`);

    const handoff = JSON.parse(
      (await relay(root, 'handoff', '--json')).stdout,
    ) as {
      text: string;
      budget: {
        maxCharacters: number;
        usedCharacters: number;
        estimatedTokens: number;
      };
    };
    expect(handoff.budget.maxCharacters).toBe(248);
    expect(handoff.budget.usedCharacters).toBeLessThanOrEqual(248);
    expect(handoff.budget.estimatedTokens).toBeLessThanOrEqual(62);
    expect(handoff.text).not.toContain('�');
  });

  it('reuses one verified Git snapshot when switching providers', async () => {
    const root = await createRepository();
    directories.push(root);
    await relay(root, 'init');
    await relay(root, 'start', 'Switch with compact context');
    await relay(root, 'note', 'blocker', 'Refresh endpoint returns 401');
    const bin = path.join(root, 'fake-bin');
    await mkdir(bin);
    await writeFile(
      path.join(bin, 'codex'),
      '#!/bin/sh\nfor arg do last="$arg"; done\nprintf "%s" "$last" > "$RELAY_FAKE_LOG"\n',
    );
    await chmod(path.join(bin, 'codex'), 0o700);
    const log = path.join(root, 'switch-prompt.log');
    const result = await relayWithEnv(
      root,
      {
        PATH: `${bin}${path.delimiter}${process.env.PATH}`,
        RELAY_FAKE_LOG: log,
      },
      'switch',
      'codex',
      '--yes',
    );
    expect(result.stdout).toContain('Estimated handoff:');
    expect(result.stdout).toContain('Launching codex');
    await expect(readFile(log, 'utf8')).resolves.toContain(
      'Refresh endpoint returns 401',
    );
    const state = JSON.parse(
      await readFile(`${root}/.relay/state.json`, 'utf8'),
    ) as { checkpoints: Array<{ path: string }> };
    const metadata = JSON.parse(
      await readFile(
        path.join(
          root,
          '.relay',
          state.checkpoints.at(-1)!.path,
          'metadata.json',
        ),
        'utf8',
      ),
    ) as { fingerprint: string };
    expect(metadata.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it('requires explicit approval for a non-interactive switch', async () => {
    const root = await createRepository();
    directories.push(root);
    await relay(root, 'init');
    await relay(root, 'start', 'Do not launch silently');
    const bin = path.join(root, 'fake-bin');
    await mkdir(bin);
    await writeFile(
      path.join(bin, 'codex'),
      '#!/bin/sh\nprintf "launched" > "$RELAY_FAKE_LOG"\n',
    );
    await chmod(path.join(bin, 'codex'), 0o700);
    const log = path.join(root, 'unapproved-launch.log');

    await expect(
      relayWithEnv(
        root,
        {
          PATH: `${bin}${path.delimiter}${process.env.PATH}`,
          RELAY_FAKE_LOG: log,
        },
        'switch',
        'codex',
      ),
    ).rejects.toThrow(/--yes/);
    await expect(access(log)).rejects.toThrow();
  });

  it('keeps empty-context quality approval separate from launch approval', async () => {
    const root = await createRepository();
    directories.push(root);
    await relay(root, 'init');
    await relay(root, 'start', 'Require continuation context');
    const bin = path.join(root, 'fake-bin');
    await mkdir(bin);
    await writeFile(
      path.join(bin, 'codex'),
      '#!/bin/sh\nprintf "launched" > "$RELAY_FAKE_LOG"\n',
    );
    await chmod(path.join(bin, 'codex'), 0o700);
    const log = path.join(root, 'empty-context-launch.log');
    const env = {
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      RELAY_FAKE_LOG: log,
    };

    await expect(
      relayWithEnv(root, env, 'switch', 'codex', '--yes'),
    ).rejects.toThrow(/empty continuation context/);
    await expect(access(log)).rejects.toThrow();
    await expect(
      relayWithEnv(
        root,
        env,
        'switch',
        'codex',
        '--yes',
        '--allow-empty-notes',
      ),
    ).resolves.toMatchObject({
      stdout: expect.stringContaining('Launching codex'),
    });
    await expect(readFile(log, 'utf8')).resolves.toBe('launched');
  });

  it('runs a provider adapter from PATH and records its conservative result', async () => {
    const root = await createRepository();
    directories.push(root);
    await relay(root, 'init');
    await relay(root, 'start', 'Use Gemini');
    const bin = path.join(root, 'fake-bin');
    await mkdir(bin);
    const executable = path.join(bin, 'gemini');
    await writeFile(
      executable,
      '#!/bin/sh\nprintf "%s\\n" "$@" > "$RELAY_FAKE_LOG"\n',
    );
    await chmod(executable, 0o700);
    const log = path.join(root, 'args.log');
    await relayWithEnv(
      root,
      {
        PATH: `${bin}${path.delimiter}${process.env.PATH}`,
        RELAY_FAKE_LOG: log,
      },
      'run',
      'gemini',
      '--prompt',
      'Continue safely',
    );
    await expect(readFile(log, 'utf8')).resolves.toBe(
      '--prompt-interactive\nContinue safely\n',
    );
    const state = JSON.parse(
      await readFile(`${root}/.relay/state.json`, 'utf8'),
    ) as {
      currentAgent?: string;
      agentHistory: Array<{ exitReason: string; exitCode: number }>;
    };
    expect(state.currentAgent).toBeUndefined();
    expect(state.agentHistory.at(-1)).toMatchObject({
      exitReason: 'completed',
      exitCode: 0,
    });
  });

  it('exposes model and effort details in the durable session timeline', async () => {
    const root = await createRepository();
    directories.push(root);
    await relay(root, 'init');
    await relay(root, 'start', 'Track agent sessions');
    const bin = path.join(root, 'fake-bin');
    await mkdir(bin);
    const executable = path.join(bin, 'codex');
    await writeFile(executable, '#!/bin/sh\nexit 0\n');
    await chmod(executable, 0o700);
    await relayWithEnv(
      root,
      { PATH: `${bin}${path.delimiter}${process.env.PATH}` },
      'run',
      'codex',
      '--prompt',
      'Continue safely',
      '--model',
      'gpt-5.2-codex',
      '--effort',
      'high',
    );

    const status = JSON.parse(
      (await relay(root, 'status', '--json')).stdout,
    ) as {
      agentHistory: Array<Record<string, unknown>>;
    };
    expect(status.agentHistory).toHaveLength(1);
    expect(status.agentHistory[0]).toMatchObject({
      id: expect.any(String),
      agent: 'codex',
      model: 'gpt-5.2-codex',
      effort: 'high',
      startedAt: expect.any(String),
      endedAt: expect.any(String),
      exitCode: 0,
      exitReason: 'completed',
    });
    const activity = await readFile(activityFilePath(), 'utf8');
    expect(JSON.parse(activity)).toMatchObject({ schemaVersion: 1 });
    expect(activity).not.toContain('gpt-5.2-codex');
    expect(activity).not.toContain('high');
  });

  it('does not spawn a duplicate provider for a repeated operation ID', async () => {
    const root = await createRepository();
    directories.push(root);
    await relay(root, 'init');
    await relay(root, 'start', 'Retry provider launch safely');
    const bin = path.join(root, 'fake-bin');
    await mkdir(bin);
    const executable = path.join(bin, 'codex');
    await writeFile(
      executable,
      '#!/bin/sh\nprintf "launch\\n" >> "$RELAY_FAKE_LOG"\n',
    );
    await chmod(executable, 0o700);
    const log = path.join(root, 'operation-launches.log');
    const env = {
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      RELAY_FAKE_LOG: log,
    };

    await relayWithEnv(
      root,
      env,
      'run',
      'codex',
      '--prompt',
      'Once',
      '--operation-id',
      'desktop-terminal-1',
    );
    await relayWithEnv(
      root,
      env,
      'run',
      'codex',
      '--prompt',
      'Once',
      '--operation-id',
      'desktop-terminal-1',
    );

    await expect(readFile(log, 'utf8')).resolves.toBe('launch\n');
    const state = JSON.parse(
      await readFile(`${root}/.relay/state.json`, 'utf8'),
    ) as { agentHistory: Array<{ id?: string }> };
    expect(state.agentHistory).toHaveLength(1);
  });

  it('assigns and persists a Claude session ID for a new launch', async () => {
    const root = await createRepository();
    directories.push(root);
    await relay(root, 'init');
    await relay(root, 'start', 'Track Claude session identity');
    const bin = path.join(root, 'fake-bin');
    await mkdir(bin);
    await writeFile(
      path.join(bin, 'claude'),
      '#!/bin/sh\nprintf "%s\\n" "$@" > "$RELAY_FAKE_LOG"\n',
    );
    await chmod(path.join(bin, 'claude'), 0o700);
    const log = path.join(root, 'claude-args.log');
    await relayWithEnv(
      root,
      {
        PATH: `${bin}${path.delimiter}${process.env.PATH}`,
        RELAY_FAKE_LOG: log,
      },
      'run',
      'claude',
      '--prompt',
      'Start here',
    );

    const state = JSON.parse(
      await readFile(`${root}/.relay/state.json`, 'utf8'),
    ) as {
      currentRunId?: string;
      agentHistory: Array<{
        launchMode?: string;
        providerSessionId?: string;
      }>;
    };
    const run = state.agentHistory.at(-1)!;
    expect(run).toMatchObject({
      launchMode: 'new',
      providerSessionId: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      ),
    });
    expect(state.currentRunId).toBeUndefined();
    const args = (await readFile(log, 'utf8')).trim().split('\n');
    expect(args).toContain('--session-id');
    expect(args[args.indexOf('--session-id') + 1]).toBe(run.providerSessionId);
    expect(args.at(-1)).toBe('Start here');
  });

  it('launches Claude resume and fork commands and records their parent metadata', async () => {
    const root = await createRepository();
    directories.push(root);
    await relay(root, 'init');
    await relay(root, 'start', 'Resume Claude safely');
    const bin = path.join(root, 'fake-bin');
    await mkdir(bin);
    await writeFile(
      path.join(bin, 'claude'),
      '#!/bin/sh\nprintf "%s\\n" "$@" > "$RELAY_FAKE_LOG"\n',
    );
    await chmod(path.join(bin, 'claude'), 0o700);
    const log = path.join(root, 'claude-resume-args.log');
    const env = {
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      RELAY_FAKE_LOG: log,
    };
    await relayWithEnv(root, env, 'run', 'claude', '--prompt', 'First');
    const firstState = JSON.parse(
      await readFile(`${root}/.relay/state.json`, 'utf8'),
    ) as {
      agentHistory: Array<{ id: string; providerSessionId: string }>;
    };
    const firstRun = firstState.agentHistory.at(-1)!;
    await relayWithEnv(
      root,
      env,
      'resume',
      'claude',
      '--id',
      firstRun.providerSessionId,
      '--fork',
      '--prompt',
      'Try another path',
    );

    const args = (await readFile(log, 'utf8')).trim().split('\n');
    expect(args).toEqual(
      expect.arrayContaining([
        '--resume',
        firstRun.providerSessionId,
        '--fork-session',
        'Try another path',
      ]),
    );
    expect(args).not.toContain('--session-id');
    const state = JSON.parse(
      await readFile(`${root}/.relay/state.json`, 'utf8'),
    ) as { agentHistory: Array<Record<string, unknown>> };
    expect(state.agentHistory.at(-1)).toMatchObject({
      launchMode: 'fork',
      resumeTargetKind: 'id',
      resumeTargetValue: firstRun.providerSessionId,
      parentRunId: firstRun.id,
      exitReason: 'completed',
    });
    expect(state.agentHistory.at(-1)).not.toHaveProperty('providerSessionId');

    await relayWithEnv(root, env, 'resume', 'claude', '--latest');
    const latestState = JSON.parse(
      await readFile(`${root}/.relay/state.json`, 'utf8'),
    ) as { agentHistory: Array<Record<string, unknown>> };
    expect(latestState.agentHistory.at(-1)).toMatchObject({
      launchMode: 'resume',
      resumeTargetKind: 'latest',
    });
    expect(latestState.agentHistory.at(-1)).not.toHaveProperty('parentRunId');
    expect(latestState.agentHistory.at(-1)).not.toHaveProperty(
      'providerSessionId',
    );
  });

  it('runs Codex resume without injecting a handoff or empty prompt', async () => {
    const root = await createRepository();
    directories.push(root);
    await relay(root, 'init');
    await relay(root, 'start', 'Resume Codex safely');
    const bin = path.join(root, 'fake-bin');
    await mkdir(bin);
    await writeFile(
      path.join(bin, 'codex'),
      '#!/bin/sh\nprintf "%s\\n" "$@" > "$RELAY_FAKE_LOG"\n',
    );
    await chmod(path.join(bin, 'codex'), 0o700);
    const log = path.join(root, 'codex-resume-args.log');
    await relayWithEnv(
      root,
      {
        PATH: `${bin}${path.delimiter}${process.env.PATH}`,
        RELAY_FAKE_LOG: log,
      },
      'resume',
      'codex',
      '--latest',
    );

    await expect(readFile(log, 'utf8')).resolves.toBe('resume\n--last\n');
    const state = JSON.parse(
      await readFile(`${root}/.relay/state.json`, 'utf8'),
    ) as { agentHistory: Array<Record<string, unknown>> };
    expect(state.agentHistory.at(-1)).toMatchObject({
      agent: 'codex',
      launchMode: 'resume',
      resumeTargetKind: 'latest',
      exitReason: 'completed',
    });
  });

  it('validates resume targets and rejects Codex forks before launch', async () => {
    const root = await createRepository();
    directories.push(root);
    await relay(root, 'init');
    await relay(root, 'start', 'Validate resume input');
    await expect(
      relay(root, 'resume', 'claude', '--latest', '--picker'),
    ).rejects.toThrow('Choose only one');
    await expect(
      relay(root, 'resume', 'codex', '--latest', '--fork'),
    ).rejects.toThrow('Codex session forks are not supported');
  });

  it('archives replaced completed state and searches current plus task metadata history', async () => {
    const root = await createRepository();
    directories.push(root);
    await relay(root, 'init');
    await relay(root, 'start', 'Archived title\nOriginal searchable phrase');
    const bin = path.join(root, 'fake-bin');
    await mkdir(bin);
    await writeFile(path.join(bin, 'codex'), '#!/bin/sh\nexit 0\n');
    await chmod(path.join(bin, 'codex'), 0o700);
    await relayWithEnv(
      root,
      { PATH: `${bin}${path.delimiter}${process.env.PATH}` },
      'run',
      'codex',
      '--prompt',
      'Work',
      '--model',
      'history-model',
      '--effort',
      'high',
    );
    await relay(root, 'finish');
    const completed = JSON.parse(
      await readFile(`${root}/.relay/state.json`, 'utf8'),
    ) as { sessionId: string; checkpoints: Array<{ id: string }> };
    await relay(root, 'start', 'Current searchable task', '--allow-dirty');

    await expect(
      readFile(
        `${root}/.relay/tasks/${completed.sessionId}/state.json`,
        'utf8',
      ),
    ).resolves.toContain('Archived title');
    const all = JSON.parse(
      (await relay(root, 'history', '--json')).stdout,
    ) as Array<{
      sessionId: string;
      current: boolean;
    }>;
    expect(all).toHaveLength(2);
    expect(all).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sessionId: completed.sessionId,
          current: false,
        }),
        expect.objectContaining({ current: true }),
      ]),
    );
    for (const query of [
      'Original searchable phrase',
      'codex',
      'history-model',
      'high',
      'completed',
      completed.checkpoints[0]!.id,
      'Final',
    ]) {
      const matches = JSON.parse(
        (await relay(root, 'history', query, '--json')).stdout,
      ) as Array<{ sessionId: string }>;
      expect(matches.map((entry) => entry.sessionId)).toContain(
        completed.sessionId,
      );
    }
    const current = JSON.parse(
      (await relay(root, 'history', 'Current searchable task', '--json'))
        .stdout,
    ) as Array<{ current: boolean }>;
    expect(current).toEqual([expect.objectContaining({ current: true })]);
  });

  it('repairs stale history without a lease when replacing a completed task', async () => {
    const root = await createRepository();
    directories.push(root);
    await relay(root, 'init');
    await relay(root, 'start', 'Wait for provider exit');
    const statePath = `${root}/.relay/state.json`;
    const state = JSON.parse(await readFile(statePath, 'utf8')) as {
      sessionId: string;
      task: { status: string };
      agentHistory: Array<Record<string, unknown>>;
    };
    state.task.status = 'completed';
    state.agentHistory.push({
      id: 'still-running',
      agent: 'claude',
      startedAt: '2026-07-21T00:00:00.000Z',
    });
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
    const oldSessionId = state.sessionId;
    await expect(
      relay(root, 'start', 'Safe replacement'),
    ).resolves.toMatchObject({
      stdout: expect.stringContaining('Started Relay task'),
    });
    const archived = JSON.parse(
      await readFile(`${root}/.relay/tasks/${oldSessionId}/state.json`, 'utf8'),
    ) as { agentHistory: Array<Record<string, unknown>> };
    expect(archived.agentHistory.at(-1)).toMatchObject({
      id: 'still-running',
      endedAt: expect.any(String),
      exitCode: null,
      exitReason: 'interrupted',
    });
  });

  it('does not replace a completed task while a run lease still owns a worktree', async () => {
    const root = await createRepository();
    directories.push(root);
    await relay(root, 'init');
    await relay(root, 'start', 'Wait for lease recovery');
    const statePath = `${root}/.relay/state.json`;
    const state = JSON.parse(await readFile(statePath, 'utf8')) as {
      task: { status: string };
      runs: Array<Record<string, unknown>>;
      agentHistory: Array<Record<string, unknown>>;
    };
    state.task.status = 'completed';
    state.agentHistory.push({
      id: 'leased-run',
      agent: 'claude',
      startedAt: '2026-07-21T00:00:00.000Z',
    });
    state.runs.push({
      runId: 'leased-run',
      worktreePath: root,
      projectRoot: root,
      agent: 'claude',
      launchMode: 'new',
      controllerId: 'test',
      startedAt: '2026-07-21T00:00:00.000Z',
      lastSeenAt: '2026-07-21T00:00:00.000Z',
      status: 'orphaned',
    });
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
    await expect(relay(root, 'start', 'Too soon')).rejects.toThrow(
      'still owns a working tree',
    );
  });

  it('requires forced stale-run recovery and marks only the matching run interrupted', async () => {
    const root = await createRepository();
    directories.push(root);
    await relay(root, 'init');
    await relay(root, 'start', 'Recover stale state');
    const statePath = `${root}/.relay/state.json`;
    const state = JSON.parse(await readFile(statePath, 'utf8')) as {
      currentAgent?: string;
      currentRunId?: string;
      agentHistory: Array<Record<string, unknown>>;
    };
    state.currentAgent = 'codex';
    state.currentRunId = 'stale-run';
    state.agentHistory.push({
      id: 'finished-run',
      agent: 'claude',
      startedAt: '2026-01-01T00:00:00.000Z',
      endedAt: '2026-01-01T00:01:00.000Z',
      exitCode: 0,
      exitReason: 'completed',
    });
    state.agentHistory.push({
      id: 'stale-run',
      agent: 'codex',
      startedAt: '2026-01-01T00:02:00.000Z',
      launchMode: 'resume',
      resumeTargetKind: 'latest',
    });
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);

    await expect(relay(root, 'recover')).rejects.toThrow(
      'cannot verify that the provider process has exited',
    );
    await expect(relay(root, 'recover', '--force')).resolves.toMatchObject({
      stdout: expect.stringContaining('interrupted'),
    });
    const recovered = JSON.parse(await readFile(statePath, 'utf8')) as {
      currentAgent?: string;
      currentRunId?: string;
      agentHistory: Array<Record<string, unknown>>;
    };
    expect(recovered.currentAgent).toBeUndefined();
    expect(recovered.currentRunId).toBeUndefined();
    expect(recovered.agentHistory[0]).toMatchObject({
      id: 'finished-run',
      exitReason: 'completed',
    });
    expect(recovered.agentHistory[1]).toMatchObject({
      id: 'stale-run',
      endedAt: expect.any(String),
      exitCode: null,
      exitReason: 'interrupted',
    });
  });

  it('recovers unfinished legacy history without current run mirrors', async () => {
    const root = await createRepository();
    directories.push(root);
    await relay(root, 'init');
    await relay(root, 'start', 'Recover legacy history');
    const statePath = `${root}/.relay/state.json`;
    const state = JSON.parse(await readFile(statePath, 'utf8')) as {
      agentHistory: Array<Record<string, unknown>>;
    };
    state.agentHistory.push({
      id: 'legacy-unfinished',
      agent: 'claude',
      startedAt: '2026-01-01T00:00:00.000Z',
    });
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);

    await expect(relay(root, 'recover', '--force')).resolves.toMatchObject({
      stdout: expect.stringContaining('interrupted'),
    });
    const recovered = JSON.parse(await readFile(statePath, 'utf8')) as {
      agentHistory: Array<Record<string, unknown>>;
    };
    expect(recovered.agentHistory.at(-1)).toMatchObject({
      id: 'legacy-unfinished',
      endedAt: expect.any(String),
      exitReason: 'interrupted',
    });
  });

  it('finishes with a final checkpoint without running tests by default', async () => {
    const root = await createRepository();
    directories.push(root);
    await relay(root, 'init');
    await relay(root, 'start', 'Finish safely');
    await relay(root, 'finish');
    const state = JSON.parse(
      await readFile(`${root}/.relay/state.json`, 'utf8'),
    ) as {
      task: { status: string };
      tests: unknown[];
      checkpoints: unknown[];
    };
    expect(state.task.status).toBe('completed');
    expect(state.tests).toHaveLength(0);
    expect(state.checkpoints).toHaveLength(1);
  });

  it('rejects finish while an agent owns a working tree', async () => {
    const root = await createRepository();
    directories.push(root);
    await relay(root, 'init');
    await relay(root, 'start', 'Finish while agent exits');
    const bin = path.join(root, 'fake-bin');
    await mkdir(bin);
    const executable = path.join(bin, 'codex');
    await writeFile(executable, '#!/bin/sh\nsleep 1\n');
    await chmod(executable, 0o700);
    const running = relayWithEnv(
      root,
      { PATH: `${bin}${path.delimiter}${process.env.PATH}` },
      'run',
      'codex',
      '--prompt',
      'Wait briefly',
    );
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const state = JSON.parse(
        await readFile(`${root}/.relay/state.json`, 'utf8'),
      ) as { currentAgent?: string };
      if (state.currentAgent === 'codex') break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await expect(relay(root, 'finish')).rejects.toThrow(
      /Cannot finish while a provider run/,
    );
    await running;
    await relay(root, 'finish');
    const state = JSON.parse(
      await readFile(`${root}/.relay/state.json`, 'utf8'),
    ) as {
      task: { status: string };
      checkpoints: unknown[];
      currentAgent?: string;
      agentHistory: Array<{ id?: string; endedAt?: string }>;
    };
    expect(state.task.status).toBe('completed');
    expect(state.checkpoints).toHaveLength(1);
    expect(state.currentAgent).toBeUndefined();
    expect(state.agentHistory.at(-1)).toMatchObject({
      id: expect.any(String),
      endedAt: expect.any(String),
    });
  });
});
