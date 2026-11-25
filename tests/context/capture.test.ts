import {
  appendFile,
  mkdir,
  readFile,
  readdir,
  realpath,
  symlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  initializeProject,
  startTask,
} from '../../src/application/project-setup.js';
import { normalizeClaudeHook } from '../../src/context/claude.js';
import { prepareContextLaunch } from '../../src/context/capture.js';
import {
  inspectContextEvents,
  loadContinuityContext,
} from '../../src/context/render.js';
import {
  CONTEXT_PROMPT_LIMIT,
  CONTEXT_TEXT_LIMIT,
} from '../../src/context/schema.js';
import {
  appendCapturedObservation,
  clearContext,
  contextDirectory,
  contextFingerprint,
  issueCaptureGrant,
  hash,
  readContextJournal,
  readContextPolicy,
  recordCaptureFailure,
  setContextConsent,
} from '../../src/context/store.js';
import { renderHandoffDocument } from '../../src/lifecycle.js';
import { verifySwitchPreview } from '../../src/cli/switch.js';
import { createRepository, removeRepository } from '../helpers.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeRepository));
});
async function project() {
  const root = await realpath(await createRepository());
  roots.push(root);
  await initializeProject(root);
  const state = await startTask(
    root,
    'Continue the interrupted implementation',
  );
  return { root, state, taskId: state.sessionId };
}
async function capture(runId = 'capture-run') {
  const context = await project();
  await setContextConsent(context.root, context.taskId, true);
  const issued = (await issueCaptureGrant(context.root, {
    taskId: context.taskId,
    runId,
    workspace: context.root,
    providerSessionId: 'provider-session',
    launchGitFingerprint: 'launch-anchor',
  }))!;
  const record = (payload: Record<string, unknown>) =>
    appendCapturedObservation(
      context.root,
      context.taskId,
      runId,
      issued.token,
      normalizeClaudeHook(
        { session_id: 'provider-session', cwd: context.root, ...payload },
        issued.grant,
      ),
    );
  return { ...context, ...issued, runId, record };
}

describe('Claude capture contract', () => {
  it('keeps a known Rirei launch handoff out of the new-instruction stream', () => {
    const prompt = 'Task: Original request\n\nCaptured historical context';
    const value = normalizeClaudeHook(
      {
        session_id: 'session',
        cwd: process.cwd(),
        hook_event_name: 'UserPromptSubmit',
        prompt,
      },
      { workspace: process.cwd(), launchPromptHash: hash(prompt) },
    );
    expect(value.kind).toBe('launch_prompt');
    expect(
      normalizeClaudeHook(
        {
          session_id: 'session',
          cwd: process.cwd(),
          hook_event_name: 'UserPromptSubmit',
          prompt: 'New user correction',
        },
        { workspace: process.cwd(), launchPromptHash: hash(prompt) },
      ).kind,
    ).toBe('prompt_submission');
  });
  it('retains only visible allowed fields and keeps reported failures separate from assistant claims', () => {
    const base = { session_id: 'session', cwd: process.cwd() };
    const result = normalizeClaudeHook(
      {
        ...base,
        hook_event_name: 'PostToolUseFailure',
        tool_use_id: 'test-1',
        tool_name: 'Bash',
        tool_input: { command: 'npm test', hidden: 'not retained' },
        error: 'Isolation test failed',
        transcript_path: '/never/read/this',
        thinking: 'private reasoning',
      },
      { workspace: process.cwd() },
    );
    expect(result).toMatchObject({
      kind: 'tool_result',
      outcome: 'reported_failure',
      command: 'npm test',
      exitCode: null,
    });
    expect(JSON.stringify(result)).not.toMatch(
      /thinking|private reasoning|transcript_path|never\/read|not retained/,
    );
    const claim = normalizeClaudeHook(
      {
        ...base,
        hook_event_name: 'Stop',
        last_assistant_message: 'All tests passed.',
      },
      { workspace: process.cwd() },
    );
    expect(claim).toMatchObject({
      kind: 'assistant_claim',
      text: 'All tests passed.',
    });
    expect(claim.exitCode).toBeUndefined();
    expect(
      normalizeClaudeHook(
        { ...base, hook_event_name: 'Stop' },
        { workspace: process.cwd() },
      ).kind,
    ).toBe('turn_end');
  });

  it('never infers a passing command from a successful tool invocation', () => {
    const value = normalizeClaudeHook(
      {
        session_id: 'session',
        cwd: process.cwd(),
        hook_event_name: 'PostToolUse',
        tool_use_id: 'test-1',
        tool_name: 'Bash',
        tool_input: { command: 'npm test' },
        tool_response: { stdout: 'A test command returned', success: true },
      },
      { workspace: process.cwd() },
    );
    expect(value).toMatchObject({
      outcome: 'reported_success',
      exitCode: null,
    });
    const failedCommand = normalizeClaudeHook(
      {
        session_id: 'session',
        cwd: process.cwd(),
        hook_event_name: 'PostToolUse',
        tool_use_id: 'test-1',
        tool_name: 'Bash',
        tool_input: { command: 'npm test' },
        tool_response: { exit_code: 1, stdout: 'failed' },
      },
      { workspace: process.cwd() },
    );
    expect(failedCommand.exitCode).toBe(1);
  });

  it('redacts recognized secrets, strips terminal escapes, and explicitly marks bounded source text', () => {
    const secret = `sk-ant-${'x'.repeat(40)}`;
    const value = normalizeClaudeHook(
      {
        session_id: 'session',
        cwd: process.cwd(),
        hook_event_name: 'UserPromptSubmit',
        prompt: `\x1b[31mKeep the API unchanged. ${secret} ${'😀'.repeat(CONTEXT_TEXT_LIMIT)}`,
      },
      { workspace: process.cwd() },
    );
    expect(value.redacted).toBe(true);
    expect(value.truncated).toBe(true);
    expect(value.text).toContain('Keep the API unchanged.');
    expect(value.text).not.toContain(secret);
    expect(value.text).not.toContain('\x1b');
    expect(value.text.length).toBeLessThanOrEqual(CONTEXT_TEXT_LIMIT);
    expect(value.text.isWellFormed()).toBe(true);
  });

  it('permits a project subdirectory but rejects sibling workspaces and mismatched sessions', () => {
    const base = {
      session_id: 'session',
      hook_event_name: 'UserPromptSubmit',
      prompt: 'Keep constraints.',
    };
    expect(
      normalizeClaudeHook(
        { ...base, cwd: path.join(process.cwd(), 'src') },
        { workspace: process.cwd() },
      ).kind,
    ).toBe('prompt_submission');
    expect(() =>
      normalizeClaudeHook(
        { ...base, cwd: `${process.cwd()}-other` },
        { workspace: process.cwd() },
      ),
    ).toThrow('workspace');
    expect(() =>
      normalizeClaudeHook(
        { ...base, cwd: process.cwd() },
        { workspace: process.cwd(), providerSessionId: 'different' },
      ),
    ).toThrow('session');
  });
});

