import { Command } from 'commander';
import { lstat, readFile } from 'node:fs/promises';
import { TerminalDaemonClient } from '../../desktop/terminal-daemon-client.mjs';
import { registeredAgents } from '../agents/registry.js';
import { taskContext } from '../lifecycle.js';
import { resolveCurrentActor } from '../messages/capability.js';
import {
  resolveCheckpointContextCard,
  resolveNoteContextCard,
} from '../messages/context-cards.js';
import {
  approximateTokenEstimate,
  formatActorLabel,
  renderMessageEnvelope,
} from '../messages/render.js';
import {
  deliveryModeSchema,
  messageIntentSchema,
  THREADS_MAX_BODY_BYTES,
  type ContextCard,
  type DeliveryMode,
  type MessageIntent,
  type ThreadActor,
} from '../messages/schema.js';
import { assertNoSecrets } from '../safety/redaction.js';
import {
  daemonDescriptorPath,
  rireiDataHome,
} from '../platform/runtime-paths.js';
import {
  acknowledgeMessage,
  getInbox,
  getThread,
  markMessageRead,
  replyMessage,
  sendMessage,
} from '../messages/service.js';
import { summarizeThreads } from '../messages/projection.js';
import type { RelayState } from '../state/schema.js';

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += bytes.length;
    if (totalBytes > THREADS_MAX_BODY_BYTES)
      throw new Error(
        `Message body exceeds ${THREADS_MAX_BODY_BYTES} UTF-8 bytes.`,
      );
    chunks.push(bytes);
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(
    Buffer.concat(chunks),
  );
}

function resolveActor(target: string, state: RelayState): ThreadActor {
  const trimmed = target.trim();
  if (trimmed === 'operator') {
    return { kind: 'operator' };
  }
  if (!trimmed.startsWith('run:') || trimmed.length === 4)
    throw new Error(
      'Recipients must use the canonical "operator" or "run:<id>" reference. Display labels are not routing keys.',
    );
  const runId = trimmed.slice(4);
  const lease = state.runs.find(
    (run) => run.runId === runId && run.status !== 'orphaned',
  );
  if (!lease) throw new Error(`Active recipient ${trimmed} was not found.`);
  return { kind: 'run', runId };
}

function parseIntent(
  value: string | undefined,
  allowAck: boolean,
): MessageIntent {
  const intent = messageIntentSchema.parse(
    value ?? (allowAck ? 'inform' : 'request'),
  );
  if (!allowAck && intent === 'ack')
    throw new Error('The ack intent is valid only for replies.');
  return intent;
}

function parseDeliveryMode(
  value: string | undefined,
  recipient: ThreadActor,
  state: RelayState,
): DeliveryMode {
  const mode = deliveryModeSchema.parse(value ?? 'inbox');
  if (mode === 'inbox') return mode;
  if (recipient.kind !== 'run')
    throw new Error(`${mode} delivery is not supported for the operator.`);
  const lease = state.runs.find((run) => run.runId === recipient.runId);
  if (!lease)
    throw new Error(`Active recipient run:${recipient.runId} was not found.`);
  const adapter = registeredAgents().find((agent) => agent.id === lease.agent);
  if (!adapter) throw new Error(`Unknown provider adapter: ${lease.agent}.`);
  const capabilities = adapter.capabilities.messageDelivery;
  const supported =
    mode === 'wake' ? capabilities.wake : capabilities.nextSafeTurn;
  if (!supported)
    throw new Error(`${mode} delivery is not supported by ${lease.agent}.`);
  return mode;
}

async function messageBody(options: {
  text?: string;
  stdin?: boolean;
}): Promise<string> {
  const hasText = options.text !== undefined;
  const hasStdin = options.stdin === true;
  if (hasText === hasStdin)
    throw new Error(
      'Provide exactly one message body source: --text or --stdin.',
    );
  const body = hasStdin ? await readStdin() : options.text!;
  if (!body.trim()) throw new Error('Message body must not be blank.');
  if (Buffer.byteLength(body, 'utf8') > THREADS_MAX_BODY_BYTES)
    throw new Error(
      `Message body exceeds ${THREADS_MAX_BODY_BYTES} UTF-8 bytes.`,
    );
  return body;
}

