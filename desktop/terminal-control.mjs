export const TERMINAL_PROTOCOL_VERSION = 1;
const ACTIONS = new Set(['interrupt', 'terminate', 'kill', 'resize']);

export function terminalControlFrame(action, fields = {}) {
  if (!ACTIONS.has(action))
    throw new Error(`Invalid terminal action: ${action}`);
  return `${JSON.stringify({ version: TERMINAL_PROTOCOL_VERSION, action, ...fields })}\n`;
}

export function parseTerminalProtocolFrame(line) {
  if (typeof line !== 'string' || line.length > 4096) return null;
  try {
    const frame = JSON.parse(line);
    return frame?.version === TERMINAL_PROTOCOL_VERSION &&
      typeof frame.type === 'string'
      ? frame
      : null;
  } catch {
    return null;
  }
}