describe('durable task-local evidence', () => {
  it('prioritizes a late submitted correction over verbose older tool output', async () => {
    const context = await capture();
    for (let index = 0; index < 6; index++)
      await context.record({
        hook_event_name: 'PostToolUse',
        tool_use_id: `large-${index}`,
        tool_name: 'Bash',
        tool_input: { command: 'inspect repository' },
        tool_response: {
          stdout: `Old output ${index}: ${'data '.repeat(400)}`,
        },
      });
    const event = await context.record({
      hook_event_name: 'UserPromptSubmit',
      prompt:
        'Correction: keep the existing public API and add no dependencies.',
    });
    const view = (await loadContinuityContext(
      context.root,
      context.taskId,
      context.root,
      'launch-anchor',
    ))!;
    expect(view.text).toContain(event.text);
    expect(view.text).toContain(event.id);
    expect(view.omittedEvents).toBeGreaterThan(0);
    expect(view.text.length).toBeLessThanOrEqual(CONTEXT_PROMPT_LIMIT);
  });
  it('does not create capture storage while disabled or for an unsupported provider', async () => {
    const { root, state, taskId } = await project();
    expect(await readContextPolicy(root, taskId)).toBeNull();
    expect((await readContextJournal(root, taskId)).events).toEqual([]);
    const command = { executable: 'codex', args: ['prompt'] };
    expect(
      await prepareContextLaunch({
        root,
        state,
        runId: 'run',
        provider: 'codex',
        workspace: root,
        command,
      }),
    ).toEqual({ command, env: {} });
    expect(await readdir(path.join(root, '.relay'))).not.toContain('context');
  });

  it('replays tool events idempotently without erasing intentional repeated prompts', async () => {
    const context = await capture();
    const payload = {
      hook_event_name: 'PreToolUse',
      tool_use_id: 'tool-1',
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
    };
    const first = await context.record(payload);
    expect((await context.record(payload)).id).toBe(first.id);
    await expect(
      context.record({
        ...payload,
        tool_input: { command: 'another command' },
      }),
    ).rejects.toThrow('Conflicting delivery');
    await context.record({
      hook_event_name: 'UserPromptSubmit',
      prompt: 'Do not add dependencies.',
    });
    await context.record({
      hook_event_name: 'UserPromptSubmit',
      prompt: 'Do not add dependencies.',
    });
    const journal = await readContextJournal(context.root, context.taskId);
    expect(journal.events.map((event) => event.sequence)).toEqual([1, 2, 3]);
    expect(new Set(journal.events.map((event) => event.id)).size).toBe(3);
  });

  it('serializes competing event deliveries without dropping evidence', async () => {
    const context = await capture();
    await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        context.record({
          hook_event_name: 'UserPromptSubmit',
          prompt: `Requirement ${index}`,
        }),
      ),
    );
    const journal = await readContextJournal(context.root, context.taskId);
    expect(journal.events).toHaveLength(6);
    expect(new Set(journal.events.map((event) => event.text)).size).toBe(6);
    expect(journal.incompleteTail).toBe(false);
  });

  it('revokes existing grants across disable/re-enable and rejects invalid tokens', async () => {
    const context = await capture();
    const observation = normalizeClaudeHook(
      {
        session_id: 'provider-session',
        cwd: context.root,
        hook_event_name: 'UserPromptSubmit',
        prompt: 'Keep the API.',
      },
      context.grant,
    );
    await expect(
      appendCapturedObservation(
        context.root,
        context.taskId,
        context.runId,
        'wrong-token',
        observation,
      ),
    ).rejects.toThrow('invalid or revoked');
    await setContextConsent(context.root, context.taskId, false);
    await expect(
      context.record({
        hook_event_name: 'UserPromptSubmit',
        prompt: 'Blocked',
      }),
    ).rejects.toThrow('disabled');
    await setContextConsent(context.root, context.taskId, true);
    await expect(
      context.record({
        hook_event_name: 'UserPromptSubmit',
        prompt: 'Still blocked',
      }),
    ).rejects.toThrow('invalid or revoked');
  });

  it('binds a picker launch to its first provider session', async () => {
    const { root, taskId } = await project();
    await setContextConsent(root, taskId, true);
    const issued = (await issueCaptureGrant(root, {
      taskId,
      runId: 'picker',
      workspace: root,
      launchGitFingerprint: 'launch',
    }))!;
    const record = (session: string) =>
      appendCapturedObservation(
        root,
        taskId,
        'picker',
        issued.token,
        normalizeClaudeHook(
          {
            session_id: session,
            cwd: root,
            hook_event_name: 'UserPromptSubmit',
            prompt: 'Continue',
          },
          { workspace: root },
        ),
      );
    await record('first');
    await expect(record('second')).rejects.toThrow('provider session');
  });

  it('recovers complete evidence before a torn UTF-8 tail and refuses to overwrite it', async () => {
    const context = await capture();
    const first = await context.record({
      hook_event_name: 'UserPromptSubmit',
      prompt: 'Preserve the public API.',
    });
    const file = path.join(
      contextDirectory(context.root, context.taskId),
      'events.jsonl',
    );
    await appendFile(file, Buffer.from([0x7b, 0x22, 0xe2, 0x82]));
    const before = await readFile(file);
    const recovered = await readContextJournal(context.root, context.taskId);
    expect(recovered.events.map((event) => event.id)).toEqual([first.id]);
    expect(recovered.incompleteTail).toBe(true);
    await expect(
      context.record({ hook_event_name: 'UserPromptSubmit', prompt: 'Later' }),
    ).rejects.toThrow('incomplete tail');
    expect(await readFile(file)).toEqual(before);
  });

  it('rejects a corrupted complete record instead of treating it as trusted context', async () => {
    const context = await capture();
    await context.record({
      hook_event_name: 'UserPromptSubmit',
      prompt: 'Original requirement',
    });
    const file = path.join(
      contextDirectory(context.root, context.taskId),
      'events.jsonl',
    );
    await writeFile(
      file,
      (await readFile(file, 'utf8')).replace(
        'Original requirement',
        'Changed requirement',
      ),
    );
    await expect(
      readContextJournal(context.root, context.taskId),
    ).rejects.toThrow('integrity');
  });

  it('keeps workspace evidence separate and treats results as historical after code changes', async () => {
    const context = await capture();
    await context.record({
      hook_event_name: 'UserPromptSubmit',
      prompt: 'Primary workspace requirement',
    });
    const other = path.join(context.root, 'other-workspace');
    await mkdir(other);
    const issued = (await issueCaptureGrant(context.root, {
      taskId: context.taskId,
      runId: 'other',
      workspace: other,
      providerSessionId: 'other',
      launchGitFingerprint: 'old',
    }))!;
    await appendCapturedObservation(
      context.root,
      context.taskId,
      'other',
      issued.token,
      normalizeClaudeHook(
        {
          session_id: 'other',
          cwd: other,
          hook_event_name: 'UserPromptSubmit',
          prompt: 'Other workspace requirement',
        },
        issued.grant,
      ),
    );
    const view = (await loadContinuityContext(
      context.root,
      context.taskId,
      context.root,
      'new-anchor',
    ))!;
    expect(view.text).toContain('Primary workspace requirement');
    expect(view.text).not.toContain('Other workspace requirement');
    expect(view.warnings.join(' ')).toContain('do not verify the current code');
  });

  it('links over-budget prompts without silently cutting a constraint and preserves diagnostics', async () => {
    const context = await capture();
    const message = `Do not remove the final requirement. ${'details '.repeat(1000)}FINAL CONSTRAINT`;
    const event = await context.record({
      hook_event_name: 'UserPromptSubmit',
      prompt: message,
    });
    await recordCaptureFailure(
      context.root,
      context.taskId,
      context.runId,
      context.token,
    );
    const before = await contextFingerprint(context.root, context.taskId);
    const view = (await loadContinuityContext(
      context.root,
      context.taskId,
      context.root,
      'launch-anchor',
    ))!;
    expect(view.digest).toBe(before);
    expect(view.text.length).toBeLessThanOrEqual(CONTEXT_PROMPT_LIMIT);
    expect(view.partialEvents).toContain(event.id);
    expect(view.text).toContain('REQUIRED BEFORE EDITING: relay context task');
    expect(view.submissionCoverage?.requiredSourceIds).toContain(event.id);
    expect(view.warnings.join(' ')).toContain('known gap');
    expect(
      (await readContextJournal(context.root, context.taskId)).events.find(
        (item) => item.id === event.id,
      )?.text,
    ).toBe(message);
  });

  it('invalidates a switch preview when evidence or consent changes', async () => {
    const context = await capture();
    await context.record({
      hook_event_name: 'UserPromptSubmit',
      prompt: 'Initial correction',
    });
    const preview = await renderHandoffDocument(context.root, context.state);
    await context.record({
      hook_event_name: 'UserPromptSubmit',
      prompt: 'New correction',
    });
    await expect(verifySwitchPreview(context.root, preview)).rejects.toThrow(
      'changed after the preview',
    );
    const latest = await renderHandoffDocument(context.root, context.state);
    await setContextConsent(context.root, context.taskId, false);
    await expect(verifySwitchPreview(context.root, latest)).rejects.toThrow(
      'changed after the preview',
    );
  });

  it('clears only the current task’s generated evidence and revokes its grants', async () => {
    const context = await capture();
    await context.record({
      hook_event_name: 'UserPromptSubmit',
      prompt: 'Private task context',
    });
    await setContextConsent(context.root, 'another-task', true);
    const otherPolicy = await readContextPolicy(context.root, 'another-task');
    const stateBefore = await readFile(
      path.join(context.root, '.relay', 'state.json'),
    );
    const abandoned = path.join(
      contextDirectory(context.root, context.taskId),
      '.context-00000000-0000-0000-0000-000000000000.tmp',
    );
    await writeFile(abandoned, 'Abandoned captured context');
    await clearContext(context.root, context.taskId);
    expect(
      await readdir(contextDirectory(context.root, context.taskId)),
    ).not.toContain(path.basename(abandoned));
    expect(
      (await readContextJournal(context.root, context.taskId)).events,
    ).toEqual([]);
    expect(
      (await readContextPolicy(context.root, context.taskId))?.enabled,
    ).toBe(false);
    expect(await readContextPolicy(context.root, 'another-task')).toEqual(
      otherPolicy,
    );
    expect(
      await readFile(path.join(context.root, '.relay', 'state.json')),
    ).toEqual(stateBefore);
    await expect(
      context.record({
        hook_event_name: 'UserPromptSubmit',
        prompt: 'Late event',
      }),
    ).rejects.toThrow('disabled');
  });

  it.skipIf(process.platform === 'win32')(
    'rejects symlinked capture directories without touching the target',
    async () => {
      const { root, taskId } = await project();
      const target = path.join(root, 'external');
      await mkdir(target);
      await symlink(target, path.join(root, '.relay', 'context'), 'dir');
      await expect(setContextConsent(root, taskId, true)).rejects.toThrow(
        'real directories',
      );
      expect(await readdir(target)).toEqual([]);
    },
  );

  it('marks an unfinished tool independently of result arrival order', async () => {
    const context = await capture();
    await context.record({
      hook_event_name: 'PostToolUseFailure',
      tool_use_id: 'done',
      tool_name: 'Bash',
      tool_input: { command: 'test' },
      error: 'failed',
    });
    await context.record({
      hook_event_name: 'PreToolUse',
      tool_use_id: 'done',
      tool_name: 'Bash',
      tool_input: { command: 'test' },
    });
    const pending = await context.record({
      hook_event_name: 'PreToolUse',
      tool_use_id: 'pending',
      tool_name: 'Bash',
      tool_input: { command: 'another test' },
    });
    expect(
      inspectContextEvents(
        (await readContextJournal(context.root, context.taskId)).events,
      ).pendingTools,
    ).toEqual([pending.id]);
  });
});
