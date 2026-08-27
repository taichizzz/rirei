import { existsSync } from 'node:fs';

export interface InteractiveShell {
  readonly executable: string;
  readonly args: string[];
}

export interface ShellOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

/**
 * Return default interactive shell configuration for the current platform.
 *
 * Windows priority:
 * 1. `pwsh.exe` (PowerShell 7)
 * 2. `powershell.exe` (Windows PowerShell)
 * 3. `%COMSPEC%` or `cmd.exe`
 *
 * Unix priority:
 * 1. `$SHELL`
 * 2. `/bin/zsh`
 * 3. `/bin/bash`
 * 4. `/bin/sh`
 */
export function defaultInteractiveShell(
  options: ShellOptions = {},
): InteractiveShell {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;

  if (platform === 'win32') {
    const configured = env.SHELL?.trim();
    if (configured) {
      const lower = configured.toLowerCase();
      const isPwsh = lower.includes('pwsh') || lower.includes('powershell');
      return {
        executable: configured,
        args: isPwsh ? ['-NoLogo'] : [],
      };
    }

    const comspec = env.COMSPEC?.trim();
    return {
      executable: comspec || 'powershell.exe',
      args: comspec?.toLowerCase().includes('cmd') ? [] : ['-NoLogo'],
    };
  }

  const configured = env.SHELL?.trim();
  if (configured && existsSync(configured)) {
    return { executable: configured, args: ['-l'] };
  }

  for (const candidate of ['/bin/zsh', '/bin/bash', '/bin/sh']) {
    if (existsSync(candidate)) {
      return { executable: candidate, args: ['-l'] };
    }
  }

  return { executable: '/bin/sh', args: ['-l'] };
}

/**
 * Build interactive shell invocation for an optional user-selected shell.
 */
export function shellCommand(
  selectedShell?: string,
  options: ShellOptions = {},
): InteractiveShell {
  if (!selectedShell) {
    return defaultInteractiveShell(options);
  }

  const platform = options.platform ?? process.platform;
  if (platform === 'win32') {
    const lower = selectedShell.toLowerCase();
    const isPwsh = lower.includes('pwsh') || lower.includes('powershell');
    return {
      executable: selectedShell,
      args: isPwsh ? ['-NoLogo'] : [],
    };
  }

  return {
    executable: selectedShell,
    args: ['-l'],
  };
}
