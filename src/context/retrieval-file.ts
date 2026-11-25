import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { relativeInspectionPath } from './inspection.js';
import { sensitiveSnapshotPath } from './snapshot.js';
import { QUERY_FILE_MAX_BYTES, RetrievalError } from './retrieval-schema.js';
import { retrievalHash } from './retrieval-cursor.js';

export function assertRetrievalPath(file: string): void {
  if (!relativeInspectionPath(file) || sensitiveSnapshotPath(file))
    throw new RetrievalError(
      'invalid_path',
      'Use a non-sensitive workspace-relative file without traversal, symlinks, or recorder metadata.',
    );
}

/** Read-only request transport; may be ignored by Git, but never follows a link. */
export async function readRetrievalRequestFile(
  workspace: string,
  file: string,
): Promise<{ text: string; digest: string }> {
  assertRetrievalPath(file);
  const deadline = performance.now() + 3000;
  async function bounded<T>(operation: Promise<T>): Promise<T> {
    if (performance.now() >= deadline) {
      void operation.catch(() => {});
      throw new RetrievalError(
        'request_unavailable',
        'Retrieval request file exceeded its read deadline.',
      );
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new RetrievalError(
                  'request_unavailable',
                  'Retrieval request file exceeded its read deadline.',
                ),
              ),
            Math.max(1, deadline - performance.now()),
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  try {
    const root = await bounded(realpath(workspace));
    let directory = root;
    for (const part of file.split('/').slice(0, -1)) {
      directory = path.join(directory, part);
      const stat = await bounded(lstat(directory));
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error();
    }
    const full = path.join(root, ...file.split('/'));
    const before = await bounded(lstat(full, { bigint: true }));
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.size > BigInt(QUERY_FILE_MAX_BYTES)
    )
      throw new Error();
    const resolved = await bounded(realpath(full));
    const relative = path.relative(root, resolved);
    if (
      relative === '..' ||
      relative.startsWith('..' + path.sep) ||
      path.isAbsolute(relative)
    )
      throw new Error();
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
        !initial.isFile() ||
        initial.ino !== before.ino ||
        initial.dev !== before.dev ||
        (await bounded(realpath(full))) !== resolved
      )
        throw new Error();
      const bytes = Buffer.alloc(QUERY_FILE_MAX_BYTES + 1);
      let count = 0;
      while (count < bytes.length) {
        const result = await bounded(
          handle.read(bytes, count, bytes.length - count, count),
        );
        if (!result.bytesRead) break;
        count += result.bytesRead;
      }
      const stamp = (value: typeof initial) =>
        `${value.dev}:${value.ino}:${value.size}:${value.mode}:${value.mtimeNs}:${value.ctimeNs}`;
      if (
        count > QUERY_FILE_MAX_BYTES ||
        count !== Number(initial.size) ||
        stamp(initial) !==
          stamp(await bounded(handle.stat({ bigint: true }))) ||
        stamp(initial) !== stamp(await bounded(lstat(full, { bigint: true })))
      )
        throw new Error();
      const body = bytes.subarray(0, count);
      return {
        text: new TextDecoder('utf-8', { fatal: true }).decode(body),
        digest: retrievalHash(body),
      };
    } finally {
      const closing = handle.close();
      if (performance.now() >= deadline) void closing.catch(() => {});
      else await bounded(closing);
    }
  } catch (error) {
    if (error instanceof RetrievalError) throw error;
    throw new RetrievalError(
      'request_unavailable',
      'Retrieval request must be a stable regular UTF-8 workspace file of at most 32 KiB.',
    );
  }
}
