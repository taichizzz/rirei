import { chmod, mkdir } from 'node:fs/promises';
import { build } from 'esbuild';

await mkdir('dist', { recursive: true });
await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['node-pty', 'ink', 'yoga-layout'],
  outfile: 'dist/index.cjs',
});

if (process.platform !== 'win32') await chmod('dist/index.cjs', 0o755);
