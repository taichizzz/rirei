import { spawn } from 'node:child_process';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { terminalControlFrame } from '../../desktop/terminal-control.mjs';
import { sanitizeWorkspaceList } from '../../desktop/workspace-projection.mjs';

describe('desktop protocols', () => {
  test('uses newline-delimited PTY control frames', () => {
    expect(terminalControlFrame('interrupt')).toBe('{"action":"interrupt"}\n');
    expect(() => terminalControlFrame('unknown')).toThrow(/Invalid/);
  });

  test('projects the CLI workspace array and excludes claimed entries', () => {
    const result = sanitizeWorkspaceList(
      [
        {
          id: 'available',
          branch: 'rirei/available-implement-12345678',
          role: 'implement',
          status: 'ready',
          parentTaskId: 'task-1',
        },
        {
          id: 'claimed',
          branch: 'rirei/claimed-review-12345678',
          role: 'review',
          status: 'ready',
          parentTaskId: 'task-1',
        },
      ],
      {
        sessionId: 'task-1',
        runs: [],
        git: { currentBranch: 'feature/current' },
      },
      ['claimed', 'default'],
    );

    expect(result.mainClaimed).toBe(true);
    expect(result.mainBranchLabel).toBe('feature/current');
    expect(result.workspaces).toEqual([
      expect.objectContaining({
        id: 'available',
        selectable: true,
        branchLabel: 'rirei/available-implement-12345678',
      }),
      expect.objectContaining({ id: 'claimed', selectable: false }),
    ]);
  });

  test('interrupts the provider while leaving its controller alive to finalize', async () => {
    const controller = [
      "const { spawn } = require('node:child_process');",
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });",
      "console.log('READY');",
      "child.on('close', () => { console.log('FINALIZED'); process.exit(0); });",
    ].join(' ');
    const bridge = spawn(
      '/usr/bin/python3',
      [
        path.resolve('desktop/pty_bridge.py'),
        process.execPath,
        '-e',
        controller,
      ],
      { stdio: ['pipe', 'pipe', 'pipe', 'pipe'] },
    );
    let output = '';
    const completed = new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        bridge.kill('SIGKILL');
        reject(new Error('PTY bridge did not finalize after interrupt.'));
      }, 10_000);
      bridge.stdout.on('data', (data) => {
        output += data.toString();
        if (output.includes('READY'))
          bridge.stdio[3]!.write(terminalControlFrame('interrupt'));
      });
      bridge.once('error', reject);
      bridge.once('close', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });

    await expect(completed).resolves.toBe(0);
    expect(output).toContain('FINALIZED');
  });

  test('hosts a normal interactive shell in the PTY bridge', async () => {
    const bridge = spawn(
      '/usr/bin/python3',
      [path.resolve('desktop/pty_bridge.py'), '/bin/zsh', '-f'],
      {
        env: { ...process.env, RELAY_SIGNAL_PROCESS_GROUP: '1' },
        stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
      },
    );
    let output = '';
    bridge.stdout.on('data', (data) => {
      output += data.toString();
    });
    const completed = new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        bridge.kill('SIGKILL');
        reject(new Error('Interactive shell did not exit.'));
      }, 10_000);
      bridge.once('error', reject);
      bridge.once('close', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
    bridge.stdin.write("printf '__RIREI_SHELL_OK__\\n'; exit\n");

    await expect(completed).resolves.toBe(0);
    expect(output).toContain('__RIREI_SHELL_OK__');
  });
});
