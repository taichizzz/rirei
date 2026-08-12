#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';
import { analyzeResultFile } from './lib.mjs';

const input = process.argv[2];
if (!input) {
  process.stderr.write(
    'Usage: node analyze.mjs <result.json> [analysis.json]\n',
  );
  process.exitCode = 1;
} else {
  const analysis = await analyzeResultFile(resolve(input));
  const output = process.argv[3];
  if (output)
    await writeFile(resolve(output), `${JSON.stringify(analysis, null, 2)}\n`);
  else process.stdout.write(`${JSON.stringify(analysis, null, 2)}\n`);
}
