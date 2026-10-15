import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { createTerminalHost } from '../../src/terminal/terminal-host.js';

describe('terminal host', () => {
  it
    .skipIf(process.platform !== 'win32')
    .each([
      '../../src/terminal/terminal-host.ts',
      '../../desktop/terminal-host.mjs',
    ])(
    'releases ConPTY workers after natural exit in %s',
    async (modulePath) => {
      const moduleUrl = new URL(modulePath, import.meta.url).href;
      const { stdout } = await promisify(execFile)(
        process.execPath,
        [
          '--import',
          'tsx',
          '--eval',
          `
          (async () => {
            const { createTerminalHost } = await import(${JSON.stringify(moduleUrl)});
          const host = await createTerminalHost(process.execPath, ['-e', 'console.log("NATURAL_EXIT")'], {
            cwd: process.cwd(), cols: 80, rows: 24,
          });
          host.onData(data => process.stdout.write(data));
            host.onExit(({ exitCode }) => console.log('HOST_EXIT_' + exitCode));
          })();
        `,
        ],
        { cwd: process.cwd(), timeout: 20_000 },
      );
      expect(stdout).toContain('NATURAL_EXIT');
      expect(stdout).toContain('HOST_EXIT_0');
    },
  );

  it('spawns a process, streams output, and reports exit', async () => {
    const marker = 'rirei_host_test_marker_12345';
    const host = createTerminalHost(
      process.execPath,
      ['-e', `console.log("${marker}")`],
      {
        cwd: process.cwd(),
        cols: 80,
        rows: 24,
      },
    );

    expect(host.pid).toBeGreaterThan(0);

    let output = '';
    const receivedMarker = new Promise<void>((resolve) => {
      host.onData((data) => {
        output += Buffer.from(data).toString('utf8');
        if (output.includes(marker)) resolve();
      });
    });

    const exitPromise = new Promise<{ exitCode: number | null }>((resolve) => {
      host.onExit((result) => resolve(result));
    });

    await receivedMarker;
    const exitResult = await exitPromise;
    expect(exitResult.exitCode).toBe(0);
    expect(output).toContain(marker);
  });

  it('handles terminal resize and write without throwing', async () => {
    const host = createTerminalHost(
      process.execPath,
      ['-e', 'setTimeout(() => process.exit(0), 200)'],
      {
        cwd: process.cwd(),
        cols: 80,
        rows: 24,
      },
    );

    host.resize(120, 40);
    await expect(host.write('test\n')).resolves.toBeUndefined();

    const exitResult = await new Promise<{ exitCode: number | null }>(
      (resolve) => {
        host.onExit((result) => resolve(result));
      },
    );
    expect(exitResult.exitCode).toBe(0);
  });
});
