import { chmod, lstat, mkdir, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

export type TerminalEndpointKind = 'socket' | 'named_pipe';

export interface TerminalEndpoint {
  readonly kind: TerminalEndpointKind;
  readonly path: string;
}

export interface EndpointOptions {
  hash: string;
  platform?: NodeJS.Platform;
  tmpDir?: string;
  uid?: number;
}

/**
 * Generate the canonical cross-platform daemon communication endpoint.
 *
 * Shapes:
 * - macOS/Linux: `<tmpdir>/rirei-<uid>-<hash>/pty-v1.sock`
 * - Windows: `\\.\pipe\rirei-<hash>-pty-v1`
 */
export function daemonEndpoint(options: EndpointOptions): TerminalEndpoint {
  const platform = options.platform ?? process.platform;
  if (platform === 'win32') {
    return {
      kind: 'named_pipe',
      path: `\\\\.\\pipe\\rirei-${options.hash}-pty-v1`,
    };
  }

  const uid = options.uid ?? (process.getuid ? process.getuid() : 0);
  const baseTmp = options.tmpDir ?? tmpdir();
  return {
    kind: 'socket',
    path: path.join(baseTmp, `rirei-${uid}-${options.hash}`, 'pty-v1.sock'),
  };
}

/**
 * Check whether an endpoint has an active daemon listening, and prepare the
 * endpoint for binding.
 */
export async function prepareEndpoint(
  endpoint: TerminalEndpoint,
): Promise<void> {
  if (endpoint.kind === 'named_pipe') {
    const live = await probeEndpointLiveness(endpoint.path);
    if (live) throw new Error('A terminal daemon is already active.');
    return;
  }

  const socketDir = path.dirname(endpoint.path);
  await mkdir(socketDir, { recursive: true, mode: 0o700 });
  await chmod(socketDir, 0o700).catch(() => undefined);

  try {
    const details = await lstat(endpoint.path);
    if (!details.isSocket()) {
      throw new Error('Refusing to replace a non-socket daemon path.');
    }
    const live = await probeEndpointLiveness(endpoint.path);
    if (live) throw new Error('A terminal daemon is already active.');
    await rm(endpoint.path, { force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
  }
}

/**
 * Clean up an endpoint after daemon shutdown.
 */
export async function cleanupEndpoint(
  endpoint: TerminalEndpoint,
): Promise<void> {
  if (endpoint.kind === 'socket') {
    await rm(endpoint.path, { force: true }).catch(() => undefined);
  }
}

function probeEndpointLiveness(endpointPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection(endpointPath);
    const timer = globalThis.setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, 200);
    socket.once('connect', () => {
      globalThis.clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => {
      globalThis.clearTimeout(timer);
      resolve(false);
    });
  });
}

export interface DescriptorFileStats {
  isFile(): boolean;
  isSymbolicLink(): boolean;
  mode: number;
  uid?: number;
}

/**
 * Validate that a descriptor file has safe permissions.
 * On Unix, enforces non-symlink, owner matching, and strict 0600 mode permissions.
 * On Windows, validates regular file and non-symlink without failing on POSIX mode bits.
 */
export function isSafeDescriptorPermissions(
  stats: DescriptorFileStats,
  platform: NodeJS.Platform = process.platform,
  currentUid: number | undefined = process.getuid
    ? process.getuid()
    : undefined,
): boolean {
  if (!stats.isFile() || stats.isSymbolicLink()) return false;
  if (platform === 'win32') return true;
  if (
    currentUid !== undefined &&
    stats.uid !== undefined &&
    stats.uid !== currentUid
  )
    return false;
  return (stats.mode & 0o077) === 0;
}
