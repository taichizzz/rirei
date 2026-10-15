/* global require, __filename, exports */
const { createRequire } = require('node:module');
const path = require('node:path');

const unpackedSegment = `${path.sep}app.asar.unpacked${path.sep}`;
const archiveSegment = `${path.sep}app.asar${path.sep}`;
const modulePath = __filename.replace(unpackedSegment, archiveSegment);
const runtimeRequire = createRequire(modulePath);

exports.load = () => runtimeRequire('node-pty');
exports.packageRoot = () =>
  path
    .dirname(runtimeRequire.resolve('node-pty/package.json'))
    .replace(archiveSegment, unpackedSegment);

/** @param {import('node-pty').IPty} terminal */
exports.disposeExitedPty = (terminal) => {
  // node-pty 1.1's public kill enumerates console PIDs, even after child exit.
  // Release only this exited ConPTY session's handles and output worker.
  const agent = terminal._agent;
  if (!agent?._useConpty || agent.exitCode === undefined) return;
  agent._inSocket.destroy();
  agent._outSocket.destroy();
  try {
    agent._ptyNative.kill(agent._pty, agent._useConptyDll);
  } finally {
    agent._conoutSocketWorker.dispose();
  }
};
