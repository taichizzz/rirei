import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { relayPath } from '../../src/safety/path-policy.js';
import { branchExists, inspectGitBaseline } from '../../src/git/repository.js';
import type { RelayState } from '../../src/state/schema.js';
import { writeState } from '../../src/state/store.js';
import {
  createWorkspace,
  createWorkspaceFromPreview,
  inspectWorkspaceCleanup,
  previewWorkspace,
} from '../../src/worktrees/manager.js';
import { readRegistry } from '../../src/worktrees/registry.js';
import { createRepository, removeRepository } from '../helpers.js';

const execFileAsync = promisify(execFile);
const repos: string[] = [];
const dataHomes: string[] = [];
let previousDataHome: string | undefined;

async function initTask(root: string): Promise<void> {
  await mkdir(relayPath(root), { recursive: true });
  const now = '2026-01-01T00:00:00.000Z';
  const state: RelayState = {
    schemaVersion: 8,
    revision: 0,
    recentOperations: [],
    runs: [],
    sessionId: 'task-1',
    projectRoot: root,
    task: {
      title: 'Task',
      originalRequest: 'Task',
      requirements: [],
      constraints: [],
      status: 'active',
      createdAt: now,
      updatedAt: now,
    },
    git: { startingCommit: 'abc', startingBranch: 'main', dirtyAtStart: false },
    agentHistory: [],
    decisions: [],
    completedWork: [],
    remainingWork: [],
    tests: [],
    checkpoints: [],
    blockers: [],
    notes: [],
  };
  await writeState(root, state);
}

beforeEach(async () => {
  previousDataHome = process.env.RIREI_DATA_HOME;
  const home = await mkdtemp(path.join(tmpdir(), 'rirei-data-'));
  dataHomes.push(home);
  process.env.RIREI_DATA_HOME = home;
});

afterEach(async () => {
  if (previousDataHome === undefined) delete process.env.RIREI_DATA_HOME;
  else process.env.RIREI_DATA_HOME = previousDataHome;
  await Promise.all([
    ...repos.splice(0).map(removeRepository),
    ...dataHomes
      .splice(0)
      .map((home) => rm(home, { recursive: true, force: true })),
  ]);
});

async function repo(): Promise<string> {
  const root = await createRepository();
  repos.push(root);
  await initTask(root);
  return root;
}

