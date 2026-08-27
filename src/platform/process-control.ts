import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type TerminalInterruptIntent =
  'user_interrupt' | 'user_stop' | 'renderer_failure' | 'daemon_shutdown';

export interface ProcessControlOptions {
  platform?: NodeJS.Platform;
  force?: boolean;
}

/**
 * Check whether a process with the specified PID is currently alive.
 */
export function processIsAlive(
  pid: number,
  options: ProcessControlOptions = {},
): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  void options;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

/**
 * Terminate a process and all of its descendants across platforms.
 *
 * - Windows: Uses `taskkill /PID <pid> /T /F` to eliminate the complete process hierarchy.
 * - Unix: Discovers descendants via `ps` and signals them from leaves to root with SIGTERM/SIGKILL.
 */
export async function killProcessTree(
  pid: number,
  options: ProcessControlOptions = {},
): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 0) return;
  const platform = options.platform ?? process.platform;
  const force = options.force !== false;

  if (platform === 'win32') {
    try {
      const args = ['/PID', String(pid), '/T'];
      if (force) args.push('/F');
      await execFileAsync('taskkill', args, { timeout: 5000 });
    } catch {
      // Process already terminated or inaccessible.
    }
    return;
  }

  const pids = await findUnixDescendantPids(pid);
  const signal = force ? 'SIGKILL' : 'SIGTERM';

  for (const targetPid of [...pids, pid]) {
    try {
      process.kill(targetPid, signal);
    } catch {
      // Process already gone.
    }
  }
}

async function findUnixDescendantPids(rootPid: number): Promise<number[]> {
  try {
    const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,ppid='], {
      encoding: 'utf8',
      timeout: 3000,
    });
    const children = new Map<number, number[]>();
    for (const row of stdout.split('\n')) {
      const parts = row.trim().split(/\s+/);
      if (parts.length >= 2) {
        const processId = Number.parseInt(parts[0]!, 10);
        const parentId = Number.parseInt(parts[1]!, 10);
        if (Number.isInteger(processId) && Number.isInteger(parentId)) {
          const list = children.get(parentId) ?? [];
          list.push(processId);
          children.set(parentId, list);
        }
      }
    }

    const result: number[] = [];
    const pending = [...(children.get(rootPid) ?? [])];
    while (pending.length > 0) {
      const current = pending.pop()!;
      result.push(current);
      const sub = children.get(current);
      if (sub) pending.push(...sub);
    }
    return result.reverse();
  } catch {
    return [];
  }
}
