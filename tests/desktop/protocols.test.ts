import { spawn } from 'node:child_process';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  parseTerminalProtocolFrame,
  terminalControlFrame,
} from '../../desktop/terminal-control.mjs';
import { sanitizeWorkspaceList } from '../../desktop/workspace-projection.mjs';

function processAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('desktop protocols', () => {
  test('uses newline-delimited PTY control frames', () => {
    expect(terminalControlFrame('interrupt')).toBe(
      '{"version":1,"action":"interrupt"}\n',
    );
    expect(
      parseTerminalProtocolFrame(
        '{"version":1,"type":"ready","bridgePid":123}',
      ),
    ).toMatchObject({ type: 'ready', bridgePid: 123 });
    expect(
      parseTerminalProtocolFrame('{"version":2,"type":"ready"}'),
    ).toBeNull();
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
      { stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'] },
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
        stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'],
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

  test('reports parent control loss and stops descendants', async () => {
    const leaf = `setInterval(() => {}, 1000)`;
    const supervisor = [
      "const { spawn } = require('node:child_process');",
      `const leaf = spawn(process.execPath, ['-e', ${JSON.stringify(leaf)}], { stdio: 'ignore' });`,
      "process.on('SIGINT', () => {}); process.on('SIGTERM', () => {});",
      "console.log('LEAF_PID:' + leaf.pid);",
      'setInterval(() => {}, 1000);',
    ].join(' ');
    const controller = [
      "const { spawn } = require('node:child_process');",
      `const child = spawn(process.execPath, ['-e', ${JSON.stringify(supervisor)}], { stdio: 'inherit' });`,
      "process.on('SIGHUP', () => {}); process.on('SIGINT', () => {}); process.on('SIGTERM', () => {});",
      "console.log('CONTROLLER_READY');",
      "child.on('close', () => process.exit(0));",
    ].join(' ');
    const bridge = spawn(
      '/usr/bin/python3',
      [
        path.resolve('desktop/pty_bridge.py'),
        process.execPath,
        '-e',
        controller,
      ],
      {
        env: { ...process.env, RELAY_SIGNAL_PROCESS_GROUP: '0' },
        stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'],
      },
    );
    let frames = '';
    let output = '';
    let closedControl = false;
    const closeControlWhenReady = () => {
      if (
        !closedControl &&
        frames.includes('"type": "ready"') &&
        output.includes('CONTROLLER_READY')
      ) {
        closedControl = true;
        bridge.stdio[3]!.end();
      }
    };
    bridge.stdio[4]!.on('data', (chunk) => {
      frames += chunk.toString();
      closeControlWhenReady();
    });
    bridge.stdout.on('data', (chunk) => {
      output += chunk.toString();
      closeControlWhenReady();
    });
    const completed = new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        bridge.kill('SIGKILL');
        reject(new Error('Bridge did not stop descendants after parent loss.'));
      }, 10_000);
      bridge.once('error', reject);
      bridge.once('close', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
    await expect(completed).resolves.toBe(0);
    expect(frames).toContain('"type": "parent_lost"');
    const leafPid = Number(/LEAF_PID:(\d+)/.exec(output)?.[1]);
    expect(Number.isInteger(leafPid)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const survived = processAlive(leafPid);
    if (survived) process.kill(leafPid, 'SIGKILL');
    expect(survived).toBe(false);
  });
});
