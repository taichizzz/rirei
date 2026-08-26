import { access, constants, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_WINDOWS_PATHEXT = [
  '.COM',
  '.EXE',
  '.BAT',
  '.CMD',
  '.VBS',
  '.VBE',
  '.JS',
  '.JSE',
  '.WSF',
  '.WSH',
  '.MSC',
  '.CPL',
];

export interface ResolveExecutableOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  cwd?: string;
}

/**
 * Return normalized list of executable extensions for Windows.
 */
export function pathextList(env?: NodeJS.ProcessEnv): string[] {
  const raw =
    env?.PATHEXT ?? process.env.PATHEXT ?? DEFAULT_WINDOWS_PATHEXT.join(';');
  return raw
    .split(';')
    .map((ext) => ext.trim())
    .filter(Boolean);
}

/**
 * Resolve an executable name or path to an absolute path, honoring platform-specific
 * PATH search rules and Windows PATHEXT extensions.
 *
 * Returns `null` if the executable cannot be found or is not executable.
 */
export async function resolveExecutable(
  name: string,
  options: ResolveExecutableOptions = {},
): Promise<string | null> {
  if (!name || typeof name !== 'string') return null;

  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const hasSeparators =
    name.includes('/') || (platform === 'win32' && name.includes('\\'));

  if (hasSeparators) {
    const candidate = path.resolve(cwd, name);
    return checkCandidate(candidate, platform, env);
  }

  const delimiter = platform === 'win32' ? ';' : ':';
  const pathValue = env.PATH ?? process.env.PATH ?? '';
  const directories = pathValue.split(delimiter).filter(Boolean);

  for (const directory of directories) {
    const candidate = path.join(directory, name);
    const resolved = await checkCandidate(candidate, platform, env);
    if (resolved) return resolved;
  }

  return null;
}

/**
 * Check if a command or binary is installed and executable in PATH.
 */
export async function isExecutableInstalled(
  name: string,
  options: ResolveExecutableOptions = {},
): Promise<boolean> {
  return (await resolveExecutable(name, options)) !== null;
}

async function checkCandidate(
  candidate: string,
  platform: NodeJS.Platform,
  env?: NodeJS.ProcessEnv,
): Promise<string | null> {
  if (platform === 'win32') {
    const dir = path.dirname(candidate);
    const base = path.basename(candidate).toLowerCase();
    const extensions = pathextList(env).map((ext) => ext.toLowerCase());

    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const entryNameLower = entry.name.toLowerCase();
        if (entryNameLower === base) {
          const entryExt = path.extname(entryNameLower);
          if (extensions.includes(entryExt)) {
            return path.join(dir, entry.name);
          }
        }
        for (const ext of extensions) {
          if (entryNameLower === `${base}${ext}`) {
            return path.join(dir, entry.name);
          }
        }
      }
    } catch {
      // Directory cannot be read
    }

    for (const extension of extensions) {
      const candidateWithExt = candidate.toLowerCase().endsWith(extension)
        ? candidate
        : `${candidate}${extension}`;
      try {
        const details = await stat(candidateWithExt);
        if (details.isFile()) return candidateWithExt;
      } catch {
        // Continue
      }
    }
    return null;
  }

  try {
    await access(candidate, constants.X_OK);
    const details = await stat(candidate);
    if (details.isFile()) return candidate;
  } catch {
    // Candidate does not exist or lacks execute permission.
  }

  return null;
}