async function notifyThreadsChanged(
  projectRoot: string,
  sessionId: string,
  details: { threadId?: string; messageId?: string; revision?: number },
): Promise<void> {
  let client: TerminalDaemonClient | undefined;
  try {
    const descriptorPath = daemonDescriptorPath(rireiDataHome());
    const stats = await lstat(descriptorPath);
    if (
      !stats.isFile() ||
      stats.isSymbolicLink() ||
      stats.size > 8192 ||
      (process.platform !== 'win32' && (stats.mode & 0o077) !== 0)
    )
      return;
    const descriptor = JSON.parse(await readFile(descriptorPath, 'utf8')) as {
      socketPath?: unknown;
    };
    if (typeof descriptor.socketPath !== 'string') return;
    client = new TerminalDaemonClient({
      descriptorPath,
      socketPath: descriptor.socketPath,
      requestTimeoutMs: 1000,
    });
    const notifier = client as unknown as {
      notifyThreads(value: Record<string, unknown>): Promise<unknown>;
    };
    await client.connect();
    await notifier.notifyThreads({ projectRoot, sessionId, ...details });
  } catch {
    // Desktop/TUI refresh is opportunistic; the durable journal is authoritative.
  } finally {
    client?.disconnect();
  }
}

function collect(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}

export function messageCommand(): Command {
  const command = new Command('message').description(
    'Local, task-scoped multi-agent coordination threads',
  );

  command
    .command('peers')
    .description('List available coordination peers for the current task')
    .option('--json', 'print machine-readable JSON')
    .action(async (options: { json?: boolean }) => {
      const context = await taskContext({ ensureExclusion: false });
      const currentActor = await resolveCurrentActor(
        context.root,
        context.state,
      );

      const peers: Array<{
        actor: ThreadActor;
        ref: string;
        displayLabel?: string;
        agent?: string;
        role?: string;
        branch?: string;
        delivery?: { inbox: true; nextSafeTurn: boolean; wake: boolean };
        isSelf: boolean;
      }> = [];

      // If caller is a run, include operator as a peer
      if (currentActor.kind === 'run') {
        peers.push({
          actor: { kind: 'operator' },
          ref: 'operator',
          displayLabel: 'Operator',
          isSelf: false,
        });
      }

      for (const lease of context.state.runs) {
        const isSelf =
          currentActor.kind === 'run' && currentActor.runId === lease.runId;
        const adapter = registeredAgents().find(
          (candidate) => candidate.id === lease.agent,
        );
        peers.push({
          actor: { kind: 'run', runId: lease.runId },
          ref: `run:${lease.runId}`,
          displayLabel: lease.displayLabel,
          agent: lease.agent,
          role: lease.role,
          branch: lease.branchLabel,
          delivery: adapter?.capabilities.messageDelivery,
          isSelf,
        });
      }

      if (options.json) {
        process.stdout.write(
          `${JSON.stringify({ schemaVersion: 1, currentActor, peers }, null, 2)}\n`,
        );
        return;
      }

      process.stdout.write(
        `Current actor: ${formatActorLabel(currentActor)}\n\n`,
      );
      if (peers.length === 0) {
        process.stdout.write('No active peers found.\n');
        return;
      }
      for (const peer of peers) {
        const selfTag = peer.isSelf ? ' (self)' : '';
        const label = peer.displayLabel
          ? `${peer.displayLabel} [${peer.ref}]`
          : peer.ref;
        const details = [
          peer.agent ? `agent=${peer.agent}` : null,
          peer.role ? `role=${peer.role}` : null,
          peer.branch ? `branch=${peer.branch}` : null,
          peer.delivery
            ? `delivery=${[
                'inbox',
                peer.delivery.nextSafeTurn ? 'next_safe_turn' : null,
                peer.delivery.wake ? 'wake' : null,
              ]
                .filter(Boolean)
                .join('|')}`
            : null,
        ]
          .filter(Boolean)
          .join(', ');
        process.stdout.write(
          `• ${label}${selfTag}${details ? ` (${details})` : ''}\n`,
        );
      }
    });

  command
    .command('inbox')
    .description('Show inbox messages addressed to the current session')
    .option('--unread', 'show only unread messages')
    .option('--peek', 'do not mark unread messages as read')
    .option('--json', 'print machine-readable JSON')
    .action(
      async (options: { unread?: boolean; peek?: boolean; json?: boolean }) => {
        const context = await taskContext({ ensureExclusion: false });
        const currentActor = await resolveCurrentActor(
          context.root,
          context.state,
        );
        const messages = await getInbox(
          context.root,
          context.state.sessionId,
          currentActor,
          { unreadOnly: options.unread, peek: options.peek },
        );
        if (!options.peek && messages.length > 0)
          await notifyThreadsChanged(context.root, context.state.sessionId, {});

        if (options.json) {
          process.stdout.write(
            `${JSON.stringify({ schemaVersion: 1, actor: currentActor, messages }, null, 2)}\n`,
          );
          return;
        }

        if (messages.length === 0) {
          process.stdout.write('Inbox is empty.\n');
          return;
        }

        for (const msg of messages) {
          const envelope = renderMessageEnvelope(msg);
          process.stdout.write(`${envelope}\n\n====================\n\n`);
        }
      },
    );

  command
    .command('threads')
    .description('List coordination threads for the current task')
    .option('--filter <text>', 'filter by keyword or participant')
    .option('--json', 'print machine-readable JSON')
    .action(async (options: { filter?: string; json?: boolean }) => {
      const context = await taskContext({
        ensureExclusion: false,
        allowClosed: true,
      });
      const currentActor = await resolveCurrentActor(
        context.root,
        context.state,
      );
      const journal = await (
        await import('../messages/store.js')
      ).readThreadsJournal(context.root, context.state.sessionId);
      const summaries = summarizeThreads(journal, currentActor, {
        filter: options.filter,
      });

      if (options.json) {
        process.stdout.write(
          `${JSON.stringify({ schemaVersion: 1, summaries }, null, 2)}\n`,
        );
        return;
      }

      if (summaries.length === 0) {
        process.stdout.write('No threads found.\n');
        return;
      }

      for (const s of summaries) {
        const parts = s.participants
          .map((p) => formatActorLabel(p))
          .join(' <-> ');
        const unreadTag = s.unreadCount > 0 ? ` [${s.unreadCount} unread]` : '';
        process.stdout.write(
          `• thread:${s.threadId}${unreadTag} (${parts}) - ${s.messageCount} msg(s) [${s.deliveryState}]\n` +
            `  "${s.latestExcerpt}"\n`,
        );
      }
    });

  command
    .command('thread <threadId>')
    .description('View all messages in a specific thread')
    .option('--json', 'print machine-readable JSON')
    .action(async (threadId: string, options: { json?: boolean }) => {
      const context = await taskContext({
        ensureExclusion: false,
        allowClosed: true,
      });
      const currentActor = await resolveCurrentActor(
        context.root,
        context.state,
      );
      const messages = await getThread(
        context.root,
        context.state.sessionId,
        threadId,
        currentActor,
      );

      if (options.json) {
        process.stdout.write(
          `${JSON.stringify({ schemaVersion: 1, threadId, messages }, null, 2)}\n`,
        );
        return;
      }

      for (const msg of messages) {
        const envelope = renderMessageEnvelope(msg);
        process.stdout.write(`${envelope}\n\n--------------------\n\n`);
      }
    });

  command
    .command('preview')
    .description(
      'Preview rendered message envelope and approximate token estimate',
    )
    .option('--to <actor>', 'target recipient (operator or run:<id>)')
    .option(
      '--intent <intent>',
      'message intent (request, inform, ack)',
      'request',
    )
    .option(
      '--delivery <delivery>',
      'delivery mode (inbox, next_safe_turn, wake)',
      'inbox',
    )
    .option('--text <text>', 'message body text')
    .option('--stdin', 'read message body text from stdin')
    .option(
      '-n, --context-note <noteId>',
      'attach handoff note context',
      collect,
      [],
    )
    .option(
      '-c, --context-checkpoint <checkpointId>',
      'attach checkpoint context',
      collect,
      [],
    )
    .option('--redact', 'automatically redact detected sensitive secrets')
    .option('--json', 'print machine-readable JSON')
    .action(
      async (options: {
        to?: string;
        intent?: string;
        delivery?: string;
        text?: string;
        stdin?: boolean;
        contextNote: string[];
        contextCheckpoint: string[];
        redact?: boolean;
        json?: boolean;
      }) => {
        const context = await taskContext({ ensureExclusion: false });
        const currentActor = await resolveCurrentActor(
          context.root,
          context.state,
        );
        const to = options.to
          ? resolveActor(options.to, context.state)
          : currentActor.kind === 'operator'
            ? { kind: 'run' as const, runId: 'example' }
            : { kind: 'operator' as const };

        const body = await messageBody(options);

        const cards: ContextCard[] = [];
        for (const noteId of options.contextNote) {
          cards.push(
            await resolveNoteContextCard(context.state, noteId, options.redact),
          );
        }
        for (const cpId of options.contextCheckpoint) {
          cards.push(
            await resolveCheckpointContextCard(
              context.root,
              context.state,
              cpId,
              options.redact,
            ),
          );
        }

        const { cleanText, redactions } = assertNoSecrets(
          body,
          options.redact ?? false,
        );
        const intent = parseIntent(options.intent, false);
        const deliveryMode = parseDeliveryMode(
          options.delivery,
          to,
          context.state,
        );
        const dummyMsg = {
          id: '00000000-0000-0000-0000-000000000000',
          sequence: 1,
          threadId: '00000000-0000-0000-0000-000000000000',
          from: currentActor,
          to,
          intent,
          body: cleanText,
          contextCards: cards,
          deliveryMode,
          createdAt: new Date().toISOString(),
          delivery: {
            state: 'queued' as const,
            attemptCount: 0,
          },
          redactions,
        };

        const rendered = renderMessageEnvelope(dummyMsg);
        const tokens = approximateTokenEstimate(rendered);

        if (options.json) {
          process.stdout.write(
            `${JSON.stringify({ schemaVersion: 1, rendered, approximateTokens: tokens }, null, 2)}\n`,
          );
          return;
        }

        process.stdout.write(
          `${rendered}\n\n[Approximate token count: ~${tokens} tokens]\n`,
        );
      },
    );

  command
    .command('send')
    .description('Send a new coordination message')
    .requiredOption('--to <actor>', 'target recipient (operator or run:<id>)')
    .option('--intent <intent>', 'message intent (request, inform)', 'request')
    .option(
      '--delivery <delivery>',
      'delivery mode (inbox, next_safe_turn, wake)',
      'inbox',
    )
    .option('--text <text>', 'message body text')
    .option('--stdin', 'read message body text from stdin')
    .option(
      '-n, --context-note <noteId>',
      'attach handoff note context',
      collect,
      [],
    )
    .option(
      '-c, --context-checkpoint <checkpointId>',
      'attach checkpoint context',
      collect,
      [],
    )
    .option('--operation-id <id>', 'idempotency operation ID')
    .option('--redact', 'automatically redact detected sensitive secrets')
    .option('--json', 'print machine-readable JSON')
    .action(
      async (options: {
        to: string;
        intent?: string;
        delivery?: string;
        text?: string;
        stdin?: boolean;
        contextNote: string[];
        contextCheckpoint: string[];
        operationId?: string;
        redact?: boolean;
        json?: boolean;
      }) => {
        const context = await taskContext({ ensureExclusion: false });
        const currentActor = await resolveCurrentActor(
          context.root,
          context.state,
        );
        const to = resolveActor(options.to, context.state);

        const body = await messageBody(options);
        const intent = parseIntent(options.intent, false);
        const deliveryMode = parseDeliveryMode(
          options.delivery,
          to,
          context.state,
        );

        const cards: ContextCard[] = [];
        for (const noteId of options.contextNote) {
          cards.push(
            await resolveNoteContextCard(context.state, noteId, options.redact),
          );
        }
        for (const cpId of options.contextCheckpoint) {
          cards.push(
            await resolveCheckpointContextCard(
              context.root,
              context.state,
              cpId,
              options.redact,
            ),
          );
        }

        const { message, journal } = await sendMessage(context.root, {
          sessionId: context.state.sessionId,
          from: currentActor,
          to,
          intent,
          body,
          contextCards: cards,
          deliveryMode,
          operationId: options.operationId,
          redact: options.redact,
        });
        await notifyThreadsChanged(context.root, context.state.sessionId, {
          threadId: message.threadId,
          messageId: message.id,
          revision: journal.revision,
        });

        if (options.json) {
          process.stdout.write(
            `${JSON.stringify({ schemaVersion: 1, message, revision: journal.revision }, null, 2)}\n`,
          );
          return;
        }

        process.stdout.write(
          `Sent message msg:${message.id} (sequence ${message.sequence}, thread thread:${message.threadId})\n`,
        );
      },
    );

  command
    .command('reply <parentMessageId>')
    .description('Reply to a message in an existing thread')
    .option(
      '--intent <intent>',
      'message intent (request, inform, ack)',
      'inform',
    )
    .option(
      '--delivery <delivery>',
      'delivery mode (inbox, next_safe_turn, wake)',
      'inbox',
    )
    .option('--text <text>', 'message body text')
    .option('--stdin', 'read message body text from stdin')
    .option(
      '-n, --context-note <noteId>',
      'attach handoff note context',
      collect,
      [],
    )
    .option(
      '-c, --context-checkpoint <checkpointId>',
      'attach checkpoint context',
      collect,
      [],
    )
    .option('--operation-id <id>', 'idempotency operation ID')
    .option('--redact', 'automatically redact detected sensitive secrets')
    .option('--json', 'print machine-readable JSON')
    .action(
      async (
        parentMessageId: string,
        options: {
          intent?: string;
          delivery?: string;
          text?: string;
          stdin?: boolean;
          contextNote: string[];
          contextCheckpoint: string[];
          operationId?: string;
          redact?: boolean;
          json?: boolean;
        },
      ) => {
        const context = await taskContext({ ensureExclusion: false });
        const currentActor = await resolveCurrentActor(
          context.root,
          context.state,
        );

        const body = await messageBody(options);
        const intent = parseIntent(options.intent, true);
        const deliveryMode = deliveryModeSchema.parse(
          options.delivery ?? 'inbox',
        );
        if (deliveryMode !== 'inbox')
          throw new Error(
            `${deliveryMode} delivery is not supported by the current provider adapters.`,
          );

        const cards: ContextCard[] = [];
        for (const noteId of options.contextNote) {
          cards.push(
            await resolveNoteContextCard(context.state, noteId, options.redact),
          );
        }
        for (const cpId of options.contextCheckpoint) {
          cards.push(
            await resolveCheckpointContextCard(
              context.root,
              context.state,
              cpId,
              options.redact,
            ),
          );
        }

        const { message, journal } = await replyMessage(context.root, {
          sessionId: context.state.sessionId,
          parentMessageId,
          from: currentActor,
          intent,
          body,
          contextCards: cards,
          deliveryMode,
          operationId: options.operationId,
          redact: options.redact,
        });
        await notifyThreadsChanged(context.root, context.state.sessionId, {
          threadId: message.threadId,
          messageId: message.id,
          revision: journal.revision,
        });

        if (options.json) {
          process.stdout.write(
            `${JSON.stringify({ schemaVersion: 1, message, revision: journal.revision }, null, 2)}\n`,
          );
          return;
        }

        process.stdout.write(
          `Sent reply msg:${message.id} to thread thread:${message.threadId}\n`,
        );
      },
    );

  command
    .command('read <messageId>')
    .description('Mark a message as read')
    .option('--json', 'print machine-readable JSON')
    .action(async (messageId: string, options: { json?: boolean }) => {
      const context = await taskContext({ ensureExclusion: false });
      const currentActor = await resolveCurrentActor(
        context.root,
        context.state,
      );
      const message = await markMessageRead(
        context.root,
        context.state.sessionId,
        messageId,
        currentActor,
      );
      await notifyThreadsChanged(context.root, context.state.sessionId, {
        threadId: message.threadId,
        messageId: message.id,
      });

      if (options.json) {
        process.stdout.write(
          `${JSON.stringify({ schemaVersion: 1, message }, null, 2)}\n`,
        );
        return;
      }

      process.stdout.write(`Marked msg:${message.id} as read.\n`);
    });

  command
    .command('acknowledge <messageId>')
    .description('Acknowledge receipt of a message')
    .option('--json', 'print machine-readable JSON')
    .action(async (messageId: string, options: { json?: boolean }) => {
      const context = await taskContext({ ensureExclusion: false });
      const currentActor = await resolveCurrentActor(
        context.root,
        context.state,
      );
      const message = await acknowledgeMessage(
        context.root,
        context.state.sessionId,
        messageId,
        currentActor,
      );
      await notifyThreadsChanged(context.root, context.state.sessionId, {
        threadId: message.threadId,
        messageId: message.id,
      });

      if (options.json) {
        process.stdout.write(
          `${JSON.stringify({ schemaVersion: 1, message }, null, 2)}\n`,
        );
        return;
      }

      process.stdout.write(`Acknowledged receipt of msg:${message.id}.\n`);
    });

  return command;
}
