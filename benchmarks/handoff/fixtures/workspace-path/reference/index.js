import { lstat, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';

function contained(root, target) {
  const path = relative(root, target);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`));
}

export async function resolveWorkspacePath(root, candidate) {
  if (
    typeof candidate !== 'string' ||
    candidate.length === 0 ||
    candidate.includes('\0') ||
    isAbsolute(candidate) ||
    /^[A-Za-z]:[\\/]/.test(candidate) ||
    candidate.startsWith('\\')
  ) {
    throw new TypeError('candidate must be a nonempty relative path');
  }
  const parts = candidate
    .split(/[\\/]+/)
    .filter((part) => part && part !== '.');
  if (parts.includes('..')) throw new Error('candidate may not contain ..');
  const canonicalRoot = await realpath(root);
  if (!(await stat(canonicalRoot)).isDirectory())
    throw new Error('root must be a directory');
  let current = canonicalRoot;
  for (let index = 0; index < parts.length; index += 1) {
    const next = join(current, parts[index]);
    let info;
    try {
      info = await lstat(next);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const missingTarget = join(current, ...parts.slice(index));
      if (!contained(canonicalRoot, missingTarget))
        throw new Error('path escapes workspace');
      return missingTarget;
    }
    if (info.isSymbolicLink()) {
      current = await realpath(next);
      if (!contained(canonicalRoot, current))
        throw new Error('symlink escapes workspace');
    } else {
      current = next;
    }
    if (index < parts.length - 1 && !(await stat(current)).isDirectory()) {
      throw new Error('intermediate component is not a directory');
    }
  }
  const target = await realpath(current);
  if (!contained(canonicalRoot, target))
    throw new Error('path escapes workspace');
  return target;
}
