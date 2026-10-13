import { chmodSync, existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PINNED_CCUSAGE_VERSION = '20.0.24';

export interface ResolveBinaryOptions {
  platform?: NodeJS.Platform;
  arch?: string;
  baseDir?: string;
  resourcesPath?: string;
  /** The running CLI/module file; defaults to this module's real location. */
  moduleFile?: string;
}

export interface ResolvedCcusageBinary {
  binaryPath: string;
  pathClass: 'packaged' | 'npm' | 'dev';
  version: string;
}

export function getPlatformPackageName(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string | null {
  const supported = [
    'darwin-arm64',
    'darwin-x64',
    'linux-arm64',
    'linux-x64',
    'win32-arm64',
    'win32-x64',
  ];
  const target = `${platform}-${arch}`;
  if (!supported.includes(target)) {
    return null;
  }
  return `@ccusage/ccusage-${target}`;
}

export function getBinarySubpath(
  platform: NodeJS.Platform = process.platform,
): string {
  return platform === 'win32'
    ? path.join('bin', 'ccusage.exe')
    : path.join('bin', 'ccusage');
}

/**
 * The file this code runs from. The CLI ships as a CommonJS bundle, where
 * `import.meta.url` is empty, so `__filename` comes first; source runs (tsx,
 * tests) fall back to `import.meta.url`.
 */
function currentModuleFile(): string | undefined {
  if (typeof __filename === 'string' && __filename) return __filename;
  try {
    return fileURLToPath(import.meta.url);
  } catch {
    return undefined;
  }
}

/** A directory and each of its parents, like Node's node_modules lookup. */
function ancestorDirs(start: string): string[] {
  const dirs: string[] = [];
  let current = path.resolve(start);
  for (;;) {
    dirs.push(current);
    const parent = path.dirname(current);
    if (parent === current) return dirs;
    current = parent;
  }
}

/** `<Resources>/cli` is the packaged desktop app; anything else is an install. */
function installPathClass(dir: string): ResolvedCcusageBinary['pathClass'] {
  return path.basename(dir) === 'cli' &&
    path.basename(path.dirname(dir)).toLowerCase() === 'resources'
    ? 'packaged'
    : 'npm';
}

function ensureExecutable(binaryPath: string, platform: NodeJS.Platform): void {
  if (platform === 'win32') return;
  try {
    const st = statSync(binaryPath);
    if ((st.mode & 0o111) === 0) {
      chmodSync(binaryPath, 0o755);
    }
  } catch {
    // Ignore permissions inspection failure
  }
}

function readVersionFromPackage(dir: string): string | null {
  try {
    const pkgPath = path.join(dir, 'package.json');
    if (existsSync(pkgPath)) {
      const data = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
        version?: string;
      };
      if (data.version) return data.version;
    }
  } catch {
    // Ignore version read error
  }
  return null;
}

export function resolveCcusageBinary(
  options: ResolveBinaryOptions = {},
): ResolvedCcusageBinary | null {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const pkgName = getPlatformPackageName(platform, arch);
  if (!pkgName) return null;

  const subpath = getBinarySubpath(platform);

  // 1. Packaged app: check resourcesPath
  const resourcesPath =
    options.resourcesPath ??
    ((process as unknown as { resourcesPath?: string }).resourcesPath ||
      undefined);

  if (resourcesPath) {
    const packagedCandidate = path.join(
      resourcesPath,
      'cli',
      'node_modules',
      pkgName,
      subpath,
    );
    if (existsSync(packagedCandidate)) {
      ensureExecutable(packagedCandidate, platform);
      const pkgDir = path.join(resourcesPath, 'cli', 'node_modules', pkgName);
      const version = readVersionFromPackage(pkgDir) ?? PINNED_CCUSAGE_VERSION;
      return {
        binaryPath: packagedCandidate,
        pathClass: 'packaged',
        version,
      };
    }
  }

  // 2. Explicit base directory, then node_modules next to the running CLI.
  // The working directory is never searched: it is the opened project, and a
  // repository must not be able to supply the binary Rirei executes.
  const candidateDirs: Array<{
    dir: string;
    pathClass: ResolvedCcusageBinary['pathClass'];
  }> = [];
  if (options.baseDir) {
    candidateDirs.push({ dir: options.baseDir, pathClass: 'dev' });
  }
  const moduleFile = options.moduleFile ?? currentModuleFile();
  if (moduleFile) {
    for (const dir of ancestorDirs(path.dirname(moduleFile))) {
      candidateDirs.push({ dir, pathClass: installPathClass(dir) });
    }
  }

  for (const { dir, pathClass } of candidateDirs) {
    const candidate = path.join(dir, 'node_modules', pkgName, subpath);
    if (existsSync(candidate)) {
      ensureExecutable(candidate, platform);
      const pkgDir = path.join(dir, 'node_modules', pkgName);
      const ccusageDir = path.join(dir, 'node_modules', 'ccusage');
      const version =
        readVersionFromPackage(ccusageDir) ??
        readVersionFromPackage(pkgDir) ??
        PINNED_CCUSAGE_VERSION;
      return {
        binaryPath: candidate,
        pathClass,
        version,
      };
    }
  }

  return null;
}
