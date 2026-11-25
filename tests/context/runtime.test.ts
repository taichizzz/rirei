import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  benchmarkRuntimeHome,
  boundedRead,
  newBenchmarkRun,
  preflightRuntime,
} from '../../benchmarks/continuity/runtime.mjs';
import { freezeControl } from '../../benchmarks/continuity/freeze-control.mjs';
import { measuredProviderMetrics } from '../../benchmarks/continuity/measurement.mjs';
import {
  fingerprint,
  writeFiles,
} from '../../benchmarks/continuity/workflows.mjs';
import { contextObservationSchema } from '../../src/context/schema.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function temporary() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rirei-runtime-'));
  roots.push(root);
  return root;
}

describe('local benchmark runtime', () => {
  it('uses platform application data defaults and an explicit absolute override', () => {
    expect(
      benchmarkRuntimeHome({ platform: 'darwin', home: '/home/test', env: {} }),
    ).toBe('/home/test/Library/Application Support/Rirei/benchmarks');
    expect(
      benchmarkRuntimeHome({ platform: 'linux', home: '/home/test', env: {} }),
    ).toBe('/home/test/.local/share/rirei/benchmarks');
    expect(
      benchmarkRuntimeHome({
        platform: 'win32',
        home: 'C:\\Users\\test',
        env: { LOCALAPPDATA: 'C:\\Local' },
      }),
    ).toBe('C:\\Local\\Rirei\\benchmarks');
    expect(() =>
      benchmarkRuntimeHome({ env: { RIREI_BENCHMARK_HOME: 'relative' } }),
    ).toThrow('absolute');
  });
  it('canonicalizes a new checkout and probes write/fsync/read/delete in a path with spaces', async () => {
    const parent = await temporary();
    const root = await newBenchmarkRun(path.join(parent, 'run with spaces'));
    const before = await readdir(root);
    const result = await preflightRuntime({
      workspace: root,
      logs: root,
      policy: { minimumFreeBytes: 0, reserveMultiplier: 0 },
    });
    expect(result.targets).toHaveLength(1);
    expect(result.targets[0].probe.bytes).toBeGreaterThan(0);
    expect(await readdir(root)).toEqual(before);
    await expect(newBenchmarkRun(root)).rejects.toThrow();
  });
  it('checks the log volume and remaining artifact allowance before any probe or launch', async () => {
    const root = await temporary();
    const logs = path.join(root, 'logs');
    await mkdir(logs);
    let probes = 0;
    await expect(
      preflightRuntime({
        workspace: root,
        logs,
        remainingSessions: 2,
        policy: {
          minimumFreeBytes: 0,
          artifactBytesPerSession: 1024,
          reserveMultiplier: 10,
        },
        inspect: async (directory) => ({
          bavail: directory.endsWith('logs') ? 1 : 100000,
          bsize: 1024,
        }),
        probe: async () => {
          probes++;
          return {};
        },
      }),
    ).rejects.toMatchObject({ code: 'RUNTIME_SPACE' });
    expect(probes).toBe(1);
  });
  it('bounds slow filesystem metadata and probe operations', async () => {
    const root = await temporary();
    await expect(
      preflightRuntime({
        workspace: root,
        logs: root,
        policy: { probeTimeoutMs: 10 },
        inspect: () => new Promise(() => {}),
      }),
    ).rejects.toMatchObject({ code: 'RUNTIME_IO_TIMEOUT' });
    await expect(
      preflightRuntime({
        workspace: root,
        logs: root,
        policy: { minimumFreeBytes: 0, probeTimeoutMs: 10 },
        probe: () => new Promise(() => {}),
      }),
    ).rejects.toMatchObject({ code: 'RUNTIME_IO_TIMEOUT' });
  });
  it('rejects oversized and symlinked inputs rather than following them', async () => {
    const root = await temporary();
    const file = path.join(root, 'input');
    await writeFile(file, 'a'.repeat(100));
    await expect(boundedRead(file, { maximumBytes: 10 })).rejects.toMatchObject(
      { code: 'RUNTIME_INPUT_LIMIT' },
    );
    if (process.platform !== 'win32') {
      const link = path.join(root, 'link');
      await symlink(file, link);
      await expect(boundedRead(link)).rejects.toThrow('regular file');
    }
    expect((await readFile(file, 'utf8')).length).toBe(100);
  });
});

