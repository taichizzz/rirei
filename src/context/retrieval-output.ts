import {
  BATCH_MAX_CHARACTERS,
  RETRIEVAL_DEFAULT_CHARACTERS,
  RETRIEVAL_MAX_CHARACTERS,
  RETRIEVAL_MIN_CHARACTERS,
  RetrievalError,
  type RetrievalEnvelope,
  type RetrievalFormat,
  type RetrievalOptions,
  type RetrievalPayload,
} from './retrieval-schema.js';

export function retrievalOutputOptions(
  options: RetrievalOptions,
  batch = false,
) {
  const format = options.format ?? 'json';
  const maximum = batch ? BATCH_MAX_CHARACTERS : RETRIEVAL_MAX_CHARACTERS;
  const maxCharacters =
    options.maxCharacters ??
    (batch ? BATCH_MAX_CHARACTERS : RETRIEVAL_DEFAULT_CHARACTERS);
  if (format !== 'text' && format !== 'json')
    throw new RetrievalError(
      'invalid_format',
      'Retrieval format must be text or json.',
    );
  if (
    !Number.isSafeInteger(maxCharacters) ||
    maxCharacters < (batch ? 2400 : RETRIEVAL_MIN_CHARACTERS) ||
    maxCharacters > maximum
  )
    throw new RetrievalError(
      'invalid_budget',
      `Retrieval response budget must be ${batch ? 2400 : RETRIEVAL_MIN_CHARACTERS}–${maximum} characters.`,
    );
  return { format, maxCharacters };
}

function payloadText(payload: RetrievalPayload): string[] {
  return [
    `${payload.kind}: ${JSON.stringify(payload.source)}`,
    `Requested: ${JSON.stringify(payload.requested)}; returned: ${JSON.stringify(payload.returned)}; more retained content: ${payload.truncated}.`,
    ...(payload.text === undefined ? [] : [JSON.stringify(payload.text)]),
    ...(payload.matches ?? []).map((value) => JSON.stringify(value)),
    `Cursor: ${payload.nextCursor ?? 'null'}`,
  ];
}
function serialize(
  envelope: RetrievalEnvelope,
  format: RetrievalFormat,
): string {
  if (format === 'json') return JSON.stringify(envelope) + '\n';
  return (
    [
      'RETRIEVAL v1',
      `Workspace: ${envelope.workspace === null ? 'path omitted; relay context task' : JSON.stringify(envelope.workspace)} [${envelope.workspaceId}]`,
      envelope.notice,
      ...(envelope.result ? payloadText(envelope.result) : []),
      ...(envelope.results ?? []).flatMap((item) => [
        `Query ${item.id}: ${item.status}${item.error ? ` [${item.error.code}] ${item.error.message}` : ''}`,
        ...(item.result ? payloadText(item.result) : []),
      ]),
      ...(envelope.kind === 'retrieval-batch'
        ? [`Batch cursor: ${envelope.nextCursor ?? 'null'}`]
        : []),
      `Budget: ${envelope.budget.usedCharacters}/${envelope.budget.maxCharacters} characters; ~${envelope.budget.estimatedTokens} tokens (estimate).`,
    ].join('\n') + '\n'
  );
}

export function measureRetrieval(
  envelope: RetrievalEnvelope,
  format: RetrievalFormat,
): { envelope: RetrievalEnvelope; output: string } {
  for (let count = 0; count < 8; count++) {
    const output = serialize(envelope, format);
    const used = output.length;
    const tokens = Math.ceil(used / 4);
    if (
      envelope.budget.usedCharacters === used &&
      envelope.budget.estimatedTokens === tokens
    )
      return { envelope, output };
    envelope.budget.usedCharacters = used;
    envelope.budget.estimatedTokens = tokens;
  }
  throw new RetrievalError(
    'invalid_envelope',
    'Retrieval response size did not stabilize.',
  );
}

export function lowerBoundary(text: string, offset: number): number {
  return offset > 0 &&
    offset < text.length &&
    /[\uD800-\uDBFF]/.test(text[offset - 1]!) &&
    /[\uDC00-\uDFFF]/.test(text[offset]!)
    ? offset - 1
    : offset;
}

export function fitRetrievalText(
  text: string,
  start: number,
  end: number,
  build: (end: number) => RetrievalPayload,
  fits: (payload: RetrievalPayload) => boolean,
): RetrievalPayload {
  let maximum = lowerBoundary(text, Math.min(end, text.length));
  // A requested one-code-unit page must still make progress over a surrogate pair.
  if (maximum === start && start < text.length)
    maximum = Math.min(
      text.length,
      start + (lowerBoundary(text, start + 1) === start ? 2 : 1),
    );
  const full = build(maximum);
  if (fits(full)) return full;
  let low = start;
  let high = maximum;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(build(lowerBoundary(text, middle)))) low = middle;
    else high = middle - 1;
  }
  const actual = lowerBoundary(text, low);
  if (actual <= start && start < text.length)
    throw new RetrievalError(
      'budget_too_small',
      'The response budget cannot fit source metadata and a progressing window; request a larger --max-characters value.',
    );
  const result = build(actual);
  if (!fits(result))
    throw new RetrievalError(
      'budget_too_small',
      'The response budget cannot fit source metadata; request a larger --max-characters value.',
    );
  return result;
}
