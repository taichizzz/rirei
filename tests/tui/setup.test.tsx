import { PassThrough } from 'node:stream';
import React from 'react';
import * as ink from 'ink';
import stripAnsi from 'strip-ansi';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentCatalogEntry } from '../../src/agents/registry.js';
import type { ProjectSetupState } from '../../src/application/project-setup.js';
import { createSetupApp } from '../../src/tui/setup.js';

const mounted: Array<{ unmount(): void }> = [];
afterEach(() => {
  for (const instance of mounted.splice(0)) instance.unmount();
});

async function renderSetup(initial: ProjectSetupState) {
  const stdin = new PassThrough() as PassThrough & {
    isTTY: boolean;
    setRawMode: () => void;
    ref: () => void;
    unref: () => void;
  };
  Object.assign(stdin, { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
  const stdout = new PassThrough() as PassThrough & {
    columns: number;
    rows: number;
    isTTY: boolean;
  };
  Object.assign(stdout, { columns: 80, rows: 24, isTTY: false });
  const frames: string[] = [];
  stdout.on('data', (chunk) => frames.push(stripAnsi(chunk.toString())));
  const onInitialize = vi.fn(async (): Promise<ProjectSetupState> => ({
    stage: 'task',
    project: initial.project,
    dirty: false,
  }));
  const onStartTask = vi.fn(async (): Promise<ProjectSetupState> => ({
    stage: 'ready',
    project: initial.project,
    taskTitle: 'Windows task',
  }));
  const onDone = vi.fn();
  const onQuit = vi.fn();
  const Setup = createSetupApp(ink, React);
  const providers = [
    { id: 'codex', displayName: 'Codex', installed: false },
  ] as AgentCatalogEntry[];
  const instance = ink.render(
    React.createElement(Setup, {
      initial,
      providers,
      onInitialize,
      onStartTask,
      onDone,
      onQuit,
      onRefresh: async () => ({ setup: initial, providers }),
    }),
    {
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
      debug: true,
      exitOnCtrlC: false,
    },
  );
  mounted.push(instance);
  const send = async (text: string) => {
    stdin.write(text);
    await new Promise((resolve) => setTimeout(resolve, 60));
  };
  await new Promise((resolve) => setTimeout(resolve, 60));
  return {
    onInitialize,
    onStartTask,
    onDone,
    onQuit,
    send,
    frame: () => frames.at(-1) ?? '',
  };
}

describe('first-task setup interaction', () => {
  it('requires Enter to initialize; Escape exits without changing the project', async () => {
    const app = await renderSetup({
      stage: 'initialize',
      project: '/work/project',
    });
    expect(app.frame()).toContain('Initialize this project');
    expect(app.onInitialize).not.toHaveBeenCalled();
    await app.send('\u001b');
    expect(app.onQuit).toHaveBeenCalledOnce();
    expect(app.onInitialize).not.toHaveBeenCalled();
  });

  it('initializes, accepts a task, then shows provider setup before continuing', async () => {
    const app = await renderSetup({
      stage: 'initialize',
      project: '/work/project',
    });
    await app.send('\r');
    expect(app.onInitialize).toHaveBeenCalledOnce();
    await app.send('Windows task');
    await app.send('\r');
    expect(app.onStartTask).toHaveBeenCalledWith('Windows task', false);
    expect(app.frame()).toContain('Not installed');
    expect(app.frame()).toContain('developers.openai.com/codex/cli');
    expect(app.onDone).not.toHaveBeenCalled();
    await app.send('\r');
    expect(app.onDone).toHaveBeenCalledOnce();
    expect(app.frame().split('\n').length).toBeLessThanOrEqual(24);
  });

  it('blocks starting on a dirty tree until the checkbox is explicitly checked', async () => {
    const app = await renderSetup({
      stage: 'task',
      project: '/work/project',
      dirty: true,
    });
    await app.send('Windows task');
    await app.send('\r');
    expect(app.onStartTask).not.toHaveBeenCalled();
    expect(app.frame()).toContain('acknowledge');
    await app.send('\t');
    await app.send(' ');
    await app.send('\t');
    await app.send('\r');
    expect(app.onStartTask).toHaveBeenCalledWith('Windows task', true);
  });

  it('treats launcher shortcuts as task text instead of launching anything', async () => {
    const app = await renderSetup({
      stage: 'task',
      project: '/work/project',
      dirty: false,
    });
    await app.send('codex questions');
    expect(app.frame()).toContain('codex questions');
    expect(app.onStartTask).not.toHaveBeenCalled();
    expect(app.onDone).not.toHaveBeenCalled();
  });
});
