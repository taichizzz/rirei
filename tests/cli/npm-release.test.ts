import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createRepository, removeRepository } from '../helpers.js';

const exec = promisify(execFile);
const validator = fileURLToPath(
  new URL('../../scripts/prepare-npm-release.mjs', import.meta.url),
);
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeRepository));
});

async function fixture() {
  const root = await createRepository();
  roots.push(root);
  const version = '0.1.0-alpha.5.1';
  const manifest = {
    name: '@taichizzz/rirei',
    version,
    publishConfig: { access: 'public', tag: 'alpha' },
  };
  for (const dir of ['dist', 'src', 'desktop', 'scripts'])
    await mkdir(path.join(root, dir));
  await writeFile(path.join(root, 'package.json'), JSON.stringify(manifest));
  await writeFile(
    path.join(root, 'package-lock.json'),
    JSON.stringify({ version, packages: { '': { version } } }),
  );
  await writeFile(
    path.join(root, 'desktop', 'package.json'),
    JSON.stringify({ version }),
  );
  await writeFile(
    path.join(root, 'src', 'version.ts'),
    `export const RIREI_VERSION = '${version}';\n`,
  );
  await writeFile(
    path.join(root, 'scripts', 'install-windows.ps1'),
    `[string]$Version = '${version}'\n`,
  );
  await writeFile(
    path.join(root, 'dist', 'index.cjs'),
    `process.stdout.write('${version}\\n');\n`,
  );
  for (const args of [
    ['add', '.'],
    ['commit', '-qm', 'Prepare fixture'],
    ['update-ref', 'refs/remotes/origin/main', 'HEAD'],
    ['tag', `v${version}`],
  ]) {
    await exec('git', args, { cwd: root });
  }
  return { root, manifest, tag: `v${version}` };
}

describe('alpha publication guard', () => {
  it('validates the exact alpha tag and compiled version on main', async () => {
    const { root, tag } = await fixture();
    const result = await exec(process.execPath, [validator, tag], {
      cwd: root,
    });
    expect(result.stdout).toContain('for the alpha dist-tag');
  });

  it('rejects mismatched tags, latest dist-tags, and unmerged release commits', async () => {
    const { root, manifest, tag } = await fixture();
    await expect(
      exec(process.execPath, [validator, 'v0.1.0-alpha.9.0'], { cwd: root }),
    ).rejects.toHaveProperty('code', 1);
    await writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({
        ...manifest,
        publishConfig: { access: 'public', tag: 'latest' },
      }),
    );
    await expect(
      exec(process.execPath, [validator, tag], { cwd: root }),
    ).rejects.toHaveProperty('code', 1);
    await writeFile(path.join(root, 'package.json'), JSON.stringify(manifest));
    await exec('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD~1'], {
      cwd: root,
    });
    await expect(
      exec(process.execPath, [validator, tag], { cwd: root }),
    ).rejects.toHaveProperty('code', 1);
  });
});
