import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  getBinarySubpath,
  getPlatformPackageName,
  resolveCcusageBinary,
} from '../../src/token-usage/resolve.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function makeTmpDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  directories.push(dir);
  return dir;
}

describe('ccusage binary resolver', () => {
  it('identifies package names and subpaths for all 6 target platform/arch combinations', () => {
    const platforms: Array<[NodeJS.Platform, string, string, string]> = [
      [
        'darwin',
        'arm64',
        '@ccusage/ccusage-darwin-arm64',
        path.join('bin', 'ccusage'),
      ],
      [
        'darwin',
        'x64',
        '@ccusage/ccusage-darwin-x64',
        path.join('bin', 'ccusage'),
      ],
      [
        'linux',
        'arm64',
        '@ccusage/ccusage-linux-arm64',
        path.join('bin', 'ccusage'),
      ],
      [
        'linux',
        'x64',
        '@ccusage/ccusage-linux-x64',
        path.join('bin', 'ccusage'),
      ],
      [
        'win32',
        'arm64',
        '@ccusage/ccusage-win32-arm64',
        path.join('bin', 'ccusage.exe'),
      ],
      [
        'win32',
        'x64',
        '@ccusage/ccusage-win32-x64',
        path.join('bin', 'ccusage.exe'),
      ],
    ];

    for (const [platform, arch, expectedPkg, expectedSubpath] of platforms) {
      expect(getPlatformPackageName(platform, arch)).toBe(expectedPkg);
      expect(getBinarySubpath(platform)).toBe(expectedSubpath);
    }
  });

  it('returns null for unsupported platform or arch', () => {
    expect(
      getPlatformPackageName('freebsd' as unknown as NodeJS.Platform, 'x64'),
    ).toBeNull();
    expect(getPlatformPackageName('darwin', 'ia32')).toBeNull();
  });

  it('resolves binary from packaged resources path', async () => {
    const resources = await makeTmpDir('packaged-resources-');
    const pkg = '@ccusage/ccusage-darwin-arm64';
    const binDir = path.join(resources, 'cli', 'node_modules', pkg, 'bin');
    await mkdir(binDir, { recursive: true });

    const binaryFile = path.join(binDir, 'ccusage');
    await writeFile(binaryFile, '#!/bin/sh\necho "ccusage mock"\n', {
      mode: 0o755,
    });
    await writeFile(
      path.join(resources, 'cli', 'node_modules', pkg, 'package.json'),
      JSON.stringify({ name: pkg, version: '20.0.24' }),
    );

    const resolved = resolveCcusageBinary({
      platform: 'darwin',
      arch: 'arm64',
      resourcesPath: resources,
    });

    expect(resolved).not.toBeNull();
    expect(resolved?.pathClass).toBe('packaged');
    expect(resolved?.binaryPath).toBe(binaryFile);
    expect(resolved?.version).toBe('20.0.24');
  });

  it('resolves binary from baseDir node_modules across simulated platforms', async () => {
    const testCases: Array<{
      platform: NodeJS.Platform;
      arch: string;
      subpath: string;
    }> = [
      {
        platform: 'darwin',
        arch: 'arm64',
        subpath: path.join('bin', 'ccusage'),
      },
      { platform: 'darwin', arch: 'x64', subpath: path.join('bin', 'ccusage') },
      {
        platform: 'linux',
        arch: 'arm64',
        subpath: path.join('bin', 'ccusage'),
      },
      { platform: 'linux', arch: 'x64', subpath: path.join('bin', 'ccusage') },
      {
        platform: 'win32',
        arch: 'arm64',
        subpath: path.join('bin', 'ccusage.exe'),
      },
      {
        platform: 'win32',
        arch: 'x64',
        subpath: path.join('bin', 'ccusage.exe'),
      },
    ];

    for (const { platform, arch, subpath } of testCases) {
      const baseDir = await makeTmpDir(`resolver-${platform}-${arch}-`);
      const pkg = getPlatformPackageName(platform, arch)!;
      const binDir = path.join(
        baseDir,
        'node_modules',
        pkg,
        path.dirname(subpath),
      );
      await mkdir(binDir, { recursive: true });

      const binaryPath = path.join(baseDir, 'node_modules', pkg, subpath);
      await writeFile(binaryPath, 'mock binary', { mode: 0o755 });
      await writeFile(
        path.join(baseDir, 'node_modules', pkg, 'package.json'),
        JSON.stringify({ name: pkg, version: '20.0.24' }),
      );

      const resolved = resolveCcusageBinary({
        platform,
        arch,
        baseDir,
      });

      expect(resolved).not.toBeNull();
      expect(resolved?.pathClass).toBe('dev');
      expect(resolved?.binaryPath).toBe(binaryPath);
      expect(resolved?.version).toBe('20.0.24');
    }
  });

  async function plantBinary(
    nodeModulesParent: string,
    platform: NodeJS.Platform = 'darwin',
    arch = 'arm64',
  ): Promise<string> {
    const pkg = getPlatformPackageName(platform, arch)!;
    const pkgDir = path.join(nodeModulesParent, 'node_modules', pkg);
    const binaryPath = path.join(pkgDir, getBinarySubpath(platform));
    await mkdir(path.dirname(binaryPath), { recursive: true });
    await writeFile(binaryPath, 'mock binary', { mode: 0o755 });
    await writeFile(
      path.join(pkgDir, 'package.json'),
      JSON.stringify({ name: pkg, version: '20.0.24' }),
    );
    return binaryPath;
  }

  it('finds the binary next to the packaged CLI without Electron resourcesPath', async () => {
    // The desktop app runs Resources/cli/index.cjs under plain node.
    const root = await makeTmpDir('packaged-cli-');
    const cliDir = path.join(root, 'Rirei.app', 'Contents', 'Resources', 'cli');
    const binaryPath = await plantBinary(cliDir);

    const resolved = resolveCcusageBinary({
      platform: 'darwin',
      arch: 'arm64',
      moduleFile: path.join(cliDir, 'index.cjs'),
    });

    expect(resolved?.binaryPath).toBe(binaryPath);
    expect(resolved?.pathClass).toBe('packaged');
  });

  it('finds a hoisted binary above a globally installed CLI', async () => {
    const lib = await makeTmpDir('npm-global-');
    const binaryPath = await plantBinary(lib);
    const cliFile = path.join(
      lib,
      'node_modules',
      '@taichizzz',
      'rirei',
      'dist',
      'index.cjs',
    );

    const resolved = resolveCcusageBinary({
      platform: 'darwin',
      arch: 'arm64',
      moduleFile: cliFile,
    });

    expect(resolved?.binaryPath).toBe(binaryPath);
    expect(resolved?.pathClass).toBe('npm');
  });

  it.skipIf(process.platform === 'win32')(
    'built CLI finds its own ccusage from an unrelated directory and ignores one planted there',
    async () => {
      const pkg = getPlatformPackageName();
      if (!pkg) return;
      const cliPath = path.resolve('dist/index.cjs');
      const project = await makeTmpDir('unrelated-project-');
      const home = await makeTmpDir('empty-home-');
      const marker = path.join(project, 'planted-binary-ran');
      // A repository must never be able to supply the binary Rirei executes.
      const planted = path.join(
        project,
        'node_modules',
        pkg,
        getBinarySubpath(),
      );
      await mkdir(path.dirname(planted), { recursive: true });
      await writeFile(planted, `#!/bin/sh\ntouch "${marker}"\n`, {
        mode: 0o755,
      });

      const result = spawnSync(
        process.execPath,
        [
          cliPath,
          'usage',
          'tokens',
          '--refresh',
          '--agent',
          'gemini',
          '--json',
        ],
        {
          cwd: project,
          encoding: 'utf8',
          timeout: 60_000,
          env: {
            ...process.env,
            HOME: home,
            RIREI_DATA_HOME: path.join(home, 'rirei'),
          },
        },
      );

      expect(result.status).toBe(0);
      const report = JSON.parse(result.stdout) as {
        agents: Array<{ id: string; errorCode?: string }>;
      };
      const gemini = report.agents.find((agent) => agent.id === 'gemini');
      expect(gemini?.errorCode).not.toBe('binary_unavailable');
      expect(existsSync(marker)).toBe(false);
    },
  );

  it('returns null when binary file is missing', async () => {
    const emptyDir = await makeTmpDir('empty-base-');
    const resolved = resolveCcusageBinary({
      platform: 'linux',
      arch: 'x64',
      baseDir: emptyDir,
      resourcesPath: emptyDir,
      moduleFile: path.join(emptyDir, 'cli', 'index.cjs'),
    });
    // Keep module lookup inside the fixture instead of the host installation.
    expect(resolved).toBeNull();
  });
});
