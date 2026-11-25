import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CASES,
  reserveSession,
} from '../../benchmarks/continuity/bidirectional.mjs';
import {
  finalizeReceivers,
  prepareReceivers,
  runReceiverPair,
} from '../../benchmarks/continuity/receivers.mjs';
import {
  fingerprint,
  WORKFLOWS,
  workflowHash,
  writeFiles,
} from '../../benchmarks/continuity/workflows.mjs';
import {
  contextEventSchema,
  contextObservationSchema,
} from '../../src/context/schema.js';
import { hash } from '../../src/context/store.js';
import '../helpers.js';

const roots: string[] = [];
const runtimeCheck = async () => ({ simulated: true });
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    roots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true, maxRetries: 5 })),
  );
});

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rirei-receiver-retest-'));
  roots.push(root);
  const source = path.join(root, 'source');
  await mkdir(source);
  const cases = [];
  for (const [index, definition] of CASES.entries()) {
    const task = WORKFLOWS.find((task) => task.id === definition.task)!;
    const files = Object.fromEntries(
      Object.entries({
        ...task.files,
        [task.firstStage]: task.reference[task.firstStage],
      }).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    );
    const unsigned = contextEventSchema.omit({ hash: true }).parse({
      kind: 'prompt_submission',
      provider: definition.predecessor,
      providerSessionId: 'source-thread',
      hook: 'fixture',
      text: [task.request, ...task.requirements].join('\n'),
      redacted: false,
      truncated: false,
      schemaVersion: 1,
      id: `e-${String(index).padStart(32, '0')}`,
      sequence: 1,
      receivedAt: '2020-01-01T00:00:00.000Z',
      taskId: 'source-task',
      runId: 'source-run',
      workspace: '0'.repeat(64),
      launchGitFingerprint: 'original-anchor',
      previousHash: '0'.repeat(64),
    });
    const events = [{ ...unsigned, hash: hash(JSON.stringify(unsigned)) }];
    const base = path.join(
      source,
      `case-${index}-${task.id}-${definition.predecessor}-to-${definition.receiver}`,
    );
    await writeFiles(base, {
      'frozen-files.json': JSON.stringify(files),
      'frozen-history.json': JSON.stringify(events),
    });
    cases.push({
      index,
      task: task.id,
      predecessor: {
        provider: definition.predecessor,
        interruptedByHarness: true,
      },
      receiver: definition.receiver,
      captureQualified: true,
      checkpointGrading: { passed: false },
      checkpointHash: fingerprint(JSON.stringify(files)),
      historyHash: fingerprint(
        JSON.stringify(
          events.map((event) => contextObservationSchema.parse(event)),
        ),
      ),
    });
  }
  const report = {
    mode: 'real-bidirectional-predecessor-pilot',
    cases,
    protocol: {
      models: {
        codex: { model: 'gpt-5.6-sol', effort: 'low' },
        claude: { model: 'sonnet', effort: 'low' },
      },
      fixtureHashes: Object.fromEntries(
        WORKFLOWS.map((task) => [task.id, workflowHash(task)]),
      ),
    },
  };
  const bytes = JSON.stringify(report);
  await writeFile(path.join(source, 'report.json'), bytes);
  const fake = path.join(root, 'fake.mjs');
  await writeFile(
    fake,
    `import { writeFile } from 'node:fs/promises';
import { WORKFLOWS } from ${JSON.stringify(new URL('../../benchmarks/continuity/workflows.mjs', import.meta.url).href)};
const provider = process.env.TEST_PROVIDER;
if (process.argv.includes('--version')) { console.log('fake-' + provider); process.exit(0); }
let prompt = ''; for await (const chunk of process.stdin) prompt += chunk;
const emit = value => console.log(JSON.stringify(value));
if (process.env.TEST_FAIL === '1') { emit({type:'error',message:'fixture authentication failure'}); process.exit(1); }
const task = WORKFLOWS.find(task => prompt.includes(task.request));
for (const [name,text] of Object.entries(task.reference)) await writeFile(name,text);
if (provider === 'claude') { emit({type:'system',subtype:'init',model:'fake-sonnet'}); emit({type:'result',is_error:false,usage:{input_tokens:10,cache_read_input_tokens:0,cache_creation_input_tokens:0,output_tokens:2}}); }
else emit({type:'turn.completed',usage:{input_tokens:10,cached_input_tokens:0,output_tokens:2}});
if (process.env.TEST_STAY_ALIVE === '1') setInterval(() => {}, 1000);
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
  return {
    root,
    source,
    hash: fingerprint(bytes),
    output: path.join(root, 'run'),
  };
}

describe('frozen-checkpoint receiver retest', () => {
  // The live receiver harness explicitly excludes Windows. Source validation still runs there.
  const itNativeReceiver = it.skipIf(process.platform === 'win32');
  itNativeReceiver(
    'spends no launch on failed preflight and stops a fake provider immediately on a logger fault',
    async () => {
      const context = await setup();
      await prepareReceivers(context.source, context.output, context.hash, {
        runtimeCheck,
      });
      await expect(
        runReceiverPair(context.output, 0, {
          runtimeCheck: async () => {
            throw new Error('storage preflight failed');
          },
        }),
      ).rejects.toThrow('storage preflight');
      expect(
        JSON.parse(
          await readFile(path.join(context.output, 'sessions.json'), 'utf8'),
        ),
      ).toEqual([]);
      vi.stubEnv('TEST_STAY_ALIVE', '1');
      const result = await runReceiverPair(context.output, 0, {
        runtimeCheck,
        traceOptions: { maxRecords: 0 },
      });
      expect(result.arms).toHaveLength(1);
      expect(result.arms[0].execution).toMatchObject({
        failed: true,
        timedOut: false,
        trace: { complete: false },
        metricIntegrity: 'observed-stream-incomplete',
      });
      expect(result.arms[0].execution.captureError).toContain(
        'TRACE_RECORD_LIMIT',
      );
      expect(
        JSON.parse(
          await readFile(path.join(context.output, 'sessions.json'), 'utf8'),
        ),
      ).toHaveLength(1);
      await expect(runReceiverPair(context.output, 1)).rejects.toThrow(
        'stopped',
      );
    },
    60000,
  );
  itNativeReceiver(
    'prepares eight paired inputs, runs only fake receivers, and preserves source evidence',
    async () => {
      const context = await setup();
      const prepared = await prepareReceivers(
        context.source,
        context.output,
        context.hash,
        { runtimeCheck },
      );
      expect(prepared).toMatchObject({
        preparedReceivers: 8,
        providerSessions: 0,
      });
      expect(
        JSON.parse(
          await readFile(path.join(context.output, 'sessions.json'), 'utf8'),
        ),
      ).toEqual([]);
      for (const [index, definition] of CASES.entries()) {
        const base = path.join(
          context.output,
          `case-${index}-${definition.task}-${definition.predecessor}-to-${definition.receiver}`,
        );
        const inputs = JSON.parse(
          await readFile(path.join(base, 'prepared.json'), 'utf8'),
        );
        expect(new Set(inputs.map((input) => input.checkpointHash)).size).toBe(
          1,
        );
        expect(new Set(inputs.map((input) => input.historyHash)).size).toBe(1);
        for (const input of inputs) {
          const prompt = await readFile(
            path.join(input.metadata, 'prompt.txt'),
            'utf8',
          );
          expect(prompt).toContain(
            `Current authorized workspace: ${JSON.stringify(input.directory)}`,
          );
          const task = WORKFLOWS.find((task) => task.id === definition.task)!;
          for (const requirement of task.requirements)
            expect(prompt).toContain(requirement);
        }
        const row = await runReceiverPair(context.output, index, {
          runtimeCheck,
        });
        expect(row.arms).toHaveLength(2);
        expect(
          row.arms.every((arm) => arm.evidenceIntact && !arm.execution.failed),
        ).toBe(true);
      }
      const report = await finalizeReceivers(context.output);
      expect(report).toMatchObject({
        providerSessions: 8,
        predecessorSessions: 0,
        receiverSessions: 8,
        reusedCheckpointCount: 4,
      });
      expect(
        report.cases.every((row) => row.arms.every((arm) => arm.correct)),
      ).toBe(true);
      expect(
        fingerprint(await readFile(path.join(context.source, 'report.json'))),
      ).toBe(context.hash);
      await expect(runReceiverPair(context.output, 0)).rejects.toThrow(
        'already been attempted',
      );
      await expect(
        reserveSession(context.output, 'extra', 'codex', 'receiver'),
      ).rejects.toThrow('8-session budget');
    },
    60000,
  );

  itNativeReceiver(
    'stops after a provider failure instead of rerunning or starting the paired receiver',
    async () => {
      const context = await setup();
      await prepareReceivers(context.source, context.output, context.hash, {
        runtimeCheck,
      });
      vi.stubEnv('TEST_FAIL', '1');
      const row = await runReceiverPair(context.output, 0, { runtimeCheck });
      expect(row.arms).toHaveLength(1);
      expect(row.arms[0].execution.failed).toBe(true);
      await expect(runReceiverPair(context.output, 1)).rejects.toThrow(
        'stopped',
      );
      expect(
        JSON.parse(
          await readFile(path.join(context.output, 'sessions.json'), 'utf8'),
        ),
      ).toHaveLength(1);
    },
    60000,
  );

  it('rejects a changed source report before preparing a new run', async () => {
    const context = await setup();
    await expect(
      prepareReceivers(context.source, context.output, '0'.repeat(64)),
    ).rejects.toThrow('Original report changed');
  });
});
