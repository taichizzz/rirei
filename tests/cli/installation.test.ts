import { execFile } from 'node:child_process';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { RIREI_VERSION } from '../../src/version.js';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../../src/index.ts', import.meta.url));
const loader = new URL(
  '../../node_modules/tsx/dist/loader.mjs',
  import.meta.url,
).href;

describe('installed-package diagnostics', () => {
  it('checks native dependencies without initializing a project or opting into analytics', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'rirei installation '));
    const data = path.join(root, 'data');
    try {
      const result = await exec(
        process.execPath,
        ['--import', loader, cli, 'doctor', '--installation', '--json'],
        {
          cwd: root,
          env: { ...process.env, RIREI_DATA_HOME: data },
          encoding: 'utf8',
        },
      );
      expect(JSON.parse(result.stdout)).toMatchObject({
        schemaVersion: 1,
        version: RIREI_VERSION,
        ok: true,
        terminal: { status: 'ready' },
        tokenCollector: { status: 'ready', version: '20.0.24' },
      });
      expect(result.stdout).not.toContain(root);
      await expect(access(data)).rejects.toHaveProperty('code', 'ENOENT');
      await expect(access(path.join(root, '.relay'))).rejects.toHaveProperty(
        'code',
        'ENOENT',
      );
      await expect(
        exec(process.execPath, ['--import', loader, cli, 'tui'], {
          cwd: root,
          env: { ...process.env, RIREI_DATA_HOME: data },
        }),
      ).rejects.toMatchObject({
        stderr: expect.stringContaining('requires an interactive terminal'),
      });
      await expect(access(data)).rejects.toHaveProperty('code', 'ENOENT');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