async function controlFixture() {
  const root = await temporary();
  const source = path.join(root, 'source');
  const bundle = Buffer.from('frozen CLI source');
  const sourceName = '../../dist/index.cjs';
  const artifacts = path.join(source, 'artifacts');
  const prompt = 'Original frozen task';
  const trace =
    JSON.stringify({
      type: 'turn.completed',
      usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 3 },
    }) + '\n';
  const execution = {
    promptHash: fingerprint(prompt),
    metrics: measuredProviderMetrics('codex', trace),
  };
  await writeFiles(artifacts, {
    'prompt.txt': prompt,
    'stdout.jsonl': trace,
    'stderr.log': '',
    'command.json': '{"args":[]}',
    'execution.json': JSON.stringify(execution),
    'settings.json': '{}',
  });
  const files = { 'src/index.mjs': 'export const value = 1;\n' };
  const history = [
    contextObservationSchema.parse({
      kind: 'prompt_submission',
      provider: 'claude',
      providerSessionId: 'fixture',
      hook: 'fixture',
      text: prompt,
      redacted: false,
      truncated: false,
    }),
  ];
  const row = {
    index: 0,
    task: 'fixture',
    predecessor: { provider: 'claude' },
    receiver: 'codex',
    checkpointHash: fingerprint(JSON.stringify(files)),
    historyHash: fingerprint(JSON.stringify(history)),
    arms: [
      {
        arm: 'rirei',
        artifacts,
        execution,
        grading: { passed: true },
        correct: true,
      },
    ],
  };
  const report = {
    mode: 'frozen-checkpoint-receiver-retest',
    providerSessions: 1,
    protocol: {
      sourceHashes: { [sourceName]: fingerprint(bundle) },
      versions: {},
      models: {},
    },
    cases: [row],
  };
  const bytes = Buffer.from(JSON.stringify(report));
  await writeFiles(source, {
    'report.json': bytes.toString(),
    'protocol.json': JSON.stringify(report.protocol),
    'sessions.json': '[{"key":"0/rirei"}]',
    'tested-source-manifest.json': JSON.stringify([
      { name: sourceName, sha256: fingerprint(bundle) },
    ]),
    'tested-source/dist/index.cjs': bundle.toString(),
    'case-0-fixture-claude-to-codex/frozen-files.json': JSON.stringify(files),
    'case-0-fixture-claude-to-codex/frozen-history.json':
      JSON.stringify(history),
  });
  return { root, source, hash: fingerprint(bytes) };
}

describe('frozen control archive', () => {
  it('copies independently verified as-tested code, settings, inputs and traces into a new archive', async () => {
    const fixture = await controlFixture();
    const output = path.join(fixture.root, 'control');
    const result = await freezeControl(fixture.source, output, fixture.hash);
    expect(result).toMatchObject({
      complete: true,
      providerSessions: 0,
      sourceReportHash: fixture.hash,
    });
    const persisted = JSON.parse(
      await readFile(path.join(output, 'control-manifest.json'), 'utf8'),
    );
    for (const file of persisted.files)
      expect(fingerprint(await readFile(path.join(output, file.path)))).toBe(
        file.sha256,
      );
    await writeFile(
      path.join(fixture.source, 'tested-source/dist/index.cjs'),
      'moving active version',
    );
    expect(
      await readFile(path.join(output, 'tested-source/dist/index.cjs'), 'utf8'),
    ).toBe('frozen CLI source');
  });
  it('detects corrupt archived code and never publishes a complete manifest for a partial copy', async () => {
    const fixture = await controlFixture();
    const output = path.join(fixture.root, 'broken');
    await writeFile(
      path.join(fixture.source, 'tested-source/dist/index.cjs'),
      'corrupted',
    );
    await expect(
      freezeControl(fixture.source, output, fixture.hash),
    ).rejects.toThrow('Archived source changed');
    await expect(
      readFile(path.join(output, 'control-manifest.json')),
    ).rejects.toThrow();
  });
});
