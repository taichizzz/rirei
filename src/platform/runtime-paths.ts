import { homedir } from 'node:os';
import path from 'node:path';

export interface PlatformPathOptions {
  platform?: NodeJS.Platform;
  home?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Resolve the persistent application data directory for Rirei.
 *
 * Resolution order:
 * 1. `RIREI_DATA_HOME` environment override (absolute or relative to home)
 * 2. macOS (`darwin`): `~/Library/Application Support/Rirei`
 * 3. Windows (`win32`): `%LOCALAPPDATA%\Rirei` (fallback: `~/AppData/Local/Rirei`)
 * 4. Linux / others: `$XDG_DATA_HOME/rirei` (fallback: `~/.local/share/rirei`)
 */
export function rireiDataHome(options: PlatformPathOptions = {}): string {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const p = platform === 'win32' ? path.win32 : path;
  const home = options.home ?? homedir();

  const override = env.RIREI_DATA_HOME?.trim();
  if (override) {
    return p.isAbsolute(override)
      ? p.resolve(override)
      : p.resolve(home, override);
  }

  if (platform === 'darwin') {
    return p.join(home, 'Library', 'Application Support', 'Rirei');
  }

  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA?.trim();
    return localAppData
      ? p.join(p.resolve(localAppData), 'Rirei')
      : p.join(home, 'AppData', 'Local', 'Rirei');
  }

  const xdg = env.XDG_DATA_HOME?.trim();
  if (xdg) {
    return p.join(p.resolve(xdg), 'rirei');
  }

  return p.join(home, '.local', 'share', 'rirei');
}

/**
 * Return the path to the global activity file `activity.json`.
 */
export function activityFilePath(options: PlatformPathOptions = {}): string {
  const platform = options.platform ?? process.platform;
  const p = platform === 'win32' ? path.win32 : path;
  return p.join(rireiDataHome(options), 'activity.json');
}

/**
 * Return the path to the global activity sources file `activity-sources.json`.
 */
export function activitySourcesFilePath(
  options: PlatformPathOptions = {},
): string {
  const platform = options.platform ?? process.platform;
  const p = platform === 'win32' ? path.win32 : path;
  return p.join(rireiDataHome(options), 'activity-sources.json');
}

/**
 * Return the path to the project terminal lifecycle journal file.
 */
export function journalFilePath(
  projectHash: string,
  options: PlatformPathOptions = {},
): string {
  const platform = options.platform ?? process.platform;
  const p = platform === 'win32' ? path.win32 : path;
  return p.join(rireiDataHome(options), `terminal-journal-${projectHash}.json`);
}

/**
 * Return the path to the daemon descriptor file `terminal-daemon-v1.json`.
 */
export function daemonDescriptorPath(
  runtimeRootOrUserData: string,
  options: PlatformPathOptions = {},
): string {
  const platform = options.platform ?? process.platform;
  const p = platform === 'win32' ? path.win32 : path;
  return p.join(runtimeRootOrUserData, 'terminal-daemon-v1.json');
}
