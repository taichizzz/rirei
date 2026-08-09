import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface GitBaseline {
  root: string;
  commit: string;
  branch: string;
  dirty: boolean;
  changedFiles: number;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout.trim();
}

export interface GitSnapshot {
  commit: string;
  branch: string;
  status: string;
  diffStat: string;
  patch: string;
}

export async function inspectGitSnapshot(
  projectRoot: string,
  maxPatchBytes: number,
): Promise<GitSnapshot & { patchTruncated: boolean }> {
  const excludeRelay = [':(exclude).relay/**'];
  const baseline = await inspectGitBaseline(projectRoot);
  const diffBase = baseline.commit === 'unborn' ? ['--cached'] : ['HEAD'];
  const [status, diffStat, patch] = await Promise.all([
    git(projectRoot, [
      'status',
      '--porcelain=v1',
      '--untracked-files=all',
      '--',
      '.',
      ...excludeRelay,
    ]),
    git(projectRoot, [
      'diff',
      '--stat',
      '--no-ext-diff',
      ...diffBase,
      '--',
      '.',
      ...excludeRelay,
    ]),
    git(projectRoot, [
      'diff',
      '--binary',
      '--no-ext-diff',
      ...diffBase,
      '--',
      '.',
      ...excludeRelay,
    ]),
  ]);
  const bytes = Buffer.from(patch);
  const patchTruncated = bytes.length > maxPatchBytes;
  const marker = Buffer.from('\n[Relay patch truncated]\n');
  const boundedPatch = patchTruncated
    ? Buffer.concat([
        bytes.subarray(0, Math.max(0, maxPatchBytes - marker.length)),
        marker.subarray(0, maxPatchBytes),
      ]).subarray(0, maxPatchBytes)
    : bytes;
  return {
    commit: baseline.commit,
    branch: baseline.branch,
    status,
    diffStat,
    patch: boundedPatch.toString('utf8'),
    patchTruncated,
  };
}

export async function discoverRepository(cwd: string): Promise<string | null> {
  try {
    return await git(cwd, ['rev-parse', '--show-toplevel']);
  } catch {
    return null;
  }
}

/** The URL of the `origin` remote, or `null` when no remote is configured. */
export async function firstRemoteUrl(root: string): Promise<string | null> {
  try {
    const url = await git(root, ['remote', 'get-url', 'origin']);
    return url || null;
  } catch {
    return null;
  }
}

/** True when a local branch of exactly this name already exists. */
export async function branchExists(
  root: string,
  branch: string,
): Promise<boolean> {
  try {
    await git(root, [
      'show-ref',
      '--verify',
      '--quiet',
      `refs/heads/${branch}`,
    ]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Create a linked worktree on a new branch. This is the one Git-mutating
 * operation Relay performs, and only through explicit, previewed workspace
 * creation. It never touches the main working tree, and never merges, resets,
 * force-deletes, rebases, or pushes.
 */
export async function addWorktree(
  root: string,
  branch: string,
  worktreePath: string,
  baseCommit: string,
): Promise<void> {
  await git(root, ['worktree', 'add', '-b', branch, worktreePath, baseCommit]);
}

export interface WorktreeEntry {
  path: string;
  branch: string | null;
  head: string | null;
}

/** Parse `git worktree list --porcelain` into structured entries. */
export async function listWorktrees(root: string): Promise<WorktreeEntry[]> {
  const out = await git(root, ['worktree', 'list', '--porcelain']);
  const entries: WorktreeEntry[] = [];
  let current: WorktreeEntry | null = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current) entries.push(current);
      current = {
        path: line.slice('worktree '.length),
        branch: null,
        head: null,
      };
    } else if (line.startsWith('HEAD ') && current) {
      current.head = line.slice('HEAD '.length);
    } else if (line.startsWith('branch ') && current) {
      current.branch = line
        .slice('branch '.length)
        .replace(/^refs\/heads\//, '');
    }
  }
  if (current) entries.push(current);
  return entries;
}

/**
 * Count commits in the range `from..to`. Returns `null` when the range cannot
 * be resolved (for example, no configured upstream).
 */
export async function countCommits(
  root: string,
  from: string,
  to: string,
): Promise<number | null> {
  try {
    const out = await git(root, ['rev-list', '--count', `${from}..${to}`]);
    const count = Number.parseInt(out, 10);
    return Number.isNaN(count) ? null : count;
  } catch {
    return null;
  }
}

export async function inspectGitBaseline(
  projectRoot: string,
): Promise<GitBaseline> {
  const [root, commit, branch, porcelain] = await Promise.all([
    git(projectRoot, ['rev-parse', '--show-toplevel']),
    git(projectRoot, ['rev-parse', '--verify', 'HEAD']).catch(() => 'unborn'),
    git(projectRoot, ['branch', '--show-current']),
    git(projectRoot, [
      'status',
      '--porcelain=v1',
      '--',
      '.',
      ':(exclude).relay/**',
    ]),
  ]);
  if (!branch) {
    throw new Error('Relay requires a repository with a checked-out branch.');
  }
  return {
    root,
    commit,
    branch,
    dirty: porcelain.length > 0,
    changedFiles: porcelain ? porcelain.split('\n').length : 0,
  };
}
