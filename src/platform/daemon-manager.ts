import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, rm } from 'node:fs/promises';
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
      const descriptor = JSON.parse(raw) as DaemonDescriptor;
      if (
        descriptor.schemaVersion === 1 &&
        descriptor.socketPath &&
        descriptor.pid > 0
      ) {
        const live = await probeSocketLiveness(descriptor.socketPath);
        if (live) {
          return {
            socketPath: descriptor.socketPath,
            descriptorPath,
            reused: true,
          };
        }
      }
    }
  } catch {
    // Descriptor missing or unreadable
  }

  // 2. Clean up stale descriptor and endpoint
  await rm(descriptorPath, { force: true }).catch(() => undefined);
  await cleanupEndpoint(endpoint).catch(() => undefined);

  // 3. Resolve CLI and Node paths
  const nodePath = options.nodePath ?? process.execPath;
  const defaultCli = process.argv[1]
    ? path.resolve(process.argv[1])
    : path.resolve(process.cwd(), 'dist', 'index.cjs');
  const cliPath = options.cliPath ?? defaultCli;

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
        const descriptor = JSON.parse(raw) as DaemonDescriptor;
        if (
          descriptor.schemaVersion === 1 &&
          descriptor.socketPath &&
          descriptor.pid > 0
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
