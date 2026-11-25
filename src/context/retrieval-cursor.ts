import { createHash } from 'node:crypto';
import { z } from 'zod';
import { RetrievalError } from './retrieval-schema.js';

export const retrievalHash = (value: string | Uint8Array) =>
  createHash('sha256').update(value).digest('hex');
const cursorSchema = z
  .object({
    v: z.literal(1),
    k: z.enum(['evidence', 'read', 'find', 'batch']),
    b: z.string().regex(/^[a-f0-9]{64}$/),
    p: z
      .array(z.number().int().min(-2).max(Number.MAX_SAFE_INTEGER))
      .min(1)
      .max(8),
    r: z.number().int().min(0).max(7),
    h: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
type Cursor = z.infer<typeof cursorSchema>;

/** Untrusted, checksummed continuation state. A cursor never grants access to a source. */
export function encodeRetrievalCursor(
  kind: Cursor['k'],
  binding: string,
  positions: number[],
  round = 0,
): string {
  const body = { v: 1 as const, k: kind, b: binding, p: positions, r: round };
  return Buffer.from(
    JSON.stringify({ ...body, h: retrievalHash(JSON.stringify(body)) }),
  ).toString('base64url');
}
export function decodeRetrievalCursor(
  value: string,
  kind: Cursor['k'],
  binding: string,
  count = 1,
): Cursor {
  try {
    if (value.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(value))
      throw new Error();
    const bytes = Buffer.from(value, 'base64url');
    if (bytes.toString('base64url') !== value) throw new Error();
    const cursor = cursorSchema.parse(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
    );
    const { h, ...body } = cursor;
    if (
      h !== retrievalHash(JSON.stringify(body)) ||
      cursor.k !== kind ||
      cursor.b !== binding ||
      cursor.p.length !== count ||
      cursor.r >= count
    )
      throw new Error();
    return cursor;
  } catch {
    throw new RetrievalError(
      'stale_cursor',
      'Continuation cursor is invalid or stale for this task, workspace, source, or query. Repeat the same query against current sources.',
    );
  }
}
