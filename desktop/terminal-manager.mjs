import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';

export class TerminalManager {
  constructor(
    maxTerminals = 4,
    maxBuffer = 1_000_000,
    maxPendingOutput = 256_000,
  ) {
    this.terminals = new Map();
    this.MAX_TERMINALS = maxTerminals;
    this.MAX_BUFFER = maxBuffer;
    this.MAX_PENDING_OUTPUT = maxPendingOutput;
  }

  runningCount() {
    let count = 0;
    for (const t of this.terminals.values()) {
      if (['starting', 'running', 'waiting', 'stopping'].includes(t.status)) {
        count++;
      }
    }
    return count;
  }

  reserveTerminal(
    ownerWebContentsId,
    workspaceId,
    branchLabel,
    project,
    provider,
  ) {
    if (this.runningCount() >= this.MAX_TERMINALS) {
      throw new Error(
        `Maximum of ${this.MAX_TERMINALS} active terminals reached application-wide.`,
      );
    }
    const workspaceClaimed = Array.from(this.terminals.values()).some(
      (terminal) =>
        terminal.project === project &&
        terminal.workspaceId === workspaceId &&
        ['starting', 'running', 'waiting', 'stopping'].includes(
          terminal.status,
        ),
    );
    if (workspaceClaimed)
      throw new Error(
        'This working tree is already claimed by another terminal.',
      );
    let id;
    do {
      id = randomUUID();
    } while (this.terminals.has(id));

    const managed = {
      id,
      ownerWebContentsId,
      workspaceId,
      branchLabel,
      project,
      provider,
      child: null,
      status: 'starting',
      hidden: false,
      createdAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      buffer: '',
      sequence: 0,
      outputSequence: 0,
      finalized: false,
      exitCode: null,
      signal: null,
      error: null,
      bridge: null,
      bridgeError: null,
      decoders: {
        stdout: new StringDecoder('utf8'),
        stderr: new StringDecoder('utf8'),
      },
      pendingOutput: [],
      pendingOutputSize: 0,
      pendingOutputSequence: 0,
      awaitingOutputAck: false,
      inFlightOutputSequence: 0,
      lastAcknowledgedSequence: 0,
      pendingExit: null,
      _stopTimers: [],
    };
    this.terminals.set(id, managed);
    return managed;
  }

  attachChild(id, child) {
    const t = this.terminals.get(id);
    if (!t) return false;
    t.child = child;
    return true;
  }

  cancelReservation(id) {
    const terminal = this.terminals.get(id);
    if (!terminal || terminal.child || terminal.status !== 'starting')
      return false;
    this.terminals.delete(id);
    return true;
  }

  get(id, ownerWebContentsId) {
    const t = this.terminals.get(id);
    if (t && t.ownerWebContentsId === ownerWebContentsId) return t;
    return null;
  }

  getAllForOwner(ownerWebContentsId) {
    const results = [];
    for (const t of this.terminals.values()) {
      if (t.ownerWebContentsId === ownerWebContentsId) results.push(t);
    }
    return results;
  }

  appendOutput(id, dataBuf, stream = 'stdout') {
    const t = this.terminals.get(id);
    if (!t) return null;
    const decoder = t.decoders[stream];
    if (!decoder) return null;
    t.lastActivityAt = new Date().toISOString();
    const text = decoder.write(dataBuf);
    if (!text) return null;
    t.buffer += text;
    if (t.buffer.length > this.MAX_BUFFER) {
      const marker = '\r\n[Relay: earlier terminal output truncated]\r\n';
      t.buffer = marker + t.buffer.slice(-(this.MAX_BUFFER - marker.length));
    }
    t.sequence++;
    t.outputSequence = t.sequence;
    this.queuePendingOutput(t, text, t.sequence);
    return { text, sequence: t.sequence };
  }

  flushOutput(id) {
    const t = this.terminals.get(id);
    if (!t) return null;
    t.lastActivityAt = new Date().toISOString();
    const text = `${t.decoders.stdout.end()}${t.decoders.stderr.end()}`;
    if (!text) return null;
    t.buffer += text;
    if (t.buffer.length > this.MAX_BUFFER) {
      const marker = '\r\n[Relay: earlier terminal output truncated]\r\n';
      t.buffer = marker + t.buffer.slice(-(this.MAX_BUFFER - marker.length));
    }
    t.sequence++;
    t.outputSequence = t.sequence;
    this.queuePendingOutput(t, text, t.sequence);
    return { text, sequence: t.sequence };
  }

