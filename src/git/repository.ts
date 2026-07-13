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
