export const MAX_TIMEOUT_MS = 2_147_483_647;

const IMF_FIXDATE =
  /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;

export function parseRetryAfter(value, nowMs = Date.now()) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (/^\d+$/.test(text)) {
    const milliseconds = BigInt(text) * 1_000n;
    return milliseconds > BigInt(MAX_TIMEOUT_MS)
      ? MAX_TIMEOUT_MS
      : Number(milliseconds);
  }
  if (!IMF_FIXDATE.test(text)) return null;
  const timestamp = Date.parse(text);
  if (!Number.isFinite(timestamp)) return null;
  return Math.min(MAX_TIMEOUT_MS, Math.max(0, timestamp - nowMs));
}

export function retryDelay(response, nowMs = Date.now()) {
  const value = response?.headers?.get?.('retry-after');
  return parseRetryAfter(value, nowMs);
}