  queuePendingOutput(terminal, text, sequence) {
    if (!text) return;
    terminal.pendingOutput.push({ data: text, sequence });
    terminal.pendingOutputSize += text.length;
    terminal.pendingOutputSequence = sequence;
    if (terminal.pendingOutputSize > this.MAX_PENDING_OUTPUT) {
      const marker = '\r\n[Relay: live terminal output truncated]\r\n';
      const joined = terminal.pendingOutput.map((entry) => entry.data).join('');
      const data =
        marker + joined.slice(-(this.MAX_PENDING_OUTPUT - marker.length));
      terminal.pendingOutput = [{ data, sequence }];
      terminal.pendingOutputSize = data.length;
    }
  }

  takePendingOutput(id) {
    const terminal = this.terminals.get(id);
    if (
      !terminal ||
      terminal.awaitingOutputAck ||
      terminal.pendingOutputSize === 0
    )
      return null;
    const batch = {
      data: terminal.pendingOutput.map((entry) => entry.data).join(''),
      sequence: terminal.pendingOutputSequence,
    };
    terminal.pendingOutput = [];
    terminal.pendingOutputSize = 0;
    terminal.awaitingOutputAck = true;
    terminal.inFlightOutputSequence = batch.sequence;
    return batch;
  }

  acknowledgeOutput(id, sequence, ownerWebContentsId) {
    const terminal = this.get(id, ownerWebContentsId);
    if (
      !terminal ||
      !Number.isInteger(sequence) ||
      sequence < terminal.lastAcknowledgedSequence ||
      sequence > terminal.sequence
    )
      return false;
    terminal.lastAcknowledgedSequence = sequence;
    if (
      !terminal.awaitingOutputAck ||
      sequence >= terminal.inFlightOutputSequence
    ) {
      terminal.awaitingOutputAck = false;
      terminal.inFlightOutputSequence = 0;
    }
    terminal.pendingOutput = terminal.pendingOutput.filter(
      (entry) => entry.sequence > sequence,
    );
    terminal.pendingOutputSize = terminal.pendingOutput.reduce(
      (size, entry) => size + entry.data.length,
      0,
    );
    return true;
  }

  setStatus(id, status) {
    const t = this.terminals.get(id);
    if (!t) return null;
    t.status = status;
    t.sequence++;
    t.lastActivityAt = new Date().toISOString();
    return t.sequence;
  }

  setHidden(id, hidden, ownerWebContentsId) {
    const t = this.get(id, ownerWebContentsId);
    if (!t) return null;
    t.hidden = hidden;
    t.sequence++;
    t.lastActivityAt = new Date().toISOString();
    return t.sequence;
  }

  finalize(id, code, signal, error) {
    const t = this.terminals.get(id);
    if (!t || t.finalized) return false;
    t.finalized = true;

    if (t.status === 'stopping') {
      t.status = 'cancelled';
    } else if (error) {
      t.status = 'failed';
    } else if (signal || (code !== 0 && code !== null)) {
      t.status = code === null && signal ? 'cancelled' : 'failed';
    } else {
      t.status = 'completed';
    }

    t.exitCode = code;
    t.signal = signal;
    t.error = error;
    t.lastActivityAt = new Date().toISOString();
    t.child = null;
    t.sequence++;
    return true;
  }

  remove(id, ownerWebContentsId) {
    const t = this.get(id, ownerWebContentsId);
    if (
      t &&
      (t.status === 'completed' ||
        t.status === 'failed' ||
        t.status === 'cancelled' ||
        t.status === 'orphaned')
    ) {
      this.terminals.delete(id);
      return true;
    }
    return false;
  }

  inventory(ownerWebContentsId) {
    return this.getAllForOwner(ownerWebContentsId).map((t) => ({
      id: t.id,
      provider: t.provider,
      workspaceId: t.workspaceId,
      projectLabel: t.project ? t.project.split('/').pop() : 'Unknown',
      branchLabel: t.branchLabel,
      status: t.status,
      hidden: t.hidden,
      createdAt: t.createdAt,
      lastActivityAt: t.lastActivityAt,
      exitCode: t.exitCode,
      signal: t.signal,
      error: t.error,
      bridge: t.bridge,
      bridgeError: t.bridgeError,
      buffer: t.buffer,
      sequence: t.sequence,
      outputSequence: t.outputSequence,
      lastAcknowledgedSequence: t.lastAcknowledgedSequence,
    }));
  }
}
