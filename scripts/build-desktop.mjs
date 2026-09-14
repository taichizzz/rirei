import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import spawn from 'cross-spawn';

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const packageJson = JSON.parse(
  await readFile(path.join(projectRoot, 'package.json'), 'utf8'),
);
const electronPackage = JSON.parse(
  await readFile(
    path.join(projectRoot, 'node_modules', 'electron', 'package.json'),
    'utf8',
  ),
);
const temporaryRoot = await mkdtemp(
  path.join(os.tmpdir(), 'rirei-desktop-build-'),
);
const stageRoot = path.join(temporaryRoot, 'app');

function absoluteResource(resource) {
  if (typeof resource === 'string') return path.join(projectRoot, resource);
  return {
    ...resource,
    from: path.join(projectRoot, resource.from),
  };
}

try {
  await mkdir(path.join(stageRoot, 'node_modules'), { recursive: true });
  await cp(path.join(projectRoot, 'desktop'), path.join(stageRoot, 'desktop'), {
    recursive: true,
    verbatimSymlinks: true,
  });
  for (const dependency of ['node-pty', 'node-addon-api']) {
    await cp(
      path.join(projectRoot, 'node_modules', dependency),
      path.join(stageRoot, 'node_modules', dependency),
      { recursive: true, verbatimSymlinks: true },
    );
  }

  const build = structuredClone(packageJson.build);
  build.electronVersion = electronPackage.version;
  build.directories = {
    ...build.directories,
    output: path.join(projectRoot, 'dist'),
  };
  build.extraResources = build.extraResources.map(absoluteResource);
  build.mac = {
    ...build.mac,
    icon: path.join(projectRoot, build.mac.icon),
  };

  await writeFile(
    path.join(stageRoot, 'package.json'),
    `${JSON.stringify(
      {
        name: packageJson.name,
        version: packageJson.version,
        description: packageJson.description,
        license: packageJson.license,
        author: packageJson.author,
        private: true,
        type: 'module',
        main: 'desktop/main.mjs',
        dependencies: {
          'node-pty': packageJson.dependencies['node-pty'],
        },
        build,
      },
      null,
      2,
    )}\n`,
  );

  const executable = path.join(
    projectRoot,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'electron-builder.cmd' : 'electron-builder',
  );
  const args = process.argv.slice(2);
  const result = spawn.sync(executable, args, {
    cwd: stageRoot,
    env: process.env,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exitCode = result.status ?? 1;
} finally {
  await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 5 });
}
