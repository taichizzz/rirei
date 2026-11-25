import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readlink, realpath } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';
import {
  snapshotIdentitySchema,
  type SnapshotIdentity,
} from './snapshot-schema.js';

const execute = promisify(execFile);
const digest = (value: string | Uint8Array) =>
  createHash('sha256').update(value).digest('hex');
export interface SnapshotLimits {
  maxFiles: number;
  maxFileBytes: number;
  maxBytes: number;
  maxGitBytes: number;
  timeoutMs: number;
}
export const COVERED_SNAPSHOT_LIMITS: Readonly<SnapshotLimits> = Object.freeze({
  maxFiles: 2000,
  maxFileBytes: 1024 * 1024,
  maxBytes: 16 * 1024 * 1024,
  maxGitBytes: 2 * 1024 * 1024,
  timeoutMs: 3000,
});
export interface SnapshotFile {
  path: string;
  kind: 'file' | 'symlink' | 'deleted' | 'gitlink' | 'unavailable';
  source: 'tracked' | 'untracked';
  mode: number | null;
  bytes: number | null;
  contentHash: string | null;
}
export interface CoveredSnapshot {
  identity: SnapshotIdentity;
  workspace: string;
  files: SnapshotFile[];
  omissions: Array<{ path?: string; reason: string }>;
  omittedDetails: number;
  capturedAt: string;
  elapsedMs: number;
  attempts: number;
  /** Optional derived observations; excluded from the v1 identity contract. */
  inspection?: SnapshotInspectionEntry[];
  /** Exact UTF-8 for explicitly requested files, retained only after consistent scans. */
  readFiles?: Array<{ path: string; text?: string; omission?: string }>;
}
export type InputChange =
  | 'none'
  | 'added'
  | 'modified'
  | 'deleted'
  | 'untracked'
  | 'unmerged'
  | 'unknown';
export interface SnapshotInspectionEntry {
  path: string;
  staged: InputChange;
  worktree: InputChange;
  headOid: string | null;
  indexOid: string | null;
  kind: SnapshotFile['kind'];
  contentHash: string | null;
  text?: string;
  omission?: string;
}
export interface SnapshotInspectionOptions {
  includeText: boolean;
  referencedPaths?: string[];
  file?: string;
}
export const SNAPSHOT_TEXT_LIMITS = Object.freeze({
  fileBytes: 64 * 1024,
  totalBytes: 256 * 1024,
  files: 16,
});
interface GitView {
  head: string;
  branch: string;
  common: string;
  tree: Buffer;
  index: Buffer;
  others: Buffer;
}
const dependencies = new Set([
  'package.json',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lock',
  'bun.lockb',
  'pyproject.toml',
  'poetry.lock',
  'uv.lock',
  'Pipfile.lock',
  'requirements.txt',
  'go.mod',
  'go.sum',
  'Cargo.toml',
  'Cargo.lock',
  'Gemfile.lock',
  'composer.lock',
  '.node-version',
  '.python-version',
]);
const sensitive = (file: string) =>
  file
    .split('/')
    .some(
      (part) =>
        /^\.env(?:\.|$)/i.test(part) ||
        [
          '.git-credentials',
          '.npmrc',
          'credentials',
          'credentials.json',
        ].includes(part.toLowerCase()) ||
        /\.(?:pem|p12|pfx|key)$/i.test(part),
    );
export { sensitive as sensitiveSnapshotPath };
const internal = (file: string) => {
  const lower = file.toLowerCase();
  return (
    lower === '.relay' ||
    lower.startsWith('.relay/') ||
    lower === '.git' ||
    lower.startsWith('.git/')
  );
};
const code = (value: unknown) => (value as NodeJS.ErrnoException)?.code;

