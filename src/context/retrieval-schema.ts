import { z } from 'zod';
import { contextObservationSchema } from './schema.js';

export const RETRIEVAL_DEFAULT_CHARACTERS = 2000;
export const RETRIEVAL_MAX_CHARACTERS = 8000;
export const RETRIEVAL_MIN_CHARACTERS = 1200;
export const BATCH_MAX_CHARACTERS = 12000;
export const BATCH_QUERY_LIMIT = 8;
export const QUERY_FILE_MAX_BYTES = 32 * 1024;

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const offset = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const label = z
  .string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,39}$/)
  .optional();
export const retrievalQuerySchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('evidence'),
      id: label,
      eventId: z.string().regex(/^e-[a-f0-9]{32}$/),
      start: offset.default(0),
      length: z.number().int().min(1).max(8000).default(2000),
    })
    .strict(),
  z
    .object({
      type: z.literal('read'),
      id: label,
      file: z.string().min(1).max(4096),
      startLine: z
        .number()
        .int()
        .min(1)
        .max(Number.MAX_SAFE_INTEGER)
        .default(1),
      lineCount: z.number().int().min(1).max(1000).default(60),
      snapshot: digest.optional(),
      contentHash: digest.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('find'),
      id: label,
      file: z.string().min(1).max(16000).optional(),
      kind: contextObservationSchema.shape.kind.optional(),
      toolId: z.string().min(1).max(256).optional(),
      commandId: z
        .string()
        .regex(/^c-[a-f0-9]{32}$/)
        .optional(),
      limit: z.number().int().min(1).max(20).default(5),
    })
    .strict(),
]);
export const batchRequestSchema = z
  .object({
    schemaVersion: z.literal(1),
    queries: z.array(retrievalQuerySchema).min(1).max(BATCH_QUERY_LIMIT),
  })
  .strict();
export type RetrievalQuery = z.infer<typeof retrievalQuerySchema>;
export type RetrievalFormat = 'text' | 'json';
export interface RetrievalOptions {
  format?: RetrievalFormat;
  maxCharacters?: number;
  cursor?: string;
  snapshot?: string;
}
export class RetrievalError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'RetrievalError';
  }
}

export function parseRetrievalQuery(
  value: unknown,
  defaultSnapshot?: string,
): RetrievalQuery {
  const parsed = retrievalQuerySchema.safeParse(value);
  if (!parsed.success)
    throw new RetrievalError(
      'invalid_query',
      'Invalid retrieval query: use supported fields and bounded ranges.',
    );
  const query = parsed.data;
  if (
    defaultSnapshot !== undefined &&
    !digest.safeParse(defaultSnapshot).success
  )
    throw new RetrievalError(
      'invalid_snapshot',
      'Invalid covered snapshot ID.',
    );
  if (query.type === 'read' && !query.snapshot && defaultSnapshot)
    query.snapshot = defaultSnapshot;
  return query;
}

export interface RetrievalPayload {
  kind: 'evidence-window' | 'file-window' | 'evidence-matches';
  source: Record<string, unknown>;
  requested: Record<string, number>;
  returned: Record<string, number>;
  text?: string;
  matches?: Array<Record<string, unknown>>;
  truncated: boolean;
  nextCursor: string | null;
}
export interface BatchItem {
  id: string;
  status: 'ok' | 'error' | 'deferred' | 'done';
  result?: RetrievalPayload;
  error?: { code: string; message: string };
}
export interface RetrievalEnvelope {
  schemaVersion: 1;
  workspace: string | null;
  workspaceId: string;
  notice: string;
  result?: RetrievalPayload;
  kind?: 'retrieval-batch';
  results?: BatchItem[];
  nextCursor?: string | null;
  budget: {
    maxCharacters: number;
    usedCharacters: number;
    estimatedTokens: number;
  };
}
