const ACTIONS = new Set(['interrupt', 'terminate', 'kill']);

export function terminalControlFrame(action) {
  if (!ACTIONS.has(action))
    throw new Error(`Invalid terminal action: ${action}`);
  return `${JSON.stringify({ action })}\n`;
}
