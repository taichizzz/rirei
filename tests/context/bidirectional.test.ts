import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createRun,
  runCase,
  reserveSession,
  finalize,
  providerMetrics,
  visibleRecord,
  claudeArguments,
} from '../../benchmarks/continuity/bidirectional.mjs';
import {
  WORKFLOWS,
  validateWorkflows,
} from '../../benchmarks/continuity/workflows.mjs';
import {
  initializeProject,
  startTask,
} from '../../src/application/project-setup.js';
import {
  appendCapturedObservation,
  issueCaptureGrant,
  setContextConsent,
} from '../../src/context/store.js';
import { createRepository } from '../helpers.js';

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    roots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true, maxRetries: 5 })),
  );
});
async function temporary() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rirei-two-way-test-'));
  roots.push(root);
  return root;
}

describe('two-way benchmark contracts', () => {
  it('validates multi-file references and rejects unfinished snapshots', async () => {
    const results = await validateWorkflows();
    expect(results).toHaveLength(2);
    expect(
      results.every(
        (result) =>
          result.referencePassed &&
          result.initialRejected &&
          result.groups === 7,
      ),
    ).toBe(true);
    expect(
      WORKFLOWS.every(
        (task) =>
          Object.keys(task.files).filter((name) => name.startsWith('src/'))
            .length >= 3,
      ),
    ).toBe(true);
  });
  it('excludes hidden thinking and retains visible tools and authoritative usage', () => {
    const record = visibleRecord('claude', {
      type: 'assistant',
      message: {
        content: [
          { type: 'thinking', thinking: 'private' },
          { type: 'text', text: 'Visible' },
          {
            type: 'tool_use',
            id: 'a',
            name: 'Read',
            input: { file_path: 'src/index.mjs' },
          },
        ],
      },
    });
    expect(JSON.stringify(record)).not.toMatch(/thinking|private/);
    expect(JSON.stringify(record)).toContain('Visible');
    expect(
      visibleRecord('codex', {
        type: 'item.completed',
        item: { type: 'reasoning', text: 'private' },
      }),
    ).toBeNull();
    expect(
      providerMetrics(
        'claude',
        JSON.stringify({
          type: 'result',
          usage: {
            input_tokens: 5,
            cache_read_input_tokens: 20,
            cache_creation_input_tokens: 7,
            output_tokens: 3,
          },
        }),
      ),
    ).toMatchObject({
      inputTokens: 32,
      cachedInputTokens: 20,
      cacheCreationInputTokens: 7,
      outputTokens: 3,
      nonCachedTokens: 15,
    });
    expect(
      providerMetrics('claude', JSON.stringify(record)).inputTokens,
    ).toBeNull();
    expect(
      claudeArguments({ settings: '/tmp/settings.json', sessionId: 'id' }).join(
        ' ',
      ),
    ).not.toMatch(/bypass|skip-permissions/);
  });
  it('serializes session reservations, prevents reruns, and enforces the total cap', async () => {
    const root = await temporary();
    await writeFile(path.join(root, 'sessions.json'), '[]');
    const sessions = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        reserveSession(root, `case-${index}`, 'codex', 'receiver'),
      ),
    );
    expect(new Set(sessions.map((session) => session.number)).size).toBe(12);
    await expect(
      reserveSession(root, 'case-0', 'codex', 'receiver'),
    ).rejects.toThrow('reruns');
    await expect(
      reserveSession(root, 'extra', 'claude', 'receiver'),
    ).rejects.toThrow('exhausted');
  });
  it('rejects a different provider using a scoped capture grant', async () => {
    const root = await createRepository();
    roots.push(root);
    await initializeProject(root);
    const state = await startTask(root, 'Capture test');
    await setContextConsent(root, state.sessionId, true);
    const issued = (await issueCaptureGrant(root, {
      taskId: state.sessionId,
      runId: 'run',
      workspace: root,
      provider: 'claude',
      providerSessionId: 'thread',
      launchGitFingerprint: 'anchor',
    }))!;
    await expect(
      appendCapturedObservation(root, state.sessionId, 'run', issued.token, {
        kind: 'session_start',
        provider: 'codex',
        providerSessionId: 'thread',
        hook: 'exec.thread.started',
        text: 'Start',
        redacted: false,
        truncated: false,
      }),
    ).rejects.toThrow('provider');
  });
  const itNativeBenchmark = it.skipIf(process.platform === 'win32');
  // Live execution of this benchmark harness and its launcher fixtures are POSIX-only.
  itNativeBenchmark(
    'captures both real process shapes and gives paired receivers identical frozen inputs without calling a model',
    async () => {
      const root = await temporary();
      const workflowModule = new URL(
        '../../benchmarks/continuity/workflows.mjs',
        import.meta.url,
      ).href;
      const fake = path.join(root, 'fake.mjs');
      await writeFile(
        fake,
        `import { readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { WORKFLOWS } from ${JSON.stringify(workflowModule)};
const provider = process.env.TEST_PROVIDER;
if (process.argv.includes('--version')) { console.log('fake-' + provider); process.exit(0); }
let prompt = ''; for await (const chunk of process.stdin) prompt += chunk;
const task = WORKFLOWS.find(task => prompt.includes(task.request));
if (!task) throw new Error('Unknown fake task');
const predecessor = prompt.startsWith(task.request);
const session = process.argv.includes('--session-id') ? process.argv[process.argv.indexOf('--session-id') + 1] : 'fake-thread';
const emit = value => process.stdout.write(JSON.stringify(value) + '\\n');
async function hook(event) {
  const settings = JSON.parse(await readFile(process.argv[process.argv.indexOf('--settings') + 1], 'utf8'));
  const handler = settings.hooks[event.hook_event_name][0].hooks[0];
  await new Promise((resolve,reject) => { const child = spawn(handler.command,handler.args,{stdio:['pipe','pipe','pipe']}); let error='';child.stderr.on('data',chunk=>error+=chunk);child.once('exit',code=>code===0?resolve():reject(new Error(error)));child.stdin.end(JSON.stringify({session_id:session,cwd:process.cwd(),...event})); });
}
if (predecessor) {
  if (provider === 'claude') {
    await hook({hook_event_name:'SessionStart',source:'startup'});
    await hook({hook_event_name:'UserPromptSubmit',prompt});
    await hook({hook_event_name:'PreToolUse',tool_name:'Write',tool_use_id:'edit',tool_input:{file_path:task.firstStage}});
    await writeFile(task.firstStage,task.reference[task.firstStage]);
    await hook({hook_event_name:'PostToolUse',tool_name:'Write',tool_use_id:'edit',tool_input:{file_path:task.firstStage},tool_response:{success:true}});
    emit({type:'assistant',message:{content:[{type:'text',text:'Stage edited.'}]}});
  } else {
    emit({type:'thread.started',thread_id:session});
    await writeFile(task.firstStage,task.reference[task.firstStage]);
    emit({type:'item.completed',item:{id:'patch',type:'file_change',status:'completed',changes:[{path:task.firstStage,kind:'update'}]}});
  }
  setInterval(()=>{},1000);
} else {
  for (const [name,text] of Object.entries(task.reference)) await writeFile(name,text);
  if (provider === 'claude') { emit({type:'system',subtype:'init',model:'fake-sonnet'});emit({type:'result',is_error:false,usage:{input_tokens:10,cache_read_input_tokens:0,cache_creation_input_tokens:0,output_tokens:5}}); }
  else { emit({type:'thread.started',thread_id:session});emit({type:'turn.completed',usage:{input_tokens:10,cached_input_tokens:0,output_tokens:5}}); }
}
`,
      );
      for (const provider of ['claude', 'codex']) {
        const wrapper = path.join(root, provider);
        await writeFile(
          wrapper,
          `#!/bin/sh\nTEST_PROVIDER=${provider} exec ${JSON.stringify(process.execPath)} ${JSON.stringify(fake)} "$@"\n`,
        );
        await chmod(wrapper, 0o700);
      }
      vi.stubEnv('PATH', `${root}${path.delimiter}${process.env.PATH}`);
      const runtimeCheck = async () => ({ simulated: true });
      const run = await createRun(path.join(root, 'run'), { runtimeCheck });
      for (const index of [0, 1]) {
        const row = await runCase(run, index, { runtimeCheck });
        expect(row.captureQualified).toBe(true);
        expect(row.arms).toHaveLength(2);
        expect(new Set(row.arms.map((arm) => arm.checkpointHash)).size).toBe(1);
        expect(
          row.arms.every((arm) => arm.evidenceIntact && !arm.execution.failed),
        ).toBe(true);
      }
      const report = await finalize(run);
      expect(report.providerSessions).toBe(6);
      expect(
        report.cases.every(
          (row) =>
            !row.checkpointGrading.passed &&
            row.arms.every((arm) => arm.correct),
        ),
      ).toBe(true);
      const ledger = JSON.parse(
        await readFile(path.join(run, 'sessions.json'), 'utf8'),
      );
      expect(
        ledger.filter((entry) => entry.role === 'predecessor'),
      ).toHaveLength(2);
    },
    60000,
  );
});
