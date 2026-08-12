export const MAX_TIMEOUT_MS = 2_147_483_647;

export function parseRetryAfter(value, nowMs = Date.now()) {
  void value;
  void nowMs;
  throw new Error('TODO: implement Retry-After parsing');
}

export function retryDelay(response, nowMs = Date.now()) {
  void response;
  void nowMs;
  throw new Error('TODO: implement response header handling');
}
