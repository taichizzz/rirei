import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getAgent } from '../../src/agents/registry.js';
import { InheritedProcessHost } from '../../src/process/inherited-process-host.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('inherited process host', () => {
  it.runIf(process.platform === 'win32')(
    'launches a resolved npm-style Windows command shim',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'rirei-cmd-shim-'));
      roots.push(root);
      const marker = path.join(root, 'launched.txt');
      await writeFile(
        path.join(root, 'claude.cmd'),
        '@echo off\r\n> "%RIREI_MARKER%" echo launched\r\nexit /b 0\r\n',
      );
      const previousPath = process.env.PATH;
      process.env.PATH = `${root}${path.delimiter}${previousPath ?? ''}`;
      try {
        const command = await getAgent('claude').buildInteractiveCommand({
          projectRoot: root,
          prompt: '',
        });
        expect(command.executable).toBe('claude');
        const host = new InheritedProcessHost();
        const handle = await host.start({
          command,
          cwd: root,
          env: { ...process.env, RIREI_MARKER: marker },
        });
        const result = await new Promise<{ exitCode: number | null }>(
          (resolve) =>
            host.subscribe(handle.id, (event) => {
              if (event.type === 'exit') resolve(event.result);
            }),
        );
        expect(result.exitCode).toBe(0);
        expect(await readFile(marker, 'utf8')).toContain('launched');
      } finally {
        if (previousPath === undefined) delete process.env.PATH;
        else process.env.PATH = previousPath;
      }
    },
  );
});