describe('workspace manager', () => {
  it('creates an isolated worktree, branch, and registry entry', async () => {
    const root = await repo();
    const beforeHead = (
      await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: root })
    ).stdout.trim();

    const { workspace } = await createWorkspace(root, {
      role: 'implement',
      parentTaskId: 'task-1',
      slug: 'Add feature',
    });

    expect(workspace.branch).toMatch(
      /^rirei\/add-feature-implement-[0-9a-f]{8}$/,
    );
    await expect(stat(workspace.worktreePath)).resolves.toBeDefined();
    await expect(branchExists(root, workspace.branch)).resolves.toBe(true);

    const registry = await readRegistry(root);
    expect(registry.workspaces).toHaveLength(1);
    expect(registry.workspaces[0]!.id).toBe(workspace.id);

    // The main working tree is untouched by worktree creation. `.relay/` is
    // Relay's own untracked state directory, so exclude it the same way the
    // rest of Relay's Git inspection does.
    const afterHead = (
      await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: root })
    ).stdout.trim();
    expect(afterHead).toBe(beforeHead);
    const status = (
      await execFileAsync(
        'git',
        ['status', '--porcelain', '--', '.', ':(exclude).relay/**'],
        { cwd: root },
      )
    ).stdout;
    expect(status).toBe('');
    // The worktree lives outside the repository, so it never appears in status.
    expect(workspace.worktreePath.startsWith(root)).toBe(false);
  });

  it('rejects executing a preview whose branch already exists', async () => {
    const root = await repo();
    const preview = await previewWorkspace(root, {
      role: 'review',
      parentTaskId: 'task-1',
      slug: 'dup',
    });
    // Simulate a race: the branch appears between preview and execution.
    await execFileAsync('git', ['branch', preview.branch], { cwd: root });
    await expect(createWorkspaceFromPreview(root, preview)).rejects.toThrow(
      /already exists/,
    );
    // No registry entry was written for the rejected creation.
    const registry = await readRegistry(root);
    expect(registry.workspaces).toHaveLength(0);
  });

  it('rejects a symlinked managed worktree parent', async () => {
    const root = await repo();
    const preview = await previewWorkspace(root, {
      role: 'review',
      parentTaskId: 'task-1',
      slug: 'symlink',
    });
    const parent = path.dirname(preview.worktreePath);
    await mkdir(path.dirname(parent), { recursive: true });
    const redirect = await mkdtemp(path.join(tmpdir(), 'rirei-redirect-'));
    dataHomes.push(redirect);
    await symlink(redirect, parent, 'dir');
    await expect(createWorkspaceFromPreview(root, preview)).rejects.toThrow(
      /cannot be symlinks/,
    );
    await expect(branchExists(root, preview.branch)).resolves.toBe(false);
  });

  it('creates a workspace even when the main working tree is dirty', async () => {
    const root = await repo();
    await writeFile(path.join(root, 'README.md'), '# Dirtied\n');
    const { workspace } = await createWorkspace(root, {
      role: 'investigate',
      parentTaskId: 'task-1',
      slug: 'dirty base',
    });
    await expect(stat(workspace.worktreePath)).resolves.toBeDefined();
    // The dirty file stays in the main tree; the worktree starts from the commit.
    const worktreeReadme = (
      await execFileAsync('git', ['status', '--porcelain'], {
        cwd: workspace.worktreePath,
      })
    ).stdout;
    expect(worktreeReadme).toBe('');
  });

  it('refuses to create a workspace in an unborn repository', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'rirei-unborn-'));
    repos.push(root);
    await execFileAsync('git', ['init', '--initial-branch=main'], {
      cwd: root,
    });
    await execFileAsync('git', ['config', 'user.email', 'r@e.test'], {
      cwd: root,
    });
    await execFileAsync('git', ['config', 'user.name', 'R'], { cwd: root });
    await initTask(root);
    await expect(
      createWorkspace(root, {
        role: 'implement',
        parentTaskId: 'task-1',
        slug: 'x',
      }),
    ).rejects.toThrow(/unborn/);
  });

  it('creates concurrent workspaces with distinct ids and paths', async () => {
    const root = await repo();
    const [a, b] = await Promise.all([
      createWorkspace(root, {
        role: 'implement',
        parentTaskId: 'task-1',
        slug: 'a',
      }),
      createWorkspace(root, {
        role: 'review',
        parentTaskId: 'task-1',
        slug: 'b',
      }),
    ]);
    expect(a.workspace.id).not.toBe(b.workspace.id);
    expect(a.workspace.worktreePath).not.toBe(b.workspace.worktreePath);
    const registry = await readRegistry(root);
    expect(registry.workspaces).toHaveLength(2);
  });

  it('reuses a workspace for a retried creation operation', async () => {
    const root = await repo();
    const request = {
      role: 'implement' as const,
      parentTaskId: 'task-1',
      slug: 'retry',
      operationId: 'adcd0c77-02a6-4fa3-a6d6-e50e4a37b0a1',
    };

    const first = await createWorkspace(root, request);
    await writeFile(path.join(root, 'after-create.txt'), 'new head\n');
    await execFileAsync('git', ['add', 'after-create.txt'], { cwd: root });
    await execFileAsync('git', ['commit', '-m', 'Move HEAD'], { cwd: root });
    const retried = await createWorkspace(root, request);

    expect(retried.workspace).toEqual(first.workspace);
    expect(retried.preview.baseCommit).toBe(first.workspace.baseCommit);
    expect(retried.preview.baseBranch).toBe(first.workspace.baseBranch);
    expect((await readRegistry(root)).workspaces).toHaveLength(1);
  });

  it('blocks cleanup while the worktree has uncommitted work', async () => {
    const root = await repo();
    const { workspace } = await createWorkspace(root, {
      role: 'implement',
      parentTaskId: 'task-1',
      slug: 'inspect',
    });
    await writeFile(path.join(workspace.worktreePath, 'scratch.txt'), 'wip\n');

    const inspection = await inspectWorkspaceCleanup(root, workspace.id);
    expect(inspection.dirty).toBe(true);
    expect(inspection.cleanupSafe).toBe(false);
    expect(inspection.reasons.join(' ')).toMatch(/uncommitted or untracked/);
    // Inspection is read-only: the worktree and branch still exist.
    await expect(stat(workspace.worktreePath)).resolves.toBeDefined();
    await expect(branchExists(root, workspace.branch)).resolves.toBe(true);
    // And the main repo is unchanged.
    const baseline = await inspectGitBaseline(root);
    expect(baseline.dirty).toBe(false);
  });

  it('reports a clean workspace as safe to clean up', async () => {
    const root = await repo();
    const { workspace } = await createWorkspace(root, {
      role: 'verify',
      parentTaskId: 'task-1',
      slug: 'clean',
    });
    const inspection = await inspectWorkspaceCleanup(root, workspace.id);
    expect(inspection.cleanupSafe).toBe(true);
    expect(inspection.reasons).toEqual([]);
    expect(inspection.commands[0]).toContain('worktree remove');
  });

  it('blocks cleanup when Relay state cannot establish run ownership', async () => {
    const root = await repo();
    const { workspace } = await createWorkspace(root, {
      role: 'verify',
      parentTaskId: 'task-1',
      slug: 'unknown ownership',
    });
    await writeFile(relayPath(root, 'state.json'), '{ broken json }');
    const inspection = await inspectWorkspaceCleanup(root, workspace.id);
    expect(inspection.cleanupSafe).toBe(false);
    expect(inspection.reasons.join(' ')).toMatch(/could not be read/);
  });
});
