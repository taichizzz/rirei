import { describe, expect, it } from 'vitest';
import {
  defaultInteractiveShell,
  shellCommand,
} from '../../src/platform/shell.js';

describe('interactive shell resolution', () => {
  it('selects Windows shell based on env and defaults', () => {
    const pwsh = defaultInteractiveShell({
      platform: 'win32',
      env: { SHELL: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe' },
    });
    expect(pwsh.executable).toBe('C:\\Program Files\\PowerShell\\7\\pwsh.exe');
    expect(pwsh.args).toEqual(['-NoLogo']);

    const cmd = defaultInteractiveShell({
      platform: 'win32',
      env: { COMSPEC: 'C:\\Windows\\System32\\cmd.exe' },
    });
    expect(cmd.executable).toBe('C:\\Windows\\System32\\cmd.exe');
    expect(cmd.args).toEqual([]);
  });

  it('selects Unix shell with login flag', () => {
    const shell = defaultInteractiveShell({
      platform: 'linux',
      env: { SHELL: process.execPath },
    });
    expect(shell.executable).toBe(process.execPath);
    expect(shell.args).toEqual(['-l']);
  });

  it('builds shell command for user-selected shells', () => {
    const customPwsh = shellCommand('pwsh.exe', { platform: 'win32' });
    expect(customPwsh).toEqual({
      executable: 'pwsh.exe',
      args: ['-NoLogo'],
    });

    const customCmd = shellCommand('cmd.exe', { platform: 'win32' });
    expect(customCmd).toEqual({
      executable: 'cmd.exe',
      args: [],
    });

    const customUnix = shellCommand('/bin/bash', { platform: 'linux' });
    expect(customUnix).toEqual({
      executable: '/bin/bash',
      args: ['-l'],
    });
  });
});
