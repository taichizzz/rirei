import net from 'node:net';
import { describe, expect, it } from 'vitest';
import {
  findListeningPorts,
  parseLsofOutput,
  parseNetstatOutput,
  parseSsOutput,
} from '../../src/platform/port-discovery.js';

describe('port discovery', () => {
  it('parses Windows netstat output for the target PID', () => {
    const netstatOutput = `
Active Connections

  Proto  Local Address          Foreign Address        State           PID
  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       848
  TCP    127.0.0.1:49812        0.0.0.0:0              LISTENING       12345
  TCP    127.0.0.1:49813        127.0.0.1:49814        ESTABLISHED     12345
  TCP    0.0.0.0:54321          0.0.0.0:0              LISTENING       12345
  TCP    127.0.0.1:8080         0.0.0.0:0              LISTENING       99999
  TCP    [::]:445               [::]:0                 LISTENING       4
`;

    const ports = parseNetstatOutput(netstatOutput, 12345);
    expect(ports.sort((a, b) => a - b)).toEqual([49812, 54321]);
  });

  it('parses macOS lsof output', () => {
    const lsofOutput = `
p12345
f3
n127.0.0.1:4096
n*:8080
n127.0.0.1:51234
n[::1]:3000
`;

    const ports = parseLsofOutput(lsofOutput);
    expect(ports.sort((a, b) => a - b)).toEqual([3000, 4096, 51234]);
  });

  it('parses Linux ss output for target PID', () => {
    const ssOutput = `
State  Recv-Q Send-Q Local Address:Port  Peer Address:PortProcess
LISTEN 0      128        127.0.0.1:3000       0.0.0.0:*    users:(("node",pid=12345,fd=18))
LISTEN 0      128          0.0.0.0:8080       0.0.0.0:*    users:(("nginx",pid=999,fd=6))
LISTEN 0      512        127.0.0.1:5432       0.0.0.0:*    users:(("postgres",pid=12345,fd=4))
`;

    const ports = parseSsOutput(ssOutput, 12345);
    expect(ports.sort((a, b) => a - b)).toEqual([3000, 5432]);
  });

  it('discovers live listening ports for current process on host platform', async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', () => resolve()),
    );
    const address = server.address() as net.AddressInfo;
    const boundPort = address.port;

    try {
      const ports = await findListeningPorts(process.pid);
      if (process.platform === 'darwin' || process.platform === 'linux') {
        expect(ports).toContain(boundPort);
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
