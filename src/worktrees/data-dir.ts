import { homedir } from 'node:os';
import path from 'node:path';

/**
 * Resolve the Rirei data home. Worktrees are stored outside the repository so a
 * linked worktree never nests inside `.git` or shows up in the main repo's
 * status. A deterministic override keeps tests hermetic.
 *
 * Resolution order:
 *   1. `RIREI_DATA_HOME` (explicit override / test hook)
 *   2. `$XDG_DATA_HOME/rirei`
 *   3. `~/.local/share/rirei`
 */
export function rireiDataHome(): string {
  const override = process.env.RIREI_DATA_HOME?.trim();
  if (override) return path.resolve(override);
  const xdg = process.env.XDG_DATA_HOME?.trim();
  if (xdg) return path.join(path.resolve(xdg), 'rirei');
  return path.join(homedir(), '.local', 'share', 'rirei');
}

export function worktreesRoot(): string {
  return path.join(rireiDataHome(), 'worktrees');
}

function assertSafeSegment(segment: string, label: string): void {
  if (
    !segment ||
    segment === '.' ||
    segment === '..' ||
    segment.includes('/') ||
    segment.includes('\\') ||
    segment.includes('\0')
  )
    throw new Error(`Unsafe ${label} for a workspace directory: ${segment}`);
}

/**
 * The on-disk location of a workspace's worktree:
 * `<data home>/worktrees/<repository-key>/<workspace-id>`. Both keys are stable
 * directory names only — never a security boundary.
 */
export function workspaceDirectory(
  repositoryKey: string,
  workspaceId: string,
): string {
  assertSafeSegment(repositoryKey, 'repository key');
  assertSafeSegment(workspaceId, 'workspace id');
  return path.join(worktreesRoot(), repositoryKey, workspaceId);
}
