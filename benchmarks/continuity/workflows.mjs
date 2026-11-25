import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { performance } from 'node:perf_hooks';

const execute = promisify(execFile);
export const fingerprint = (value) =>
  createHash('sha256').update(value).digest('hex');
const manifest =
  JSON.stringify({
    private: true,
    type: 'module',
    scripts: { test: 'node --test test/public.test.mjs' },
    dependencies: {},
  }) + '\n';
const publicTest = (body) =>
  `import assert from 'node:assert/strict';\nimport { test } from 'node:test';\nimport * as api from '../src/index.mjs';\ntest('public API', () => { ${body} });\n`;

export const WORKFLOWS = [
  {
    id: 'tenant-ledger',
    request:
      'Finish the dependency-free event ledger: atomic batch ingestion, tenant-isolated balances as of a timestamp, and ordered history.',
    firstStage: 'src/identity.mjs',
    requirements: [
      'Keep the createLedger() export. Its object exposes applyBatch(rows), balanceAt(tenant, account, asOf = Infinity), and history(tenant, account).',
      'Tenant, account, and event IDs are opaque case-sensitive nonempty strings. Do not case-fold or concatenate unescaped separator-based keys.',
      'An event is {tenant, account, id, at, amount}. at and amount must be safe integers; amount is signed integer cents. Validate the entire batch before any mutation and throw TypeError for any malformed row, including a malformed duplicate.',
      'Event IDs are unique within a tenant, across its accounts. Keep the first occurrence, including duplicates in the same batch. applyBatch returns the number of newly accepted events.',
      'balanceAt includes events whose at <= asOf. An unknown account has balance zero. history is ordered by ascending at, retaining insertion order on ties.',
      'Do not mutate input rows. Copy rows on ingestion and when returning history so callers cannot corrupt retained balances. Add no dependencies and keep the public tests unchanged.',
    ],
    files: {
      'package.json': manifest,
      'src/index.mjs': "export { createLedger } from './ledger.mjs';\n",
      'src/identity.mjs':
        'export function eventKey(row) { return row.id.toLowerCase(); }\n',
      'src/ledger.mjs':
        "import { eventKey } from './identity.mjs';\nexport function createLedger() {\n  const events = new Map();\n  return {\n    applyBatch(rows) { for (const row of rows) events.set(eventKey(row), row); return rows.length; },\n    balanceAt(tenant, account, asOf = Infinity) { throw new Error('balanceAt is unfinished'); },\n    history(tenant, account) { return [...events.values()]; },\n  };\n}\n",
      'test/public.test.mjs': publicTest(
        "const ledger = api.createLedger(); assert.equal(ledger.applyBatch([{tenant:'a',account:'cash',id:'one',at:1,amount:50}]), 1); assert.equal(ledger.balanceAt('a','cash',1),50); assert.equal(ledger.history('a','cash').length,1);",
      ),
    },
    reference: {
      'src/identity.mjs':
        'export function eventKey(row) { return JSON.stringify([row.tenant, row.id]); }\n',
      'src/ledger.mjs': `import { eventKey } from './identity.mjs';
export function createLedger() {
  const events = new Map();
  return {
    applyBatch(rows) {
      if (!Array.isArray(rows) || rows.some(row => !row || typeof row !== 'object' ||
        ['tenant','account','id'].some(key => typeof row[key] !== 'string' || row[key].length === 0) ||
        !Number.isSafeInteger(row.at) || !Number.isSafeInteger(row.amount))) throw new TypeError('Invalid batch');
      let accepted = 0;
      for (const row of rows) { const key = eventKey(row); if (!events.has(key)) { events.set(key, {...row}); accepted++; } }
      return accepted;
    },
    balanceAt(tenant, account, asOf = Infinity) {
      return [...events.values()].filter(row => row.tenant === tenant && row.account === account && row.at <= asOf).reduce((sum,row) => sum + row.amount, 0);
    },
    history(tenant, account) {
      return [...events.values()].filter(row => row.tenant === tenant && row.account === account).sort((a,b) => a.at - b.at).map(row => ({...row}));
    },
  };
}
`,
    },
    checks: {
      'basic-asof':
        "const l = api.createLedger(); l.applyBatch([{tenant:'T',account:'A',id:'1',at:4,amount:50},{tenant:'T',account:'A',id:'2',at:5,amount:-7}]); assert.equal(l.balanceAt('T','A',4),50); assert.equal(l.balanceAt('T','A'),43); assert.equal(l.balanceAt('T','missing'),0);",
      'tenant-and-case-isolation':
        "const l = api.createLedger(); assert.equal(l.applyBatch([{tenant:'T',account:'A',id:'X',at:1,amount:3},{tenant:'t',account:'A',id:'X',at:1,amount:5},{tenant:'T',account:'a',id:'x',at:1,amount:7}]),3); assert.equal(l.balanceAt('T','A'),3); assert.equal(l.balanceAt('t','A'),5); assert.equal(l.balanceAt('T','a'),7);",
      'duplicate-first-wins':
        "const l = api.createLedger(); const row = {tenant:'T',account:'A',id:'X',at:1,amount:9}; assert.equal(l.applyBatch([row,{...row,amount:80}]),1); assert.equal(l.applyBatch([{...row,account:'B',amount:100}]),0); assert.equal(l.balanceAt('T','A'),9); assert.equal(l.balanceAt('T','B'),0);",
      'atomic-validation':
        "const l = api.createLedger(); const row = {tenant:'T',account:'A',id:'X',at:1,amount:9}; assert.throws(() => l.applyBatch([row,{...row,id:'Y',amount:NaN}]),TypeError); assert.equal(l.balanceAt('T','A'),0); l.applyBatch([row]); assert.throws(() => l.applyBatch([{...row,amount:1.5}]),TypeError); assert.throws(() => l.applyBatch([{...row,id:'Y',at:Infinity}]),TypeError); assert.throws(() => l.applyBatch([{...row,id:''}]),TypeError); assert.equal(l.balanceAt('T','A'),9);",
      'defensive-copies':
        "const l = api.createLedger(); const row = {tenant:'T',account:'A',id:'X',at:1,amount:9}; l.applyBatch([row]); row.amount = 99; const history = l.history('T','A'); history[0].amount = 88; history.push({...row,id:'Y'}); assert.equal(l.balanceAt('T','A'),9); assert.equal(l.history('T','A').length,1);",
      'history-order-and-keys':
        "const l = api.createLedger(); l.applyBatch([{tenant:'a|b',account:'A',id:'c',at:2,amount:1},{tenant:'a',account:'A',id:'b|c',at:1,amount:2},{tenant:'a|b',account:'A',id:'d',at:1,amount:3},{tenant:'a|b',account:'A',id:'e',at:1,amount:4}]); assert.equal(l.balanceAt('a','A'),2); assert.deepEqual(l.history('a|b','A').map(row => row.id),['d','e','c']);",
    },
  },
  {
    id: 'cursor-feed',
    request:
      'Finish a dependency-free cursor-paginated tenant activity feed with deterministic ordering and stable continuation after insertions and deletions.',
    firstStage: 'src/cursor.mjs',
    requirements: [
      'Keep the listPage(records, {tenant, limit, cursor = null}) export, returning {items, nextCursor}. Tenant and record IDs are opaque case-sensitive nonempty strings.',
      'Filter by exact tenant, then order by at descending and id ascending using JavaScript ordinal string comparison, not localeCompare. Do not mutate records or return their original object references.',
      'limit must be an integer from 1 through 50; throw TypeError otherwise. Timestamps are safe integers.',
      'The cursor is canonical unpadded base64url of UTF-8 JSON {v:1,tenant,at,id}. Decode and validate every field, reject malformed/noncanonical encodings, and throw TypeError if the cursor belongs to another tenant.',
      'Continue strictly after the cursor ordering tuple, even if that record was deleted. Newer inserted records must not shift continuation. Do not use offsets or require finding the cursor record.',
      'nextCursor is null when there are no further matching records; otherwise encode the last returned record. Add no dependencies and keep the provided public tests unchanged.',
    ],
    files: {
      'package.json': manifest,
      'src/index.mjs': "export { listPage } from './feed.mjs';\n",
      'src/cursor.mjs':
        'export function encodeCursor(value) { return String(value); }\nexport function decodeCursor(value) { return Number(value); }\n',
      'src/feed.mjs':
        "import { encodeCursor, decodeCursor } from './cursor.mjs';\nexport function listPage(records, {tenant, limit, cursor = null}) {\n  return {items: [], nextCursor: null};\n}\n",
      'test/public.test.mjs': publicTest(
        "const result = api.listPage([{tenant:'a',id:'one',at:2},{tenant:'a',id:'two',at:1}],{tenant:'a',limit:1}); assert.equal(result.items[0].id,'one'); assert.equal(typeof result.nextCursor,'string');",
      ),
    },
    reference: {
      'src/cursor.mjs': `export function encodeCursor(value) { return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url'); }
export function decodeCursor(value) {
  try {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
    const bytes = Buffer.from(value, 'base64url');
    if (bytes.toString('base64url') !== value) throw new Error();
    const data = JSON.parse(new TextDecoder('utf-8', {fatal:true}).decode(bytes));
    if (!data || Array.isArray(data) || data.v !== 1 || typeof data.tenant !== 'string' || !data.tenant || !Number.isSafeInteger(data.at) || typeof data.id !== 'string' || !data.id) throw new Error();
    return data;
  } catch { throw new TypeError('Invalid cursor'); }
}
`,
      'src/feed.mjs': `import { encodeCursor, decodeCursor } from './cursor.mjs';
export function listPage(records, {tenant, limit, cursor = null}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new TypeError('Invalid limit');
  const position = cursor === null ? null : decodeCursor(cursor);
  if (position && position.tenant !== tenant) throw new TypeError('Cursor tenant mismatch');
  const remaining = records.filter(row => row.tenant === tenant && (!position || row.at < position.at || (row.at === position.at && row.id > position.id))).sort((a,b) => b.at - a.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const items = remaining.slice(0,limit).map(row => ({...row}));
  const last = items.at(-1);
  return {items, nextCursor: remaining.length > limit ? encodeCursor({v:1,tenant,at:last.at,id:last.id}) : null};
}
`,
    },
    checks: {
      'ordering-and-tenant':
        "const rows = [{tenant:'T',id:'b',at:9},{tenant:'T',id:'A',at:9},{tenant:'t',id:'x',at:20},{tenant:'T',id:'a',at:9}]; const page = api.listPage(rows,{tenant:'T',limit:3}); assert.deepEqual(page.items.map(row=>row.id),['A','a','b']); assert.equal(page.nextCursor,null);",
      'wire-cursor':
        "const rows = [{tenant:'T',id:'b',at:9},{tenant:'T',id:'c',at:8}]; const page = api.listPage(rows,{tenant:'T',limit:1}); assert.match(page.nextCursor,/^[A-Za-z0-9_-]+$/); assert.deepEqual(JSON.parse(Buffer.from(page.nextCursor,'base64url').toString('utf8')),{v:1,tenant:'T',at:9,id:'b'});",
      'stable-insert-delete':
        "const rows = [{tenant:'T',id:'a',at:9},{tenant:'T',id:'b',at:9},{tenant:'T',id:'c',at:8}]; const first = api.listPage(rows,{tenant:'T',limit:1}); const changed = [{tenant:'T',id:'new',at:99},...rows.slice(1)]; const next = api.listPage(changed,{tenant:'T',limit:5,cursor:first.nextCursor}); assert.deepEqual(next.items.map(row=>row.id),['b','c']); assert.equal(next.nextCursor,null);",
      'cursor-validation':
        "const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url'); const options = {tenant:'T',limit:2}; for (const cursor of ['!', 'e30=', encode(null), encode({v:2,tenant:'T',at:1,id:'a'}), encode({v:1,tenant:'T',at:'1',id:'a'}), encode({v:1,tenant:'T',at:1,id:''}), encode({v:1,tenant:'other',at:1,id:'a'})]) assert.throws(() => api.listPage([],{...options,cursor}),TypeError);",
      'limits-and-empty':
        "for (const limit of [0,-1,51,1.5,NaN,Infinity,'2']) assert.throws(() => api.listPage([],{tenant:'T',limit}),TypeError); assert.deepEqual(api.listPage([],{tenant:'T',limit:1}),{items:[],nextCursor:null});",
      'defensive-copies':
        "const rows = [{tenant:'T',id:'b',at:1},{tenant:'T',id:'a',at:2}]; const before = JSON.stringify(rows); const page = api.listPage(rows,{tenant:'T',limit:2}); assert.equal(JSON.stringify(rows),before); page.items[0].at = 99; assert.equal(rows[1].at,2);",
    },
  },
].map((task) => ({
  ...task,
  files: {
    'README.md': `# Interrupted implementation\n\n${task.request}\n\nRun public tests with npm test.\n`,
    ...task.files,
  },
}));

