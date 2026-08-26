import { describe, expect, it } from 'vitest';
import { createTerminalHost } from '../../src/terminal/terminal-host.js';

describe('terminal host', () => {
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
