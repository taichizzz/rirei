import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, realpath, statfs } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { rireiDataHome } from '../../src/platform/runtime-paths.ts';

const execute = promisify(execFile);
async function deadline(operation, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      operation(),
      new Promise((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              Object.assign(new Error('Runtime I/O exceeded its deadline.'), {
                code: 'RUNTIME_IO_TIMEOUT',
              }),
            ),
          Math.max(1, timeoutMs),
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
export const DEFAULT_RUNTIME_POLICY = Object.freeze({
  minimumFreeBytes: 2 * 1024 ** 3,
  artifactBytesPerSession: 24 * 1024 ** 2,
  reserveMultiplier: 10,
  probeTimeoutMs: 3000,
});
export async function boundedRead(
  file,
  { maximumBytes = 32 * 1024 ** 2, timeoutMs = 3000 } = {},
) {
  let timer;
  const operation = (async () => {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > maximumBytes)
      throw Object.assign(
        new Error('Benchmark input is not a bounded regular file.'),
        { code: 'RUNTIME_INPUT_LIMIT' },
      );
    const handle = await open(file, 'r');
    try {
      const output = Buffer.alloc(Math.min(info.size + 1, maximumBytes + 1));
      let length = 0;
      while (length < output.length) {
        const result = await handle.read(
          output,
          length,
          output.length - length,
          null,
        );
        if (!result.bytesRead) break;
        length += result.bytesRead;
      }
      if (length > maximumBytes || length !== info.size)
        throw Object.assign(
          new Error('Benchmark input changed or exceeded its limit.'),
          { code: 'RUNTIME_INPUT_CHANGED' },
        );
      return output.subarray(0, length);
    } finally {
      await handle.close();
    }
  })();
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              Object.assign(
                new Error('Benchmark input read exceeded its deadline.'),
                { code: 'RUNTIME_READ_TIMEOUT' },
              ),
            ),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
export function benchmarkRuntimeHome({ env = process.env, ...options } = {}) {
  const p =
    (options.platform ?? process.platform) === 'win32'
      ? path.win32
      : path.posix;
  const override = env.RIREI_BENCHMARK_HOME?.trim();
  if (override) {
    if (!p.isAbsolute(override))
      throw new Error('RIREI_BENCHMARK_HOME must be absolute.');
    return p.resolve(override);
  }
  return p.join(rireiDataHome({ ...options, env }), 'benchmarks');
}

export async function newBenchmarkRun(output) {
  const requested = output
    ? path.resolve(output)
    : path.join(benchmarkRuntimeHome(), `run-${randomUUID()}`);
  if (!output)
    await mkdir(path.dirname(requested), { recursive: true, mode: 0o700 });
  const parent = await lstat(path.dirname(requested));
  if (!parent.isDirectory() || parent.isSymbolicLink())
    throw new Error('Benchmark parent must be a real directory.');
  await mkdir(requested, { mode: 0o700 });
  return realpath(requested);
}

export async function preflightRuntime({
  workspace,
  logs,
  archive = logs,
  remainingSessions = 1,
  bytesToMaterialize = 0,
  policy = {},
  inspect = statfs,
  probe,
} = {}) {
  const settings = { ...DEFAULT_RUNTIME_POLICY, ...policy };
  for (const value of Object.values(settings))
    if (!Number.isSafeInteger(value) || value < 0)
      throw new Error('Invalid runtime policy.');
  if (
    !Number.isSafeInteger(remainingSessions) ||
    remainingSessions < 0 ||
    !Number.isSafeInteger(bytesToMaterialize) ||
    bytesToMaterialize < 0
  )
    throw new Error('Invalid runtime allowance.');
  const requiredBytes = Math.max(
    settings.minimumFreeBytes,
    settings.reserveMultiplier *
      (settings.artifactBytesPerSession * remainingSessions +
        bytesToMaterialize),
  );
  const started = performance.now();
  const targets = [];
  const unique = new Set();
  for (const requested of [workspace, logs, archive]) {
    if (!requested)
      throw new Error('Runtime preflight requires workspace/log directories.');
    const directory = await deadline(
      () => realpath(requested),
      settings.probeTimeoutMs,
    );
    if (unique.has(directory)) continue;
    unique.add(directory);
    const fs = await deadline(
      () => inspect(directory),
      settings.probeTimeoutMs,
    );
    const availableBytes = Number(fs.bavail) * Number(fs.bsize);
    if (availableBytes < requiredBytes)
      throw Object.assign(
        new Error('Insufficient runtime storage before provider launch.'),
        { code: 'RUNTIME_SPACE', availableBytes, requiredBytes },
      );
    const name = `.rirei-probe-${randomUUID()}`;
    const result = await deadline(
      async () =>
        probe
          ? probe(directory, name, settings.probeTimeoutMs)
          : JSON.parse(
              (
                await execute(
                  process.execPath,
                  [
                    fileURLToPath(
                      new URL('./runtime-probe.mjs', import.meta.url),
                    ),
                    directory,
                    name,
                  ],
                  {
                    timeout: Math.max(1, settings.probeTimeoutMs),
                    maxBuffer: 16384,
                    windowsHide: true,
                  },
                )
              ).stdout,
            ),
      settings.probeTimeoutMs,
    );
    targets.push({ directory, availableBytes, requiredBytes, probe: result });
  }
  return { policy: settings, elapsedMs: performance.now() - started, targets };
}
