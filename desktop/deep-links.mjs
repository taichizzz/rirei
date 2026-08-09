const TERMINAL_DEEP_LINK =
  /^rirei:\/\/terminal\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;

export function parseTerminalDeepLink(value) {
  if (typeof value !== 'string') return null;
  const match = TERMINAL_DEEP_LINK.exec(value);
  return match ? { terminalId: match[1].toLowerCase() } : null;
}

export function terminalDeepLinksFromArgv(argv) {
  if (!Array.isArray(argv)) return [];
  return argv.map(parseTerminalDeepLink).filter((intent) => intent !== null);
}

export function terminalOwnerWebContentsId(terminals, terminalId) {
  if (!(terminals instanceof Map) || typeof terminalId !== 'string')
    return null;
  const ownerWebContentsId = terminals.get(terminalId)?.ownerWebContentsId;
  return Number.isInteger(ownerWebContentsId) ? ownerWebContentsId : null;
}

export class DeepLinkIntentQueue {
  constructor(limit = 32) {
    this.pending = [];
    this.limit = limit;
  }

  enqueue(intent) {
    this.pending = [
      ...this.pending.filter(
        (candidate) => candidate.terminalId !== intent.terminalId,
      ),
      intent,
    ].slice(-this.limit);
  }

  flush(deliver) {
    const queued = this.pending;
    this.pending = [];
    const retry = [];
    for (const intent of queued) {
      try {
        if (deliver(intent) !== true) retry.push(intent);
      } catch {
        retry.push(intent);
      }
    }
    this.pending = [...retry, ...this.pending];
  }

  get size() {
    return this.pending.length;
  }
}
