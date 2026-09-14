import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath, rm } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import {
  daemonDescriptorPath,
  rireiDataHome,
  type PlatformPathOptions,
} from './runtime-paths.js';
import {
  cleanupEndpoint,
  daemonEndpoint,
  isSafeDescriptorPermissions,
} from './terminal-endpoint.js';

export const DAEMON_PROTOCOL_VERSION = 2;

export interface EnsureDaemonOptions extends PlatformPathOptions {
  runtimeRoot?: string;
  cliPath?: string;
  nodePath?: string;
  timeoutMs?: number;
}

export interface EnsureDaemonResult {
  readonly socketPath: string;
  readonly descriptorPath: string;
  readonly reused: boolean;
}

export interface DaemonDescriptor {
  readonly schemaVersion: number;
  readonly protocolVersion: number;
  readonly daemonId: string;
  readonly pid: number;
  readonly bootId?: string;
  readonly socketPath: string;
  readonly reconnectToken: string;
  readonly createdAt: string;
}

function descriptorSocketPath(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const socketPath = (value as { socketPath?: unknown }).socketPath;
  return typeof socketPath === 'string' &&
    socketPath.length > 0 &&
    socketPath.length < 4096 &&
    !socketPath.includes('\0')
    ? socketPath
    : null;
}

function validDaemonDescriptor(value: unknown): value is DaemonDescriptor {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const descriptor = value as Partial<DaemonDescriptor>;
  return (
    descriptor.schemaVersion === 1 &&
    Number.isSafeInteger(descriptor.protocolVersion) &&
    typeof descriptor.daemonId === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      descriptor.daemonId,
    ) &&
    Number.isSafeInteger(descriptor.pid) &&
    descriptor.pid! > 0 &&
    (descriptor.bootId === undefined ||
      (typeof descriptor.bootId === 'string' &&
        descriptor.bootId.length > 0 &&
        descriptor.bootId.length <= 512)) &&
    descriptorSocketPath(descriptor) !== null &&
    typeof descriptor.reconnectToken === 'string' &&
    /^[A-Za-z0-9_-]{32,256}$/.test(descriptor.reconnectToken) &&
    typeof descriptor.createdAt === 'string' &&
    Number.isFinite(Date.parse(descriptor.createdAt))
  );
}

function daemonDiscoveryError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code, daemonCode: code });
}

function probeSocketLiveness(endpointPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection(endpointPath);
    const timer = globalThis.setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, 250);
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

/**
 * Locate an active Relay terminal daemon without spawning or cleaning up any files.
 * Throws protocol_mismatch if an active daemon runs an incompatible protocol.
 */
export async function locateDaemon(
  options: EnsureDaemonOptions = {},
): Promise<EnsureDaemonResult> {
  const platform = options.platform ?? process.platform;
  const runtimeRoot = options.runtimeRoot ?? rireiDataHome(options);
  const descriptorPath = daemonDescriptorPath(runtimeRoot, options);
  const hash = createHash('sha256')
    .update(runtimeRoot)
    .digest('hex')
    .slice(0, 16);
  const endpoint = daemonEndpoint({ hash, platform });
  const canonicalSocketPath = endpoint.path;

  let descriptor: unknown = null;
  try {
    const stats = await lstat(descriptorPath);
    if (isSafeDescriptorPermissions(stats, platform)) {
      const raw = await readFile(descriptorPath, 'utf8');
      descriptor = JSON.parse(raw) as unknown;
    }
  } catch {
    // Descriptor missing or unreadable
  }

  const targetSocket = descriptorSocketPath(descriptor) ?? canonicalSocketPath;
  const live = await probeSocketLiveness(targetSocket);
  if (!live) {
    if (
      targetSocket !== canonicalSocketPath &&
      (await probeSocketLiveness(canonicalSocketPath))
    ) {
      throw daemonDiscoveryError(
        'A terminal daemon endpoint is active, but its descriptor points elsewhere. Please restart the daemon.',
        'protocol_mismatch',
      );
    }
    throw daemonDiscoveryError(
      'No active terminal daemon was found.',
      'daemon_not_found',
    );
  }

  if (
    descriptor &&
    typeof descriptor === 'object' &&
    !Array.isArray(descriptor) &&
    typeof (descriptor as { protocolVersion?: unknown }).protocolVersion ===
      'number' &&
    (descriptor as { protocolVersion: number }).protocolVersion !==
      DAEMON_PROTOCOL_VERSION
  ) {
    const protocolVersion = (descriptor as { protocolVersion: number })
      .protocolVersion;
    throw daemonDiscoveryError(
      `Terminal daemon protocol version mismatch (found v${protocolVersion}, expected v${DAEMON_PROTOCOL_VERSION}). Please restart the old daemon.`,
      'protocol_mismatch',
    );
  }
  if (validDaemonDescriptor(descriptor)) {
    return {
      socketPath: descriptor.socketPath,
      descriptorPath,
      reused: true,
    };
  }

  throw daemonDiscoveryError(
    'A terminal daemon endpoint is active, but its descriptor is invalid. Please restart the daemon.',
    'protocol_mismatch',
  );
}