/** A separate versioned identity. It never changes the legacy handoff/Git fingerprint contract. */
export async function inspectCoveredSnapshot(
  workspace: string,
  options: Partial<SnapshotLimits> = {},
  lifecycle: {
    afterScan?: (attempt: number) => Promise<void>;
    inspection?: SnapshotInspectionOptions;
    readFiles?: string[];
  } = {},
): Promise<CoveredSnapshot> {
  const limits = { ...COVERED_SNAPSHOT_LIMITS, ...options };
  if ((lifecycle.readFiles?.length ?? 0) > 8)
    throw new Error('At most eight source files can be retained per snapshot.');
  const requestedFiles = new Set(lifecycle.readFiles ?? []);
  for (const value of Object.values(limits))
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new Error('Snapshot limits must be positive safe integers.');
  const started = performance.now();
  const deadline = started + limits.timeoutMs;
  let root = path.resolve(workspace);
  // Repository-routing/pathspec variables inherited from a hook must not redirect
  // this workspace inspection to another index, worktree, or object database.
  const gitEnvironment = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        ([name]) => !name.toUpperCase().startsWith('GIT_'),
      ),
    ),
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
  };
  const omissions: CoveredSnapshot['omissions'] = [];
  let omittedDetails = 0;
  const reasons = new Set<string>();
  const note = (reason: string, file?: string) => {
    reasons.add(reason);
    if (omissions.length < 32)
      omissions.push({ ...(file ? { path: file } : {}), reason });
    else omittedDetails++;
  };
  const remaining = () => {
    const value = Math.floor(deadline - performance.now());
    if (value <= 0)
      throw Object.assign(new Error('Snapshot deadline reached.'), {
        code: 'SNAPSHOT_TIMEOUT',
      });
    return value;
  };
  async function bounded<T>(operation: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                Object.assign(new Error('Snapshot deadline reached.'), {
                  code: 'SNAPSHOT_TIMEOUT',
                }),
              ),
            remaining(),
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  async function git(args: string[], allowMissing = false): Promise<Buffer> {
    try {
      const result = await execute(
        'git',
        [
          '-c',
          'core.fsmonitor=false',
          '-c',
          'core.untrackedCache=false',
          ...args,
        ],
        {
          cwd: root,
          encoding: 'buffer',
          maxBuffer: limits.maxGitBytes,
          timeout: remaining(),
          killSignal: 'SIGKILL',
          windowsHide: true,
          env: gitEnvironment,
        },
      );
      return Buffer.from(result.stdout);
    } catch (error) {
      if (
        allowMissing &&
        [1, 128].includes((error as { code?: number }).code ?? 0)
      )
        return Buffer.alloc(0);
      throw error;
    }
  }
  const exclude = [
    '--',
    '.',
    ':(exclude,icase).relay',
    ':(exclude,icase).relay/**',
    ':(exclude,icase).git',
    ':(exclude,icase).git/**',
  ];
  const withoutInternalTreeEntries = (buffer: Buffer) => {
    const rows: Buffer[] = [];
    let start = 0;
    for (let end = 0; end < buffer.length; end++)
      if (buffer[end] === 0) {
        const row = buffer.subarray(start, end);
        start = end + 1;
        const tab = row.indexOf(9);
        if (tab < 0 || !internal(row.subarray(tab + 1).toString('utf8')))
          rows.push(Buffer.concat([row, Buffer.from([0])]));
      }
    return Buffer.concat(rows);
  };
  async function view(): Promise<GitView> {
    const head =
      (await git(['rev-parse', '--verify', 'HEAD'], true)).toString().trim() ||
      'unborn';
    const [branch, common, tree, index, others] = await Promise.all([
      git(['symbolic-ref', '-q', 'HEAD'], true),
      git(['rev-parse', '--path-format=absolute', '--git-common-dir']),
      head === 'unborn' ? Buffer.alloc(0) : git(['ls-tree', '-r', '-z', head]),
      git(['ls-files', '--stage', '-v', '-z', ...exclude]),
      git(['ls-files', '--others', '--exclude-standard', '-z', ...exclude]),
    ]);
    return {
      head,
      branch: branch.toString().trim() || 'detached',
      common: common.toString().trim(),
      tree: withoutInternalTreeEntries(tree),
      index,
      others,
    };
  }
  const metadata = (value: GitView) =>
    digest(
      JSON.stringify({
        head: value.head,
        branch: value.branch,
        common: value.common,
        tree: digest(value.tree),
        index: digest(value.index),
        others: digest(value.others),
      }),
    );
  function names(
    buffer: Buffer,
    staged: 'index' | 'head' | false,
  ): Array<{
    path: string;
    mode?: string;
    oid?: string;
    stage?: string;
    flag?: string;
  }> {
    const output = [];
    let start = 0;
    for (let end = 0; end < buffer.length; end++)
      if (buffer[end] === 0) {
        const entry = buffer.subarray(start, end);
        start = end + 1;
        try {
          if (staged) {
            const tab = entry.indexOf(9);
            if (tab < 0) throw new Error('Invalid index entry.');
            const prefix = entry.subarray(0, tab).toString('ascii').split(' ');
            if (
              staged === 'index'
                ? prefix.length !== 4 || !/^[0-3]$/.test(prefix[3] ?? '')
                : prefix.length !== 3
            )
              throw new Error('Invalid Git entry fields.');
            output.push({
              path: new TextDecoder('utf-8', { fatal: true }).decode(
                entry.subarray(tab + 1),
              ),
              mode: staged === 'index' ? prefix[1] : prefix[0],
              oid: prefix[2],
              stage: staged === 'index' ? prefix[3] : '0',
              flag: staged === 'index' ? prefix[0] : 'H',
            });
          } else
            output.push({
              path: new TextDecoder('utf-8', { fatal: true }).decode(entry),
            });
        } catch {
          note('path-encoding-or-index-format');
        }
      }
    if (start !== buffer.length) note('unterminated-git-path-output');
    return output;
  }
  async function safeFile(file: string): Promise<string> {
    if (
      path.isAbsolute(file) ||
      (process.platform === 'win32' && file.includes('\\')) ||
      file.split('/').some((part) => !part || part === '.' || part === '..') ||
      internal(file)
    )
      throw new Error('Invalid snapshot path.');
    const parts = file.split('/');
    let parent = root;
    for (const part of parts.slice(0, -1)) {
      parent = path.join(parent, part);
      const stat = await bounded(lstat(parent));
      if (stat.isSymbolicLink() || !stat.isDirectory())
        throw Object.assign(
          new Error('Snapshot ancestor is not a real directory.'),
          { code: 'SNAPSHOT_LINK' },
        );
    }
    return path.join(root, ...parts);
  }
  let totalBytes = 0;
  let attempts = 0;
  async function pass() {
    const before = await view();
    const headEntries = names(before.tree, 'head');
    const indexEntries = names(before.index, 'index');
    const tracked = [...headEntries, ...indexEntries];
    const heads = new Map(headEntries.map((entry) => [entry.path, entry]));
    const indexes = new Map(
      indexEntries
        .filter((entry) => entry.stage === '0')
        .map((entry) => [entry.path, entry]),
    );
    const conflicts = new Set(
      indexEntries
        .filter((entry) => entry.stage !== '0')
        .map((entry) => entry.path),
    );
    const captured = new Map<
      string,
      { oid: string; text?: string; omission?: string }
    >();
    let textBytes = 0;
    let textFiles = 0;
    const readFiles: NonNullable<CoveredSnapshot['readFiles']> = [];
    const paths = new Map<
      string,
      { source: SnapshotFile['source']; gitlink: boolean }
    >();
    for (const entry of tracked) {
      if (entry.stage !== '0') note('unmerged-index', entry.path);
      if (entry.flag?.toUpperCase() === 'S')
        note('sparse-index-not-covered', entry.path);
      paths.set(entry.path, {
        source: 'tracked',
        gitlink: entry.mode === '160000',
      });
    }
    for (const entry of names(before.others, false))
      if (!paths.has(entry.path))
        paths.set(entry.path, { source: 'untracked', gitlink: false });
    const files: SnapshotFile[] = [];
    let bytesRead = 0;
    for (const [file, item] of [...paths].sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    )) {
      remaining();
      if (files.length >= limits.maxFiles) {
        note('file-count-limit');
        break;
      }
      const record: SnapshotFile = {
        path: file,
        source: item.source,
        kind: 'unavailable',
        mode: null,
        bytes: null,
        contentHash: null,
      };
      files.push(record);
      if (internal(file)) {
        note('internal-path-enumerated', file);
        continue;
      }
      if (sensitive(file)) {
        note('sensitive-input-excluded', file);
        continue;
      }
      if (item.gitlink) note('submodule-content-not-covered', file);
      try {
        const full = await safeFile(file);
        const info = await bounded(lstat(full, { bigint: true }));
        record.mode = Number(info.mode & 0o777n);
        record.bytes = Number(info.size);
        if (info.isSymbolicLink()) {
          record.kind = 'symlink';
          record.contentHash = digest(await bounded(readlink(full)));
          note('symlink-target-not-covered', file);
          continue;
        }
        if (item.gitlink) {
          record.kind = 'gitlink';
          // The index/tree bind the pinned gitlink commit. A child Git lookup
          // could fall back to the parent when uninitialized; do not claim to
          // observe the checked-out commit or nested dirty contents here.
          note('submodule-checkout-not-covered', file);
          continue;
        }
        if (!info.isFile()) {
          note('nonregular-input', file);
          continue;
        }
        record.kind = 'file';
        if (
          info.size > BigInt(limits.maxFileBytes) ||
          bytesRead + Number(info.size) > limits.maxBytes
        ) {
          note('byte-limit', file);
          continue;
        }
        const resolved = await bounded(realpath(full));
        const relative = path.relative(root, resolved);
        if (
          relative.startsWith('..' + path.sep) ||
          relative === '..' ||
          path.isAbsolute(relative)
        )
          throw Object.assign(new Error('Input escaped its workspace.'), {
            code: 'SNAPSHOT_LINK',
          });
        const opening = open(
          resolved,
          constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
        );
        const handle = await bounded(opening).catch((error: unknown) => {
          void opening.then(
            (handle) => handle.close().catch(() => {}),
            () => {},
          );
          throw error;
        });
        try {
          const initial = await bounded(handle.stat({ bigint: true }));
          if (
            initial.ino !== info.ino ||
            initial.dev !== info.dev ||
            !initial.isFile()
          )
            throw Object.assign(new Error('Input changed.'), {
              code: 'SNAPSHOT_CHANGED',
            });
          if ((await bounded(realpath(full))) !== resolved)
            throw Object.assign(new Error('Input namespace changed.'), {
              code: 'SNAPSHOT_CHANGED',
            });
          const hash = createHash('sha256');
          const objectId = lifecycle.inspection
            ? createHash(
                (indexes.get(file)?.oid ?? heads.get(file)?.oid ?? before.head)
                  .length === 64
                  ? 'sha256'
                  : 'sha1',
              ).update(`blob ${initial.size}\0`)
            : undefined;
          const textChunks: Buffer[] = [];
          const retainFile =
            requestedFiles.has(file) && initial.size <= 1024n * 1024n;
          const readChunks: Buffer[] = [];
          const collectText =
            lifecycle.inspection?.includeText &&
            initial.size <= BigInt(SNAPSHOT_TEXT_LIMITS.fileBytes) &&
            (!lifecycle.inspection.file || lifecycle.inspection.file === file);
          let count = 0;
          const chunk = Buffer.alloc(64 * 1024);
          while (true) {
            const result = await bounded(
              handle.read(
                chunk,
                0,
                Math.min(chunk.length, limits.maxFileBytes - count + 1),
                null,
              ),
            );
            if (!result.bytesRead) break;
            count += result.bytesRead;
            bytesRead += result.bytesRead;
            totalBytes += result.bytesRead;
            if (count > limits.maxFileBytes || bytesRead > limits.maxBytes)
              throw Object.assign(new Error('Input limit.'), {
                code: 'SNAPSHOT_BYTES',
              });
            hash.update(chunk.subarray(0, result.bytesRead));
            objectId?.update(chunk.subarray(0, result.bytesRead));
            if (collectText && count <= SNAPSHOT_TEXT_LIMITS.fileBytes)
              textChunks.push(Buffer.from(chunk.subarray(0, result.bytesRead)));
            if (retainFile && count <= 1024 * 1024)
              readChunks.push(Buffer.from(chunk.subarray(0, result.bytesRead)));
          }
          const after = await bounded(handle.stat({ bigint: true }));
          const current = await bounded(lstat(full, { bigint: true }));
          const stamp = (stat: typeof initial) =>
            `${stat.dev}:${stat.ino}:${stat.size}:${stat.mode}:${stat.mtimeNs}:${stat.ctimeNs}`;
          if (
            stamp(initial) !== stamp(after) ||
            stamp(after) !== stamp(current) ||
            count !== Number(initial.size)
          )
            throw Object.assign(new Error('Input changed.'), {
              code: 'SNAPSHOT_CHANGED',
            });
          record.contentHash = hash.digest('hex');
          record.bytes = count;
          if (requestedFiles.has(file)) {
            const value: NonNullable<CoveredSnapshot['readFiles']>[number] = {
              path: file,
            };
            if (!retainFile) value.omission = 'source-size-limit';
            else {
              const bytes = Buffer.concat(readChunks);
              try {
                if (bytes.includes(0)) throw new Error('Binary source.');
                value.text = new TextDecoder('utf-8', {
                  fatal: true,
                  ignoreBOM: true,
                }).decode(bytes);
              } catch {
                value.omission = 'binary-or-invalid-utf8';
              }
            }
            readFiles.push(value);
          }
          if (objectId) {
            const oid = objectId.digest('hex');
            const relevant =
              oid !== heads.get(file)?.oid ||
              oid !== indexes.get(file)?.oid ||
              lifecycle.inspection?.referencedPaths?.includes(file) ||
              lifecycle.inspection?.file === file;
            const value: { oid: string; text?: string; omission?: string } = {
              oid,
            };
            if (relevant && lifecycle.inspection?.includeText) {
              if (!collectText) value.omission = 'source-size-limit';
              else if (
                textFiles >= SNAPSHOT_TEXT_LIMITS.files ||
                textBytes + count > SNAPSHOT_TEXT_LIMITS.totalBytes
              )
                value.omission = 'source-capture-limit';
              else {
                const bytes = Buffer.concat(textChunks);
                try {
                  if (bytes.includes(0)) throw new Error('Binary input.');
                  value.text = new TextDecoder('utf-8', { fatal: true }).decode(
                    bytes,
                  );
                  textBytes += count;
                  textFiles++;
                } catch {
                  value.omission = 'binary-or-invalid-utf8';
                }
              }
            }
            captured.set(file, value);
          }
        } finally {
          const closing = handle.close();
          if (performance.now() >= deadline) void closing.catch(() => {});
          else await bounded(closing);
        }
      } catch (error) {
        if (code(error) === 'ENOENT' && item.source === 'tracked')
          record.kind = item.gitlink ? 'gitlink' : 'deleted';
        else if (code(error) === 'SNAPSHOT_TIMEOUT') throw error;
        else
          note(
            code(error) === 'SNAPSHOT_CHANGED'
              ? 'input-changed-during-read'
              : code(error) === 'SNAPSHOT_BYTES'
                ? 'byte-limit'
                : code(error) === 'SNAPSHOT_LINK' || code(error) === 'ELOOP'
                  ? 'symlink-ancestor-not-covered'
                  : 'unreadable-input',
            file,
          );
      }
    }
    const after = await view();
    const stable = metadata(before) === metadata(after);
    const workspaceId = digest(
      (process.platform === 'win32' ? root.toLowerCase() : root) +
        '\0' +
        before.common,
    );
    const indexDigest = digest(before.index);
    const headTreeDigest = digest(before.tree);
    const worktreeDigest = digest(JSON.stringify(files));
    const dependencyDigest = digest(
      JSON.stringify(
        files
          .filter((file) => dependencies.has(path.posix.basename(file.path)))
          .map((file) => ({
            path: file.path,
            contentHash: file.contentHash,
            kind: file.kind,
          })),
      ),
    );
    const id = digest(
      JSON.stringify({
        algorithm: 'rirei-covered-inputs-v1',
        workspaceId,
        metadata: metadata(after),
        files,
      }),
    );
    const inspection: SnapshotInspectionEntry[] | undefined =
      lifecycle.inspection
        ? files.map((file) => {
            const head = heads.get(file.path);
            const index = indexes.get(file.path);
            const content = captured.get(file.path);
            const staged: InputChange = conflicts.has(file.path)
              ? 'unmerged'
              : !head && index
                ? 'added'
                : head && !index
                  ? 'deleted'
                  : head?.oid !== index?.oid || head?.mode !== index?.mode
                    ? 'modified'
                    : 'none';
            const mode =
              file.mode !== null && file.mode & 0o111 ? '100755' : '100644';
            const worktree: InputChange =
              file.source === 'untracked'
                ? 'untracked'
                : file.kind === 'deleted'
                  ? index
                    ? 'deleted'
                    : 'none'
                  : file.kind !== 'file' || !content
                    ? 'unknown'
                    : !index
                      ? 'added'
                      : content.oid !== index.oid ||
                          (process.platform !== 'win32' && mode !== index.mode)
                        ? 'modified'
                        : 'none';
            return {
              path: file.path,
              staged,
              worktree,
              headOid: head?.oid ?? null,
              indexOid: index?.oid ?? null,
              kind: file.kind,
              contentHash: file.contentHash,
              ...(content?.text !== undefined ? { text: content.text } : {}),
              ...(content?.omission ? { omission: content.omission } : {}),
            };
          })
        : undefined;
    return {
      id,
      workspaceId,
      head: after.head,
      indexDigest,
      headTreeDigest,
      worktreeDigest,
      dependencyDigest,
      stable,
      files,
      filesConsidered: paths.size,
      inspection,
      readFiles,
    };
  }
  let latest: Awaited<ReturnType<typeof pass>> | undefined;
  let consistent = false;
  let fatal = false;
  try {
    root = await bounded(realpath(root));
    const top = (await git(['rev-parse', '--show-toplevel']))
      .toString('utf8')
      .replace(/\r?\n$/, '');
    if ((await bounded(realpath(top))) !== root) {
      note('repository-root-mismatch');
      throw new Error('Snapshot workspace must be a repository root.');
    }
    latest = await pass();
    attempts++;
    if (lifecycle.afterScan) await bounded(lifecycle.afterScan(attempts));
    // A second full content scan catches edits that do not change Git's filename/status view.
    for (let retry = 0; retry < 2; retry++) {
      const next = await pass();
      attempts++;
      if (lifecycle.afterScan) await bounded(lifecycle.afterScan(attempts));
      if (latest.id === next.id && latest.stable && next.stable) {
        latest = next;
        consistent = true;
        break;
      }
      latest = next;
    }
    if (!consistent) note('concurrent-input-change');
  } catch (error) {
    fatal = true;
    note(
      code(error) === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
        ? 'git-output-limit'
        : code(error) === 'SNAPSHOT_TIMEOUT' ||
            (error as { killed?: boolean }).killed
          ? 'snapshot-deadline'
          : 'snapshot-unavailable',
    );
  }
  const status = fatal
    ? latest
      ? 'partial'
      : 'unavailable'
    : !consistent
      ? 'unstable'
      : reasons.size
        ? 'partial'
        : 'complete';
  const identity = snapshotIdentitySchema.parse({
    schemaVersion: 1,
    algorithm: 'rirei-covered-inputs-v1',
    id: latest?.id ?? digest(root + '\0unavailable'),
    workspaceId: latest?.workspaceId ?? digest(root),
    head: latest?.head ?? 'unavailable',
    indexDigest: latest?.indexDigest ?? digest(''),
    headTreeDigest: latest?.headTreeDigest ?? digest(''),
    worktreeDigest: latest?.worktreeDigest ?? digest(''),
    dependencyDigest: latest?.dependencyDigest ?? digest(''),
    coverage: {
      status,
      scope: 'tracked-and-nonignored-untracked',
      ignoredInputs: 'not-covered',
      filesConsidered: latest?.filesConsidered ?? 0,
      filesHashed:
        latest?.files.filter((file) => file.kind === 'file' && file.contentHash)
          .length ?? 0,
      bytesRead: totalBytes,
      reasons: [...reasons].slice(0, 24),
    },
  });
  return {
    identity,
    workspace: root,
    files: latest?.files ?? [],
    omissions,
    omittedDetails,
    capturedAt: new Date().toISOString(),
    elapsedMs: performance.now() - started,
    attempts,
    ...(latest?.inspection ? { inspection: latest.inspection } : {}),
    ...(requestedFiles.size && consistent && !fatal
      ? { readFiles: latest?.readFiles ?? [] }
      : {}),
  };
}
