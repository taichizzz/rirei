import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import {
  addWorktree,
  branchExists,
  countCommits,
  inspectGitBaseline,
  listWorktrees,
} from '../git/repository.js';
import { appendEvent } from '../state/activity.js';
import { leaseForWorkspace } from '../state/leases.js';
import { withRepositoryLock } from '../state/lock.js';
import { readState } from '../state/store.js';
import {
  rireiDataHome,
  workspaceDirectory,
  worktreesRoot,
} from './data-dir.js';
import { repositoryIdentity } from './identity.js';
import { readRegistry, writeRegistry } from './registry.js';
import { type RelayWorkspace, type WorkspaceRole } from './schema.js';

interface WorkspaceRequest {
  role: WorkspaceRole;
  parentTaskId: string;
  /** Free text (usually the task title); slugified for the branch name. */
  slug: string;
  operationId?: string;
}

export interface WorkspacePreview {
  workspaceId: string;
  repositoryRoot: string;
  repositoryKey: string;
  branch: string;
  worktreePath: string;
  baseCommit: string;
  baseBranch: string;
  role: WorkspaceRole;
  parentTaskId: string;
}

function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/g, '');
  return slug || 'task';
}

function shortId(id: string): string {
  return id.replace(/-/g, '').slice(0, 8);
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function validatePreview(
  root: string,
  preview: WorkspacePreview,
): Promise<void> {
  const identity = await repositoryIdentity(root);
  if (
    preview.repositoryRoot !== identity.canonicalRoot ||
    preview.repositoryKey !== identity.key
  )
    throw new Error('Workspace preview belongs to a different repository.');
  if (!/^rirei\/[a-z0-9][a-z0-9-]*$/.test(preview.branch))
    throw new Error('Workspace preview contains an invalid generated branch.');
  if (!/^[0-9a-f]{40,64}$/i.test(preview.baseCommit))
    throw new Error('Workspace preview contains an invalid base commit.');
  const expectedPath = workspaceDirectory(identity.key, preview.workspaceId);
  if (path.resolve(preview.worktreePath) !== path.resolve(expectedPath))
    throw new Error(
      'Workspace preview path is outside the Rirei worktree root.',
    );
  const state = await readState(root);
  if (state.sessionId !== preview.parentTaskId)
    throw new Error('Workspace preview belongs to a different Relay task.');
  if (state.task.status !== 'active' && state.task.status !== 'blocked')
    throw new Error(
      `Cannot create a workspace for a ${state.task.status} task.`,
    );
}

async function ensureRealWorktreeParent(worktreePath: string): Promise<void> {
  const parent = path.dirname(worktreePath);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  for (const directory of [rireiDataHome(), worktreesRoot(), parent]) {
    const details = await lstat(directory);
    if (!details.isDirectory() || details.isSymbolicLink())
      throw new Error('Rirei managed worktree directories cannot be symlinks.');
  }
}

/** Compute the proposed workspace without any side effects. */
export async function previewWorkspace(
  root: string,
  request: WorkspaceRequest,
): Promise<WorkspacePreview> {
  const baseline = await inspectGitBaseline(root);
  if (baseline.commit === 'unborn')
    throw new Error(
      'Cannot create a workspace from an unborn repository (no commits yet).',
    );
  const identity = await repositoryIdentity(root);
  const workspaceId = request.operationId
    ? (() => {
        const hex = createHash('sha256')
          .update(
            `${identity.canonicalRoot}\0${request.parentTaskId}\0${request.operationId}`,
          )
          .digest('hex');
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
      })()
    : randomUUID();
  const branch = `rirei/${slugify(request.slug)}-${request.role}-${shortId(workspaceId)}`;
  return {
    workspaceId,
    repositoryRoot: identity.canonicalRoot,
    repositoryKey: identity.key,
    branch,
    worktreePath: workspaceDirectory(identity.key, workspaceId),
    baseCommit: baseline.commit,
    baseBranch: baseline.branch,
    role: request.role,
    parentTaskId: request.parentTaskId,
  };
}

/**
 * Create an isolated Git worktree for a workspace and register it, following
 * the previewed creation flow under the repository writer lock. On failure it
 * reports exactly what was created; a partially created worktree is never
 * silently deleted, because it may already hold work.
 */
export async function createWorkspace(
  root: string,
  request: WorkspaceRequest,
): Promise<{ workspace: RelayWorkspace; preview: WorkspacePreview }> {
  const preview = await previewWorkspace(root, request);
  const workspace = await createWorkspaceFromPreview(root, preview);
  return {
    workspace,
    preview: {
      ...preview,
      baseCommit: workspace.baseCommit,
      baseBranch: workspace.baseBranch ?? preview.baseBranch,
    },
  };
}

/**
 * Execute a previously computed preview. Splitting this from
 * {@link previewWorkspace} lets a frontend show the preview for approval and
 * then create exactly what was shown.
 */
export async function createWorkspaceFromPreview(
  root: string,
  preview: WorkspacePreview,
): Promise<RelayWorkspace> {
  const created = await withRepositoryLock(root, async () => {
    await validatePreview(root, preview);
    const registry = await readRegistry(root);
    const existing = registry.workspaces.find(
      (workspace) => workspace.id === preview.workspaceId,
    );
    if (existing) {
      if (
        existing.parentTaskId === preview.parentTaskId &&
        existing.branch === preview.branch &&
        existing.worktreePath === preview.worktreePath &&
        existing.role === preview.role
      )
        return existing;
      throw new Error(
        `Workspace operation ${preview.workspaceId} conflicts with an existing workspace.`,
      );
    }
    if (await branchExists(root, preview.branch))
      throw new Error(`Branch ${preview.branch} already exists.`);
    if (await pathExists(preview.worktreePath))
      throw new Error(`Worktree path already exists: ${preview.worktreePath}.`);
    await ensureRealWorktreeParent(preview.worktreePath);

    let worktreeCreated = false;
    let workspaceRegistered = false;
    try {
      await addWorktree(
        root,
        preview.branch,
        preview.worktreePath,
        preview.baseCommit,
      );
      worktreeCreated = true;
      const created: RelayWorkspace = {
        id: preview.workspaceId,
        parentTaskId: preview.parentTaskId,
        repositoryRoot: preview.repositoryRoot,
        worktreePath: preview.worktreePath,
        branch: preview.branch,
        baseCommit: preview.baseCommit,
        baseBranch: preview.baseBranch,
        role: preview.role,
        createdAt: new Date().toISOString(),
        status: 'ready',
        terminalIds: [],
      };
      await writeRegistry(root, {
        ...registry,
        workspaces: [...registry.workspaces, created],
      });
      workspaceRegistered = true;
      return created;
    } catch (error) {
      const detail = workspaceRegistered
        ? ` A Git worktree at ${preview.worktreePath} on branch ${preview.branch} ` +
          `was created and registered.`
        : worktreeCreated
          ? ` A Git worktree at ${preview.worktreePath} on branch ${preview.branch} ` +
            `was created but not registered. Inspect it before any manual cleanup.`
          : '';
      throw new Error(`${(error as Error).message}${detail}`);
    }
  });
  await appendEvent(root, 'workspace_created', {});
  return created;
}

export interface CleanupInspection {
  workspace: RelayWorkspace;
  worktreeExists: boolean;
  dirty: boolean;
  changedFiles: number;
  commitsAhead: number | null;
  unpushedCommits: number | null;
  hasUpstream: boolean;
  /** The active run lease owning this workspace, if any. */
  activeRunId: string | null;
  cleanupSafe: boolean;
  reasons: string[];
  commands: string[];
}

/**
 * Inspect a workspace for safe cleanup. Read-only: it never removes a worktree
 * or branch, and returns copyable Git commands plus the reasons cleanup would
 * currently lose work.
 */
export async function inspectWorkspaceCleanup(
  root: string,
  workspaceId: string,
): Promise<CleanupInspection> {
  const registry = await readRegistry(root);
  const workspace = registry.workspaces.find((item) => item.id === workspaceId);
  if (!workspace)
    throw new Error(`No workspace ${workspaceId} in the registry.`);

  const worktreeExists = await pathExists(workspace.worktreePath);
  const reasons: string[] = [];
  if (!worktreeExists)
    reasons.push('registered worktree path no longer exists');
  let dirty = false;
  let changedFiles = 0;
  let commitsAhead: number | null = null;
  let unpushedCommits: number | null = null;
  let hasUpstream = false;
  if (worktreeExists) {
    try {
      const details = await lstat(workspace.worktreePath);
      if (!details.isDirectory() || details.isSymbolicLink())
        throw new Error('registered path is not a real directory');
      const entries = await listWorktrees(root);
      const canonicalWorktree = await realpath(workspace.worktreePath);
      const registeredPaths = await Promise.all(
        entries.map((entry) => realpath(entry.path).catch(() => undefined)),
      );
      if (!registeredPaths.some((entryPath) => entryPath === canonicalWorktree))
        throw new Error('path is not registered as a Git worktree');
      const baseline = await inspectGitBaseline(workspace.worktreePath);
      dirty = baseline.dirty;
      changedFiles = baseline.changedFiles;
    } catch (error) {
      reasons.push(
        `worktree Git state could not be inspected: ${(error as Error).message}`,
      );
    }
    commitsAhead = await countCommits(
      root,
      workspace.baseCommit,
      workspace.branch,
    );
    unpushedCommits = await countCommits(
      root,
      `${workspace.branch}@{u}`,
      workspace.branch,
    );
    hasUpstream = unpushedCommits !== null;
    if (commitsAhead === null)
      reasons.push('branch could not be compared with its base commit');
  }

  // A workspace claimed by a live run must never be cleaned up underneath it.
  let activeRunId: string | null = null;
  try {
    const lease = leaseForWorkspace(await readState(root), workspace.id);
    activeRunId = lease?.runId ?? null;
  } catch {
    reasons.push('Relay task state could not be read to verify run ownership');
  }

  if (activeRunId)
    reasons.push(`run ${activeRunId} still holds this workspace`);
  if (dirty)
    reasons.push(
      `${changedFiles} uncommitted or untracked file(s) in the worktree`,
    );
  if ((commitsAhead ?? 0) > 0)
    reasons.push(`${commitsAhead} commit(s) ahead of the base commit`);
  if (hasUpstream && (unpushedCommits ?? 0) > 0)
    reasons.push(`${unpushedCommits} unpushed commit(s)`);
  if (!hasUpstream && (commitsAhead ?? 0) > 0)
    reasons.push('branch has commits and no upstream to compare against');
  if (workspace.terminalIds.length > 0)
    reasons.push(`${workspace.terminalIds.length} terminal(s) still attached`);

  const quote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;
  return {
    workspace,
    worktreeExists,
    dirty,
    changedFiles,
    commitsAhead,
    unpushedCommits,
    hasUpstream,
    activeRunId,
    cleanupSafe: worktreeExists && reasons.length === 0,
    reasons,
    commands: [
      `git -C ${quote(root)} worktree remove ${quote(workspace.worktreePath)}`,
      `git -C ${quote(root)} branch -d ${quote(workspace.branch)}`,
    ],
  };
}
