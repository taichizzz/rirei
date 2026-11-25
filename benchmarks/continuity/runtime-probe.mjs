import { open, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

// Invoked only by the benchmark preflight; no providers or project commands run here.
const [directory, name] = process.argv.slice(2);
if (!directory || !/^\.rirei-probe-[a-f0-9-]{36}$/.test(name ?? ''))
  throw new Error('Invalid runtime probe.');
const file = path.join(directory, name);
const expected = Buffer.from('rirei-runtime-probe\n'.repeat(32));
let handle;
let owned = false;
const started = performance.now();
try {
  handle = await open(file, 'wx', 0o600);
  owned = true;
  await handle.writeFile(expected);
  await handle.sync();
  await handle.close();
  handle = null;
  const actual = await readFile(file);
  if (!actual.equals(expected))
    throw new Error('Runtime probe readback mismatch.');
  process.stdout.write(
    JSON.stringify({
      bytes: expected.length,
      elapsedMs: performance.now() - started,
    }),
  );
} finally {
  await handle?.close();
  if (owned) await rm(file, { force: true });
}
