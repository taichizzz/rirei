import { execFile } from 'node:child_process';
import { chmod, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { createRepository, removeRepository } from '../helpers.js';
import { readState } from '../../src/state/store.js';
import {
  appendCapturedObservation,
  issueCaptureGrant,
} from '../../src/context/store.js';
import { normalizeClaudeHook } from '../../src/context/claude.js';

const execute = promisify(execFile);
const entry = fileURLToPath(new URL('../../src/index.ts', import.meta.url));
const loader = new URL(
  '../../node_modules/tsx/dist/loader.mjs',
  import.meta.url,
).href;
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeRepository));
});

async function project(mode: 'source' | 'compiled' = 'source') {
  const root = await realpath(await createRepository());
  roots.push(root);
  const home = path.join(root, '.relay-test-home');
  const tools = path.join(home, 'tools with spaces');
  await mkdir(tools, { recursive: true });
  // Keep the fake runtime outside the repository snapshot used by the handoff guard.
  await execute(
    'git',
    ['config', 'core.excludesFile', path.join(home, 'exclude')],
    { cwd: root },
  );
  await writeFile(path.join(home, 'exclude'), '.relay-test-home/\n');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    LOCALAPPDATA: path.join(home, 'local'),
    CLAUDE_CONFIG_DIR: path.join(home, 'claude'),
    CODEX_HOME: path.join(home, 'codex'),
    RIREI_DATA_HOME: path.join(home, 'rirei-data'),
    FAKE_CODEX_OUTPUT: path.join(home, 'successor.json'),
  };
  for (const key of Object.keys(env))
    if (key.toLowerCase() === 'path') delete env[key];
  env.PATH = `${tools}${path.delimiter}${process.env.PATH ?? process.env.Path ?? ''}`;
  const relay = (...args: string[]) =>
    execute(
      process.execPath,
      mode === 'source'
        ? ['--import', loader, entry, ...args]
        : [
            fileURLToPath(new URL('../../dist/index.cjs', import.meta.url)),
            ...args,
          ],
      {
        cwd: root,
        env,
      },
    );
  await relay('init');
  await relay('start', 'Implement the fix without changing the public API');
  return { root, home, tools, env, relay };
}

async function fakeProvider(tools: string, name: string, program: string) {
  const script = path.join(tools, `${name}-fixture.cjs`);
  await writeFile(script, program);
  if (process.platform === 'win32') {
    await writeFile(
      path.join(tools, `${name}.cmd`),
      `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`,
    );
  } else {
    const wrapper = path.join(tools, name);
    await writeFile(
      wrapper,
      `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' '${script.replaceAll("'", "'\\''")}' "$@"\n`,
    );
    await chmod(wrapper, 0o700);
  }
}

const claudeFixture = String.raw`
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('fixture-claude'); process.exit(0); }
const settings = JSON.parse(fs.readFileSync(args[args.indexOf('--settings') + 1], 'utf8'));
const session_id = args[args.indexOf('--session-id') + 1];
function deliver(hook_event_name, extra = {}) {
  const group = settings.hooks[hook_event_name].find(group => group.hooks.some(hook => hook.args?.includes('ingest')));
  const hook = group.hooks.find(hook => hook.args?.includes('ingest'));
  const result = spawnSync(hook.command, hook.args, {
    cwd: process.cwd(), env: process.env, encoding: 'utf8',
    input: JSON.stringify({ session_id, cwd: process.cwd(), hook_event_name, ...extra }),
  });
  if (result.status !== 0) throw new Error(result.stderr || 'Capture hook did not complete.');
  return hook;
}
const hook = deliver('SessionStart', { source: 'startup' });
deliver('UserPromptSubmit', { prompt: args.at(-1) });
deliver('UserPromptSubmit', { prompt: 'Correction: preserve request isolation and add no dependencies.' });
deliver('PreToolUse', { tool_use_id: 'isolation-test', tool_name: 'Bash', tool_input: { command: 'npm test' } });
deliver('PostToolUseFailure', { tool_use_id: 'isolation-test', tool_name: 'Bash', tool_input: { command: 'npm test' }, error: 'Controller-level caching leaks state across requests.' });
const consent = spawnSync(hook.command, [...hook.args.slice(0, -1), 'disable'], { cwd: process.cwd(), env: process.env, encoding: 'utf8' });
if (consent.status === 0 || !consent.stderr.includes('operator')) throw new Error('Managed provider changed capture consent.');
console.log('Interrupted fixture; no final summary or session-end event.');
process.exitCode = 17;
`;

