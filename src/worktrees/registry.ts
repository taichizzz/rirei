import { randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  writeFile,
} from 'node:fs/promises';
import { listWorktrees } from '../git/repository.js';
import { relayPath } from '../safety/path-policy.js';
import { withRepositoryLock } from '../state/lock.js';
import {
  LATEST_WORKSPACE_REGISTRY_SCHEMA,
  workspaceRegistrySchema,
  type WorkspaceRegistry,
  type WorkspaceRole,
} from './schema.js';

const REGISTRY_FILE = 'workspaces.json';

function emptyRegistry(): WorkspaceRegistry {
  return { schemaVersion: LATEST_WORKSPACE_REGISTRY_SCHEMA, workspaces: [] };
}

/**
 * Read the workspace registry. A missing file is an empty registry rather than
 * an error, so `list` works before the first workspace is created.
 */
export async function readRegistry(
  projectRoot: string,
): Promise<WorkspaceRegistry> {
  try {
    const contents = await readFile(
      relayPath(projectRoot, REGISTRY_FILE),
      'utf8',
    );
    return workspaceRegistrySchema.parse(JSON.parse(contents));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return emptyRegistry();
    throw error;
  }
}

/**
 * Atomically publish the registry (temp file + rename, mode `0600`). Callers
 * must already hold the repository writer lock.
 */
export async function writeRegistry(
  projectRoot: string,
  registry: WorkspaceRegistry,
): Promise<void> {
  const valid = workspaceRegistrySchema.parse(registry);
  await mkdir(relayPath(projectRoot), { recursive: true, mode: 0o700 });
  const temporary = relayPath(
    projectRoot,
    `.${REGISTRY_FILE}.${randomUUID()}.tmp`,
  );
  await writeFile(temporary, `${JSON.stringify(valid, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  await rename(temporary, relayPath(projectRoot, REGISTRY_FILE));
}

/**
 * Resolve a workspace by ID for launch. Returns the fields `launchAgent` needs
 * to run inside the workspace's worktree.
 */
export async function resolveWorkspace(
  projectRoot: string,
  workspaceId: string,
  parentTaskId: string,
): Promise<{
  id: string;
  worktreePath: string;
  branchLabel: string;
  role: WorkspaceRole;
}> {
  const registry = await readRegistry(projectRoot);
  const workspace = registry.workspaces.find(
    (item) => item.id === workspaceId || item.branch === workspaceId,
  );
  if (!workspace)
    throw new Error(
      `No workspace ${workspaceId}. Run relay workspace list to see available workspaces.`,
    );
  if (workspace.parentTaskId !== parentTaskId)
    throw new Error('That workspace belongs to a different Relay task.');
  if (workspace.status !== 'ready' && workspace.status !== 'active')
    throw new Error(`Workspace ${workspace.id} is ${workspace.status}.`);
  const details = await lstat(workspace.worktreePath).catch(() => undefined);
  if (!details?.isDirectory() || details.isSymbolicLink())
    throw new Error(
      `Workspace path is missing or unsafe: ${workspace.worktreePath}.`,
    );
  const canonicalWorktree = await realpath(workspace.worktreePath);
  const canonicalEntries = await Promise.all(
    (await listWorktrees(projectRoot)).map(async (entry) => ({
      entry,
      canonicalPath: await realpath(entry.path).catch(() => undefined),
    })),
  );
  const registered = canonicalEntries.find(
    (candidate) => candidate.canonicalPath === canonicalWorktree,
  )?.entry;
  if (!registered)
    throw new Error(
      `Workspace ${workspace.id} is no longer registered by Git.`,
    );
  if (registered.branch !== workspace.branch)
    throw new Error(
      `Workspace ${workspace.id} no longer uses its registered branch.`,
    );
  return {
    id: workspace.id,
    worktreePath: workspace.worktreePath,
    branchLabel: workspace.branch,
    role: workspace.role,
  };
}

/**
 * Locked read-modify-write of the registry, for standalone mutations that do
 * not already run inside a `withRepositoryLock` block.
 */
export async function updateRegistry(
  projectRoot: string,
  mutator: (current: WorkspaceRegistry) => WorkspaceRegistry,
): Promise<WorkspaceRegistry> {
  return withRepositoryLock(projectRoot, async () => {
    const next = mutator(await readRegistry(projectRoot));
    await writeRegistry(projectRoot, next);
    return next;
  });
}