export function workflowHash(task) {
  return fingerprint(
    JSON.stringify({
      id: task.id,
      request: task.request,
      requirements: task.requirements,
      firstStage: task.firstStage,
      files: task.files,
      reference: task.reference,
      checks: task.checks,
    }),
  );
}

export async function writeFiles(directory, files) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  for (const [name, text] of Object.entries(files)) {
    const file = path.join(directory, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, text, { mode: 0o600 });
  }
}

export async function gradeWorkflow(task, workspace) {
  const started = performance.now();
  const startedAt = new Date().toISOString();
  const temporary = await mkdtemp(
    path.join(os.tmpdir(), 'rirei-workflow-grader-'),
  );
  try {
    const driver = path.join(temporary, 'acceptance.mjs');
    await writeFile(
      driver,
      `import assert from 'node:assert/strict';
const api = await import(${JSON.stringify(pathToFileURL(path.join(workspace, 'src/index.mjs')).href)});
const results = [];
${Object.entries(task.checks)
  .map(
    ([name, check]) =>
      `try { { ${check} } results.push({name:${JSON.stringify(name)},passed:true}); } catch { results.push({name:${JSON.stringify(name)},passed:false}); }`,
  )
  .join('\n')}
process.stdout.write(JSON.stringify(results));\n`,
    );
    let groups;
    try {
      const result = await execute(process.execPath, [driver], {
        cwd: workspace,
        timeout: 10000,
        maxBuffer: 1024 * 1024,
      });
      groups = JSON.parse(result.stdout);
    } catch {
      groups = Object.keys(task.checks).map((name) => ({
        name,
        passed: false,
      }));
    }
    const unchanged = await Promise.all(
      Object.entries(task.files)
        .filter(([name]) => !name.startsWith('src/'))
        .map(
          async ([name, text]) =>
            (await readFile(path.join(workspace, name), 'utf8').catch(
              () => null,
            )) === text,
        ),
    );
    groups.push({
      name: 'provided-files-unchanged',
      passed: unchanged.every(Boolean),
    });
    return {
      passed: groups.every((group) => group.passed),
      groups,
      gradingTiming: { startedAt, durationMs: performance.now() - started },
    };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function validateWorkflows() {
  const temporary = await mkdtemp(
    path.join(os.tmpdir(), 'rirei-workflow-validation-'),
  );
  try {
    const results = [];
    for (const task of WORKFLOWS) {
      const workspace = path.join(temporary, task.id);
      await writeFiles(workspace, task.files);
      const initial = await gradeWorkflow(task, workspace);
      assert.equal(
        initial.passed,
        false,
        `${task.id}: initial snapshot must fail`,
      );
      await writeFiles(workspace, task.reference);
      const reference = await gradeWorkflow(task, workspace);
      assert.equal(
        reference.passed,
        true,
        `${task.id}: reference failed ${JSON.stringify(reference.groups)}`,
      );
      await execute(process.execPath, ['--test', 'test/public.test.mjs'], {
        cwd: workspace,
        timeout: 10000,
      });
      results.push({
        id: task.id,
        hash: workflowHash(task),
        initialRejected: true,
        referencePassed: true,
        groups: reference.groups.length,
      });
    }
    return results;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
