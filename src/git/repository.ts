import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, open, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { RELAY_DIRECTORY } from '../safety/path-policy.js';

const execFileAsync = promisify(execFile);

export const RELAY_EXCLUDE_LINE = `/${RELAY_DIRECTORY}/`;
export const GIT_EXCLUDE_ABSOLUTE_ARGS = [
  'rev-parse',
  '--path-format=absolute',
  '--git-path',
  'info/exclude',
] as const;

/** The repository-local exclude path for `root`, resolved through Git. */
export async function gitExcludePath(root: string): Promise<string> {
  const { stdout: rootOutput } = await execFileAsync(
    'git',
    ['rev-parse', '--path-format=absolute', '--show-toplevel'],
    { cwd: root, encoding: 'utf8' },
  );
  const canonicalRoot = rootOutput.trim();
  if (!canonicalRoot)
    throw new Error('Could not resolve the canonical Git repository root.');

  const [{ stdout: absoluteOutput }, { stdout: unresolvedOutput }] =
    await Promise.all([
      execFileAsync('git', [...GIT_EXCLUDE_ABSOLUTE_ARGS], {
        cwd: canonicalRoot,
        encoding: 'utf8',
      }),
      execFileAsync('git', ['rev-parse', '--git-path', 'info/exclude'], {
        cwd: canonicalRoot,
        encoding: 'utf8',
      }),
    ]);
  const absolutePath = absoluteOutput.trim();
  const unresolvedPath = unresolvedOutput.trim();
  if (!absolutePath || !path.isAbsolute(absolutePath) || !unresolvedPath)
    throw new Error('Could not resolve the repository-local exclude path.');

  // Git's absolute form resolves a final symlink on some platforms. Use the
  // unresolved spelling for no-follow validation and mutation.
  return path.isAbsolute(unresolvedPath)
    ? path.normalize(unresolvedPath)
    : path.resolve(canonicalRoot, unresolvedPath);
}

/**
 * Add `/.relay/` to the repository-local Git exclude file so Relay state never
 * appears in ordinary Git status. This is the one local metadata mutation Relay
 * performs; it never edits `.gitignore`, the index, remotes, or branches.
 */
export async function installRelayLocalExclusion(root: string): Promise<void> {
  const excludePath = await gitExcludePath(root);
  let contents = '';
  let mode = 0o644;
  let handle;
  try {
    handle = await open(
      excludePath,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ELOOP')
      throw new Error(
        `Refusing to follow a symlinked Git exclude file: ${excludePath}`,
      );
    if (code !== 'ENOENT') throw error;
  }
  if (handle) {
    try {
      const existing = await handle.stat();
      if (!existing.isFile())
        throw new Error(
          `Git exclude path is not a regular file: ${excludePath}`,
        );
      mode = existing.mode & 0o7777;
      contents = await handle.readFile('utf8');
    } finally {
      await handle.close();
    }
  }
  const lines = contents.split('\n');
  const body =
    contents === '' ? [] : contents.endsWith('\n') ? lines.slice(0, -1) : lines;
  if (body.includes(RELAY_EXCLUDE_LINE)) return;
  const next = `${[...body, RELAY_EXCLUDE_LINE].join('\n')}\n`;
  const temporaryPath = path.join(
    path.dirname(excludePath),
    `.exclude.relay-${process.pid}-${randomUUID()}`,
  );
  try {
    await writeFile(temporaryPath, next, {
      encoding: 'utf8',
      flag: 'wx',
      mode,
    });
    await rename(temporaryPath, excludePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EISDIR')
      throw new Error(`Git exclude path is not a regular file: ${excludePath}`);
    throw error;
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

/**
 * Upgrade-repair path for repositories initialized before local exclusion:
 * install the exclude only when Relay state already exists.
 */
export async function ensureRelayLocalExclusion(root: string): Promise<void> {
  try {
    await lstat(path.join(root, RELAY_DIRECTORY));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  await installRelayLocalExclusion(root);
}

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
  /** Hash of commit, branch, status, and the complete tracked/index patch. */
  fingerprint: string;
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
  const fingerprint = createHash('sha256')
    .update(baseline.commit)
    .update('\0')
    .update(baseline.branch)
    .update('\0')
    .update(status)
    .update('\0')
    .update(patch)
    .digest('hex');
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
    fingerprint,
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
