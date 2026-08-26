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
