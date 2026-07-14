import { execFile } from 'node:child_process';
import { access, chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
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

  it('records a task baseline and event', async () => {
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
    await expect(
      readFile(`${root}/.relay/events.jsonl`, 'utf8'),
    ).resolves.toContain('task_started');
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
    expect(handoff.stdout).toContain('Diff stat:');
    expect(handoff.stdout).not.toContain('diff --git');
    const after = await execFileAsync('git', ['status', '--porcelain=v1'], {
      cwd: root,
    });
    expect(after.stdout).toBe(before.stdout);
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
    const events = await readFile(`${root}/.relay/events.jsonl`, 'utf8');
    expect(events).toContain('"type":"agent_started"');
    expect(events).toContain('"model":"gpt-5.2-codex"');
    expect(events).toContain('"effort":"high"');
    expect(events).toContain('"type":"agent_ended"');
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

  it('preserves newer completion state when a running agent exits', async () => {
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
    await relay(root, 'finish');
    await running;
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
