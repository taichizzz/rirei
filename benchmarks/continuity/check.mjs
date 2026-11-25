import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs, promisify } from 'node:util';

const execute = promisify(execFile);
const fixtures = JSON.parse(
  await readFile(new URL('./fixtures.json', import.meta.url), 'utf8'),
);
const protocol = JSON.parse(
  await readFile(new URL('./protocol.json', import.meta.url), 'utf8'),
);
const { values } = parseArgs({
  options: { fixture: { type: 'string' }, workspace: { type: 'string' } },
});
if (values.workspace && !values.fixture)
  throw new Error('--workspace requires an exact --fixture ID.');
const selected = values.fixture
  ? fixtures.filter((item) => item.id === values.fixture)
  : fixtures;
if (!selected.length) throw new Error('Unknown continuity fixture.');
const temporary = await mkdtemp(
  path.join(os.tmpdir(), 'rirei-continuity-fixtures-'),
);

function initialFiles(fixture) {
  return {
    'README.md': `# Interrupted task\n\n${fixture.request}\n`,
    'package.json':
      JSON.stringify({ private: true, type: 'module', dependencies: {} }) +
      '\n',
    'src/index.mjs': fixture.snapshot,
  };
}

async function grade(fixture, workspace, label) {
  // Acceptance checks live outside the candidate repository and never mutate it.
  const driver = path.join(temporary, `${fixture.id}-${label}.mjs`);
  await writeFile(
    driver,
    `
    import assert from 'node:assert/strict';
    import { readFile } from 'node:fs/promises';
    const api = await import(${JSON.stringify(pathToFileURL(path.join(workspace, 'src/index.mjs')).href)});
    const manifest = JSON.parse(await readFile(${JSON.stringify(path.join(workspace, 'package.json'))}, 'utf8'));
    ${fixture.id === 'late-requirement' ? `for (const key of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) assert.deepEqual(manifest[key] ?? {}, {}, 'The user prohibited new dependencies');` : ''}
    ${fixture.checks}
  `,
  );
  try {
    await execute(process.execPath, [driver], {
      cwd: workspace,
      timeout: 10_000,
    });
    return { passed: true };
  } catch (error) {
    if (error.killed) throw new Error('Continuity acceptance check timed out.');
    return { passed: false };
  }
}

try {
  const results = [];
  for (const fixture of selected) {
    assert.match(fixture.id, /^[a-z-]+$/);
    const files = initialFiles(fixture);
    const inputHash = createHash('sha256')
      .update(JSON.stringify({ files, events: fixture.events }))
      .digest('hex');
    assert.equal(
      inputHash,
      protocol.fixtureInputHashes[fixture.id],
      `${fixture.id}: input differs from the frozen protocol`,
    );
    if (values.workspace) {
      const result = await grade(
        fixture,
        path.resolve(values.workspace),
        'candidate',
      );
      results.push({ id: fixture.id, inputHash, ...result });
      continue;
    }
    const workspace = path.join(temporary, fixture.id);
    await mkdir(path.join(workspace, 'src'), { recursive: true });
    for (const [name, contents] of Object.entries(files))
      await writeFile(path.join(workspace, name), contents);
    const interrupted = await grade(fixture, workspace, 'interrupted');
    assert.equal(
      interrupted.passed,
      false,
      `${fixture.id}: interrupted snapshot must expose unfinished work`,
    );
    await writeFile(path.join(workspace, 'src/index.mjs'), fixture.reference);
    const reference = await grade(fixture, workspace, 'reference');
    assert.equal(
      reference.passed,
      true,
      `${fixture.id}: reference must satisfy its acceptance checks`,
    );
    results.push({
      id: fixture.id,
      inputHash,
      referencePassed: true,
      interruptedRejected: true,
    });
  }
  process.stdout.write(
    `${JSON.stringify({ mode: values.workspace ? 'candidate-grading' : 'offline-fixture-validation', providerCalls: 0, results }, null, 2)}\n`,
  );
  if (results.some((result) => result.passed === false)) process.exitCode = 1;
} finally {
  await rm(temporary, { recursive: true, force: true, maxRetries: 5 });
}
