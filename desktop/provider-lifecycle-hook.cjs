/* global require */
const net = require('node:net');

const state = process.argv[2];
const socketPath = process.env.RIREI_LIFECYCLE_SOCKET;
const terminalId = process.env.RIREI_TERMINAL_ID;
const token = process.env.RIREI_LIFECYCLE_TOKEN;
const allowed = new Set(['working', 'needs_permission', 'waiting_for_input']);

// Lifecycle reporting must never block or alter the provider's own decision.
if (!allowed.has(state) || !socketPath || !terminalId || !token)
  process.exit(0);

const socket = net.createConnection(socketPath);
let buffer = '';
let requestSent = false;
const finish = () => {
  clearTimeout(timer);
  socket.destroy();
  process.exit(0);
};
const timer = setTimeout(finish, 1500);

socket.once('connect', () => {
  socket.write(
    `${JSON.stringify({
      v: 1,
      type: 'lifecycle_hello',
      terminalId,
      token,
    })}\n`,
  );
});
socket.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  if (buffer.length > 128 * 1024) return finish();
  while (buffer.includes('\n')) {
    const offset = buffer.indexOf('\n');
    const line = buffer.slice(0, offset);
    buffer = buffer.slice(offset + 1);
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      return finish();
    }
    if (frame.type === 'welcome' && !requestSent) {
      requestSent = true;
      socket.write(
        `${JSON.stringify({
          v: 1,
          type: 'request',
          id: '1',
          op: 'set_lifecycle',
          body: { terminalId, lifecycleState: state },
        })}\n`,
      );
    } else if (frame.type === 'response' && frame.id === '1') {
      return finish();
    }
  }
});
socket.once('error', finish);
socket.once('close', finish);
