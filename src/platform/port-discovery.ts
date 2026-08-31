import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Parse ports listening for a specific PID from Windows `netstat -ano -p tcp` output.
 */
export function parseNetstatOutput(
  stdout: string,
  targetPid: number,
): number[] {
  const ports = new Set<number>();
  const lines = stdout.split('\n');
  const targetPidStr = String(targetPid);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('TCP')) continue;
    // Format: TCP 127.0.0.1:12345 0.0.0.0:0 LISTENING 5678
    const parts = trimmed.split(/\s+/);
    if (parts.length < 5) continue;
    const localAddr = parts[1];
    const state = parts[3];
    const pid = parts[4];

    if (state === 'LISTENING' && pid === targetPidStr && localAddr) {
      const lastColon = localAddr.lastIndexOf(':');
      if (lastColon !== -1) {
        const port = Number.parseInt(localAddr.slice(lastColon + 1), 10);
        if (port > 0 && port <= 65535) {
          ports.add(port);
        }
      }
    }
  }

  return [...ports];
}

/**
 * Parse ports from Unix `lsof -nP -a -p <pid> -iTCP -sTCP:LISTEN -Fn` output.
 */
export function parseLsofOutput(stdout: string): number[] {
  const ports = new Set<number>();
  const lines = stdout.split('\n');

  for (const line of lines) {
    const match =
      /^n(?:127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):([1-9][0-9]{0,4})$/.exec(
        line.trim(),
      );
    if (match?.[1]) {
      const port = Number.parseInt(match[1], 10);
      if (port > 0 && port <= 65535) {
        ports.add(port);
      }
    }
  }

  return [...ports];
}

/**
 * Parse ports from Linux `ss -tlnp` output for a specific PID.
 */
export function parseSsOutput(stdout: string, targetPid: number): number[] {
  const ports = new Set<number>();
  const lines = stdout.split('\n');
  const pidPattern = new RegExp(`pid=${targetPid}(?:,|\\))`);

  for (const line of lines) {
    if (!line.includes('LISTEN') || !pidPattern.test(line)) continue;
    const parts = line.trim().split(/\s+/);
    // Typical ss output: LISTEN 0 128 127.0.0.1:12345 0.0.0.0:* users:(("proc",pid=123,fd=4))
    if (parts.length >= 4 && parts[3]) {
      const localAddr = parts[3];
      const lastColon = localAddr.lastIndexOf(':');
      if (lastColon !== -1) {
        const port = Number.parseInt(localAddr.slice(lastColon + 1), 10);
        if (port > 0 && port <= 65535) {
          ports.add(port);
        }
      }
    }
  }

  return [...ports];
}

export interface FindListeningPortsOptions {
  platform?: NodeJS.Platform;
  timeoutMs?: number;
}

/**
 * Find TCP ports where a given process ID is listening across platforms.
 */
export async function findListeningPorts(
  pid: number,
  options: FindListeningPortsOptions = {},
): Promise<number[]> {
  const platform = options.platform ?? process.platform;
  const timeout = options.timeoutMs ?? 1000;

  if (platform === 'win32') {
    try {
      const { stdout } = await execFileAsync('netstat', ['-ano', '-p', 'tcp'], {
        encoding: 'utf8',
        timeout,
        maxBuffer: 512 * 1024,
        windowsHide: true,
      });
      return parseNetstatOutput(stdout, pid);
    } catch {
      return [];
    }
  }

  if (platform === 'darwin') {
    try {
      const { stdout } = await execFileAsync(
        '/usr/sbin/lsof',
        ['-nP', '-a', '-p', String(pid), '-iTCP', '-sTCP:LISTEN', '-Fn'],
        { encoding: 'utf8', timeout, maxBuffer: 64 * 1024 },
      );
      return parseLsofOutput(stdout);
    } catch {
      // Fallback to plain lsof in PATH
      try {
        const { stdout } = await execFileAsync(
          'lsof',
          ['-nP', '-a', '-p', String(pid), '-iTCP', '-sTCP:LISTEN', '-Fn'],
          { encoding: 'utf8', timeout, maxBuffer: 64 * 1024 },
        );
        return parseLsofOutput(stdout);
      } catch {
        return [];
      }
    }
  }

  // Linux / others: try ss first, then lsof, then netstat
  try {
    const { stdout } = await execFileAsync('ss', ['-tlnp'], {
      encoding: 'utf8',
      timeout,
      maxBuffer: 256 * 1024,
    });
    const ssPorts = parseSsOutput(stdout, pid);
    if (ssPorts.length > 0) return ssPorts;
  } catch {
    // Continue
  }

  try {
    const { stdout } = await execFileAsync(
      'lsof',
      ['-nP', '-a', '-p', String(pid), '-iTCP', '-sTCP:LISTEN', '-Fn'],
      { encoding: 'utf8', timeout, maxBuffer: 64 * 1024 },
    );
    return parseLsofOutput(stdout);
  } catch {
    // Continue
  }

  return [];
}
