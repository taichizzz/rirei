import type * as nodePty from 'node-pty';

declare const nodePtyLoader: {
  load(): typeof nodePty;
  packageRoot(): string;
  disposeExitedPty(terminal: nodePty.IPty): void;
};

export = nodePtyLoader;