/**
 * Ensure a healthy Relay terminal daemon is running, reusing an existing healthy
 * daemon or spawning a detached background process if none is active.
 */
export async function ensureDaemon(
  options: EnsureDaemonOptions = {},
): Promise<EnsureDaemonResult> {
  const platform = options.platform ?? process.platform;
  const runtimeRoot = options.runtimeRoot ?? rireiDataHome(options);
  const descriptorPath = daemonDescriptorPath(runtimeRoot, options);
  const hash = createHash('sha256')
    .update(runtimeRoot)
    .digest('hex')
    .slice(0, 16);
  const endpoint = daemonEndpoint({ hash, platform });
  const socketPath = endpoint.path;
  const timeoutMs = options.timeoutMs ?? 5000;

  // 1. Check existing descriptor
  try {
    const stats = await lstat(descriptorPath);
    if (isSafeDescriptorPermissions(stats, platform)) {
      const raw = await readFile(descriptorPath, 'utf8');
      const descriptor = JSON.parse(raw) as unknown;
      const candidateSocket = descriptorSocketPath(descriptor);
      if (candidateSocket) {
        const live = await probeSocketLiveness(candidateSocket);
        if (live) {
          const protocolVersion = (descriptor as { protocolVersion?: unknown })
            .protocolVersion;
          if (
            typeof protocolVersion === 'number' &&
            protocolVersion !== DAEMON_PROTOCOL_VERSION
          ) {
            throw daemonDiscoveryError(
              `Terminal daemon protocol version mismatch (found v${protocolVersion}, expected v${DAEMON_PROTOCOL_VERSION}). Please restart the old daemon.`,
              'protocol_mismatch',
            );
          }
          if (!validDaemonDescriptor(descriptor))
            throw daemonDiscoveryError(
              'A terminal daemon endpoint is active, but its descriptor is invalid. Refusing cleanup to avoid disrupting live sessions. Please restart the daemon.',
              'protocol_mismatch',
            );
          return {
            socketPath: descriptor.socketPath,
            descriptorPath,
            reused: true,
          };
        }
      }
    }
  } catch (error: unknown) {
    const candidate = error as { code?: string; daemonCode?: string } | null;
    if (
      candidate?.code === 'protocol_mismatch' ||
      candidate?.daemonCode === 'protocol_mismatch'
    ) {
      throw error;
    }
    // Descriptor missing or unreadable
  }

  // Refuse cleanup when the canonical endpoint is live but its descriptor is invalid
  const canonicalLive = await probeSocketLiveness(socketPath);
  if (canonicalLive) {
    throw daemonDiscoveryError(
      'A terminal daemon endpoint is active, but its descriptor is invalid. Refusing cleanup to avoid disrupting live sessions. Please restart the daemon.',
      'protocol_mismatch',
    );
  }

  // 2. Clean up stale descriptor and endpoint (only when daemon is not live)
  await rm(descriptorPath, { force: true }).catch(() => undefined);
  await cleanupEndpoint(endpoint).catch(() => undefined);

  // 3. Resolve CLI and Node paths
  const nodePath = options.nodePath ?? process.execPath;
  const defaultCli = process.argv[1]
    ? path.resolve(process.argv[1])
    : path.resolve(process.cwd(), 'dist', 'index.cjs');
  const cliPath = await realpath(options.cliPath ?? defaultCli);

  // 4. Spawn detached daemon process
  const child = spawn(
    nodePath,
    [
      cliPath,
      'daemon',
      '--internal',
      '--socket',
      socketPath,
      '--descriptor',
      descriptorPath,
      '--cli',
      cliPath,
      '--node',
      nodePath,
    ],
    {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env },
    },
  );

  child.unref();

  // 5. Poll for descriptor readiness
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const stats = await lstat(descriptorPath);
      if (isSafeDescriptorPermissions(stats, platform)) {
        const raw = await readFile(descriptorPath, 'utf8');
        const descriptor = JSON.parse(raw) as unknown;
        if (
          validDaemonDescriptor(descriptor) &&
          descriptor.protocolVersion === DAEMON_PROTOCOL_VERSION
        ) {
          const live = await probeSocketLiveness(descriptor.socketPath);
          if (live) {
            return {
              socketPath: descriptor.socketPath,
              descriptorPath,
              reused: false,
            };
          }
        }
      }
    } catch {
      // Continue polling
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error('Terminal daemon failed to start within the timeout period.');
}