describe('managed continuation CLI', () => {
  it.each(['source', 'compiled'] as const)(
    'captures an interrupted Claude run and switches to Codex without manual notes (%s)',
    async (mode) => {
      const context = await project(mode);
      await fakeProvider(context.tools, 'claude', claudeFixture);
      await fakeProvider(
        context.tools,
        'codex',
        String.raw`
      const fs = require('node:fs');
      if (process.argv.includes('--version')) { console.log('fixture-codex'); process.exit(0); }
      fs.writeFileSync(process.env.FAKE_CODEX_OUTPUT, JSON.stringify({
        args: process.argv.slice(2),
        captureVariables: Object.keys(process.env).filter(key => key.startsWith('RIREI_CONTEXT_')),
      }));
      console.log('Successor received the approved prompt.');
    `,
      );
      await context.relay('context', 'enable');
      await expect(context.relay('run', 'claude')).rejects.toMatchObject({
        code: 17,
      });
      const status = JSON.parse(
        (await context.relay('context', 'status', '--json')).stdout,
      );
      expect(status).toMatchObject({ enabled: true, events: 5 });
      expect(status.warnings.join(' ')).toContain('no captured session end');
      const preview = JSON.parse(
        (await context.relay('handoff', '--json')).stdout,
      );
      expect(preview.text).toContain('preserve request isolation');
      expect(preview.text).toContain('Controller-level caching leaks state');
      expect(preview.continuity.useful).toBe(true);
      expect(preview.contentChecks.duplicateTaskOccurrences).toBe(1);
      expect(
        JSON.parse((await context.relay('context', 'task')).stdout).task
          .originalRequest,
      ).toContain('without changing the public API');
      const task = JSON.parse((await context.relay('context', 'task')).stdout);
      expect(task.workspace).toBe(context.root);
      expect(task.submittedMessages.events).toHaveLength(1);
      expect(task.submittedMessages.events[0].text).toContain(
        'preserve request isolation',
      );
      expect(task.submittedMessages.nextAfter).toBeNull();
      const events = JSON.parse(
        (await context.relay('context', 'history', '--limit', '2')).stdout,
      );
      expect(events.events).toHaveLength(2);
      expect(events.nextAfter).toBe(2);
      expect(events.events[1].kind).toBe('launch_prompt');
      const prompts = JSON.parse(
        (
          await context.relay(
            'context',
            'history',
            '--kind',
            'prompt_submission',
          )
        ).stdout,
      );
      expect(prompts.events).toHaveLength(1);
      const evidence = JSON.parse(
        (await context.relay('context', 'evidence', prompts.events[0].id))
          .stdout,
      );
      expect(evidence.event.text).toContain('Correction:');
      expect(evidence.workspace).toBe(context.root);
      expect(evidence.historicalPathNotice).toContain('another worktree');
      context.env.RIREI_CONTEXT_TOKEN = 'stale-inherited-token';
      await context.relay('switch', 'codex', '--yes');
      const received = JSON.parse(
        await readFile(context.env.FAKE_CODEX_OUTPUT!, 'utf8'),
      );
      expect(received.args.at(-1)).toContain(
        'Controller-level caching leaks state',
      );
      expect(received.captureVariables).toEqual([]);
      await context.relay('context', 'disable');
      const disabledTask = JSON.parse(
        (await context.relay('context', 'task')).stdout,
      );
      expect(disabledTask.submittedMessages).toMatchObject({
        captureEnabled: false,
        events: [],
      });
      expect((await context.relay('handoff')).stdout).not.toContain(
        'Controller-level caching leaks state',
      );
      expect(
        JSON.parse((await context.relay('context', 'status', '--json')).stdout),
      ).toMatchObject({ enabled: false, events: 5 });
      await context.relay('context', 'clear');
      expect(
        JSON.parse((await context.relay('context', 'status', '--json')).stdout),
      ).toMatchObject({ enabled: false, events: 0 });
    },
  );

  it('paginates submitted instructions in task lookup without treating empty task fields as missing requirements', async () => {
    const context = await project('compiled');
    await context.relay('context', 'enable');
    const state = await readState(context.root);
    const issued = (await issueCaptureGrant(context.root, {
      taskId: state.sessionId,
      runId: 'lookup',
      workspace: context.root,
      providerSessionId: 'lookup-session',
      launchGitFingerprint: 'anchor',
    }))!;
    for (let index = 0; index < 23; index++) {
      await appendCapturedObservation(
        context.root,
        state.sessionId,
        'lookup',
        issued.token,
        normalizeClaudeHook(
          {
            session_id: 'lookup-session',
            cwd: context.root,
            hook_event_name: 'UserPromptSubmit',
            prompt: `Requirement ${index}: preserve the exact value ${index}.`,
          },
          issued.grant,
        ),
      );
    }
    const other = path.join(context.root, 'other-workspace');
    await mkdir(other);
    const foreign = (await issueCaptureGrant(context.root, {
      taskId: state.sessionId,
      runId: 'foreign',
      workspace: other,
      providerSessionId: 'foreign',
      launchGitFingerprint: 'anchor',
    }))!;
    await appendCapturedObservation(
      context.root,
      state.sessionId,
      'foreign',
      foreign.token,
      normalizeClaudeHook(
        {
          session_id: 'foreign',
          cwd: other,
          hook_event_name: 'UserPromptSubmit',
          prompt: 'Unrelated workspace instructions',
        },
        foreign.grant,
      ),
    );
    const before = await readFile(
      path.join(context.root, '.relay/state.json'),
      'utf8',
    );
    const messages: string[] = [];
    let after = 0;
    do {
      const result = JSON.parse(
        (
          await context.relay(
            'context',
            'task',
            '--after',
            String(after),
            '--limit',
            '10',
          )
        ).stdout,
      );
      expect(result.task.requirements).toEqual([]);
      expect(result.submittedMessages.total).toBe(23);
      expect(result.submittedMessages.events.length).toBeLessThanOrEqual(10);
      messages.push(
        ...result.submittedMessages.events.map(
          (event: { text: string }) => event.text,
        ),
      );
      if (result.submittedMessages.nextAfter === null) break;
      expect(result.submittedMessages.nextAfter).toBeGreaterThan(after);
      after = result.submittedMessages.nextAfter;
    } while (after < 23);
    expect(messages).toEqual(
      Array.from(
        { length: 23 },
        (_, index) =>
          `Requirement ${index}: preserve the exact value ${index}.`,
      ),
    );
    expect(
      await readFile(path.join(context.root, '.relay/state.json'), 'utf8'),
    ).toBe(before);
    await expect(
      context.relay('context', 'task', '--limit', '21'),
    ).rejects.toThrow();
    await expect(
      context.relay('context', 'task', '--after', '-1'),
    ).rejects.toThrow();
  });

  it('does not initialize capture or change the source tree for status/history reads', async () => {
    const context = await project();
    const before = (
      await execute('git', ['status', '--porcelain'], { cwd: context.root })
    ).stdout;
    expect(
      JSON.parse((await context.relay('context', 'status', '--json')).stdout),
    ).toMatchObject({ enabled: false, events: 0 });
    expect(
      JSON.parse((await context.relay('context', 'history')).stdout).events,
    ).toEqual([]);
    expect(
      (await execute('git', ['status', '--porcelain'], { cwd: context.root }))
        .stdout,
    ).toBe(before);
    await expect(
      context.relay('context', 'history', '--limit', '100'),
    ).rejects.toThrow();
    await expect(context.relay('context', 'ingest')).rejects.toThrow(
      'managed capture grant',
    );
  });
});
