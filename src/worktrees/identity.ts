import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { firstRemoteUrl } from '../git/repository.js';

export interface RepositoryIdentity {
  /** Canonical (symlink-resolved) Git top-level path. */
  canonicalRoot: string;
  /** `origin` remote URL when configured, else `null`. */
  remote: string | null;
  /** Stable directory key derived from root + remote. Not a security boundary. */
  key: string;
}

/**
 * Derive a stable identity for a repository checkout. The key combines the
 * canonical root and the remote so two clones of the same remote in different
 * directories do not collide on one worktree namespace, while a single checkout
 * stays stable across runs.
 */
export async function repositoryIdentity(
  root: string,
): Promise<RepositoryIdentity> {
  const canonicalRoot = await realpath(root);
  const remote = await firstRemoteUrl(root);
  const material = `${canonicalRoot}\n${remote ?? ''}`;
  const key = createHash('sha256').update(material).digest('hex').slice(0, 16);
  return { canonicalRoot, remote, key };
}
