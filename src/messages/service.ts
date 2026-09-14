import { createHash, randomUUID } from 'node:crypto';
import { registeredAgents } from '../agents/registry.js';
import { assertNoSecrets, type RedactionSummary } from '../safety/redaction.js';
import { withRepositoryLock } from '../state/lock.js';
import type { RelayState } from '../state/schema.js';
import { readState } from '../state/store.js';
import {
  actorKey,
  actorsEqual,
  contextCardsSchema,
  deliveryModeSchema,
  messageBodySchema,
  messageIntentSchema,
  THREADS_MESSAGE_LIMIT,
  THREADS_THREAD_LIMIT,
  threadActorSchema,
  type ContextCard,
  type DeliveryMode,
  type MessageIntent,
  type RelayMessage,
  type ThreadActor,
  type ThreadsJournal,
} from './schema.js';
import { readThreadsJournal, updateThreadsJournal } from './store.js';
import { validateContextCards } from './context-cards.js';
import { renderMessageEnvelope } from './render.js';

export interface SendMessageRequest {
  sessionId: string;
  from: ThreadActor;
  to: ThreadActor;
  intent: MessageIntent;
  body: string;
  contextCards?: ContextCard[];
  deliveryMode?: DeliveryMode;
  operationId?: string;
  redact?: boolean;
}

export interface ReplyMessageRequest {
  sessionId: string;
  parentMessageId: string;
  from: ThreadActor;
  intent: MessageIntent;
  body: string;
  contextCards?: ContextCard[];
  deliveryMode?: DeliveryMode;
  operationId?: string;
  redact?: boolean;
}

function validateActorPair(from: ThreadActor, to: ThreadActor): void {
  if (actorsEqual(from, to)) {
    throw new Error(
      `Invalid recipient: cannot send message to self (${actorKey(from)} -> ${actorKey(to)}).`,
    );
  }
  if (from.kind === 'operator' && to.kind === 'operator') {
    throw new Error(
      'Invalid message: operator cannot send a message to operator.',
    );
  }
}

function resolveReplyRoute(
  messages: readonly RelayMessage[],
  parentId: string,
  from: ThreadActor,
): { parent: RelayMessage; to: ThreadActor; isFromRecipient: boolean } {
  const parent = messages.find((message) => message.id === parentId);
  if (!parent) {
    throw new Error(`Parent message msg:${parentId} was not found.`);
  }

  const isFromSender = actorsEqual(from, parent.from);
  const isFromRecipient = actorsEqual(from, parent.to);
  if (!isFromSender && !isFromRecipient) {
    throw new Error(
      `Actor ${actorKey(from)} is not a participant in thread thread:${parent.threadId}.`,
    );
  }

  const to: ThreadActor = isFromSender ? parent.to : parent.from;
  validateActorPair(from, to);
  return { parent, to, isFromRecipient };
}

function hashPayload(payload: unknown): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function stableContextCards(
  cards: ContextCard[],
): Array<Omit<ContextCard, 'capturedAt'>> {
  return cards.map((card) => ({
    kind: card.kind,
    sourceId: card.sourceId,
    title: card.title,
    text: card.text,
  }));
}

function validateCurrentTask(state: RelayState, sessionId: string): void {
  if (state.sessionId !== sessionId) {
    throw new Error(
      `Message session mismatch: current task is ${state.sessionId}, requested ${sessionId}.`,
    );
  }
  if (state.task.status !== 'active' && state.task.status !== 'blocked') {
    throw new Error(
      `Messages can only be sent while the current task is active or blocked (current: ${state.task.status}).`,
    );
  }
}

function requireCurrentRunLease(
  state: RelayState,
  actor: ThreadActor,
  role: 'sender' | 'recipient',
): void {
  if (actor.kind === 'operator') return;
  const lease = state.runs.find((run) => run.runId === actor.runId);
  if (!lease || lease.status === 'orphaned') {
    if (role === 'recipient') {
      throw new Error(
        `Active recipient run:${actor.runId} was not found or is orphaned.`,
      );
    }
    throw new Error(
      `Run sender run:${actor.runId} does not have a current non-orphaned lease.`,
    );
  }
}

function requireSupportedDelivery(
  state: RelayState,
  recipient: ThreadActor,
  mode: DeliveryMode,
): void {
  if (mode === 'inbox') return;
  if (recipient.kind !== 'run')
    throw new Error(`${mode} delivery is not supported for the operator.`);
  const lease = state.runs.find((run) => run.runId === recipient.runId);
  const adapter = registeredAgents().find((agent) => agent.id === lease?.agent);
  const capabilities = adapter?.capabilities.messageDelivery;
  const supported =
    mode === 'wake' ? capabilities?.wake : capabilities?.nextSafeTurn;
  if (!supported)
    throw new Error(
      `${mode} delivery is not supported by ${lease?.agent ?? 'this recipient'}.`,
    );
}

async function withMessageLifecycleGuard<T>(
  projectRoot: string,
  sessionId: string,
  actors: { from: ThreadActor; to?: ThreadActor },
  operation: (state: RelayState) => Promise<T>,
): Promise<T> {
  return withRepositoryLock(projectRoot, async () => {
    const state = await readState(projectRoot);
    validateCurrentTask(state, sessionId);
    requireCurrentRunLease(state, actors.from, 'sender');
    if (actors.to) requireCurrentRunLease(state, actors.to, 'recipient');
    return operation(state);
  });
}

function mergeRedactions(redactions: RedactionSummary[]): RedactionSummary[] {
  const counts = new Map<string, number>();
  for (const redaction of redactions) {
    counts.set(
      redaction.kind,
      (counts.get(redaction.kind) ?? 0) + redaction.count,
    );
  }
  return [...counts].map(([kind, count]) => ({ kind, count }));
}

function prepareContextCards(
  input: ContextCard[] | undefined,
  allowRedact: boolean,
): { cards: ContextCard[]; redactions: RedactionSummary[] } {
  const cards = contextCardsSchema.parse(input ?? []);
  const redactions: RedactionSummary[] = [];
  const cleanCards = cards.map((card) => {
    const source = assertNoSecrets(card.sourceId, allowRedact);
    const title = assertNoSecrets(card.title, allowRedact);
    const text = assertNoSecrets(card.text, allowRedact);
    redactions.push(
      ...source.redactions,
      ...title.redactions,
      ...text.redactions,
    );
    return {
      ...card,
      sourceId: source.cleanText,
      title: title.cleanText,
      text: text.cleanText,
    };
  });
  validateContextCards(cleanCards);
  return { cards: cleanCards, redactions: mergeRedactions(redactions) };
}

export async function sendMessage(
  projectRoot: string,
  request: SendMessageRequest,
): Promise<{ message: RelayMessage; journal: ThreadsJournal }> {
  const from = threadActorSchema.parse(request.from);
  const to = threadActorSchema.parse(request.to);
  const intent = messageIntentSchema.parse(request.intent);
  const deliveryMode = deliveryModeSchema.parse(
    request.deliveryMode ?? 'inbox',
  );
  const body = messageBodySchema.parse(request.body);
  validateActorPair(from, to);
  if (intent === 'ack') {
    throw new Error(
      'The ack intent is valid only when replying to an existing message.',
    );
  }

  const { cleanText, redactions } = assertNoSecrets(
    body,
    request.redact ?? false,
  );
  messageBodySchema.parse(cleanText);

  const preparedCards = prepareContextCards(
    request.contextCards,
    request.redact ?? false,
  );
  const contextCards = preparedCards.cards;
  const allRedactions = mergeRedactions([
    ...redactions,
    ...preparedCards.redactions,
  ]);

  const messageId = randomUUID();
  const threadId = messageId; // Root message starts thread
  const now = new Date().toISOString();

  const payloadHash = hashPayload({
    from,
    to,
    intent,
    body: cleanText,
    contextCards: stableContextCards(contextCards),
    deliveryMode,
  });

  const actorStr = actorKey(from);
  let createdMessage: RelayMessage | undefined;

  const result = await withMessageLifecycleGuard(
    projectRoot,
    request.sessionId,
    { from, to },
    (state) => {
      requireSupportedDelivery(state, to, deliveryMode);
      return updateThreadsJournal(
        projectRoot,
        request.sessionId,
        (current) => {
          if (current.messages.length >= THREADS_MESSAGE_LIMIT) {
            throw new Error(
              `Task reached maximum limit of ${THREADS_MESSAGE_LIMIT} messages. Cannot send new message.`,
            );
          }
          if (
            new Set(current.messages.map((message) => message.threadId)).size >=
            THREADS_THREAD_LIMIT
          ) {
            throw new Error(
              `Task reached maximum limit of ${THREADS_THREAD_LIMIT} threads. Cannot start a new thread.`,
            );
          }

          const sequence = current.nextSequence;
          const message: RelayMessage = {
            id: messageId,
            sequence,
            threadId,
            from,
            to,
            intent,
            body: cleanText,
            contextCards,
            deliveryMode,
            createdAt: now,
            delivery: {
              state: 'queued',
              attemptCount: 0,
            },
            redactions: allRedactions,
          };
          renderMessageEnvelope(message);

          createdMessage = message;

          return {
            ...current,
            nextSequence: sequence + 1,
            messages: [...current.messages, message],
          };
        },
        {
          opId: request.operationId,
          actor: actorStr,
          payloadHash,
          messageId,
        },
      );
    },
  );

  return {
    message: result.existingMessage || createdMessage!,
    journal: result.journal,
  };
}

export async function replyMessage(
  projectRoot: string,
  request: ReplyMessageRequest,
): Promise<{ message: RelayMessage; journal: ThreadsJournal }> {
  const from = threadActorSchema.parse(request.from);
  const intent = messageIntentSchema.parse(request.intent);
  const deliveryMode = deliveryModeSchema.parse(
    request.deliveryMode ?? 'inbox',
  );
  const body = messageBodySchema.parse(request.body);
  const { cleanText, redactions } = assertNoSecrets(
    body,
    request.redact ?? false,
  );
  messageBodySchema.parse(cleanText);

  const preparedCards = prepareContextCards(
    request.contextCards,
    request.redact ?? false,
  );
  const contextCards = preparedCards.cards;
  const allRedactions = mergeRedactions([
    ...redactions,
    ...preparedCards.redactions,
  ]);

  const messageId = randomUUID();
  const now = new Date().toISOString();
  const parentId = request.parentMessageId.startsWith('msg:')
    ? request.parentMessageId.slice(4)
    : request.parentMessageId;

  const payloadHash = hashPayload({
    parentMessageId: parentId,
    from,
    intent,
    body: cleanText,
    contextCards: stableContextCards(contextCards),
    deliveryMode,
  });

  const actorStr = actorKey(from);
  let createdMessage: RelayMessage | undefined;

  const result = await withMessageLifecycleGuard(
    projectRoot,
    request.sessionId,
    { from },
    async (state) => {
      // Preflight the immutable route so idempotent retries still validate the
      // inferred recipient against the current lease set.
      const snapshot = await readThreadsJournal(projectRoot, request.sessionId);
      const route = resolveReplyRoute(snapshot.messages, parentId, from);
      requireCurrentRunLease(state, route.to, 'recipient');
      requireSupportedDelivery(state, route.to, deliveryMode);

      return updateThreadsJournal(
        projectRoot,
        request.sessionId,
        (current) => {
          const { parent, to, isFromRecipient } = resolveReplyRoute(
            current.messages,
            parentId,
            from,
          );

          if (intent === 'ack') {
            if (!isFromRecipient) {
              throw new Error(
                'Only the parent recipient may acknowledge a message.',
              );
            }
            if (parent.delivery.state === 'expired') {
              throw new Error('Expired messages cannot be acknowledged.');
            }
          }

          requireCurrentRunLease(state, to, 'recipient');

          if (current.messages.length >= THREADS_MESSAGE_LIMIT) {
            throw new Error(
              `Task reached maximum limit of ${THREADS_MESSAGE_LIMIT} messages. Cannot send reply.`,
            );
          }

          const sequence = current.nextSequence;
          const message: RelayMessage = {
            id: messageId,
            sequence,
            threadId: parent.threadId,
            replyToId: parent.id,
            from,
            to,
            intent,
            body: cleanText,
            contextCards,
            deliveryMode,
            createdAt: now,
            delivery: {
              state: 'queued',
              attemptCount: 0,
            },
            redactions: allRedactions,
          };
          renderMessageEnvelope(message);

          createdMessage = message;

          // If reply intent is ack, acknowledge parent message atomically
          let nextMessages = current.messages;
          if (intent === 'ack') {
            nextMessages = current.messages.map((m) => {
              if (m.id === parent.id) {
                if (m.delivery.state === 'acknowledged') return m;
                return {
                  ...m,
                  delivery: {
                    ...m.delivery,
                    state: 'acknowledged',
                    acknowledgedAt: now,
                    readAt: m.delivery.readAt ?? now,
                  },
                };
              }
              return m;
            });
          }

          return {
            ...current,
            nextSequence: sequence + 1,
            messages: [...nextMessages, message],
          };
        },
        {
          opId: request.operationId,
          actor: actorStr,
          payloadHash,
          messageId,
        },
      );
    },
  );

  return {
    message: result.existingMessage || createdMessage!,
    journal: result.journal,
  };
}

export async function markMessageRead(
  projectRoot: string,
  sessionId: string,
  messageId: string,
  actor: ThreadActor,
): Promise<RelayMessage> {
  const parsedActor = threadActorSchema.parse(actor);
  const canonicalId = messageId.startsWith('msg:')
    ? messageId.slice(4)
    : messageId;
  const now = new Date().toISOString();
  let updatedMsg: RelayMessage | undefined;

  await updateThreadsJournal(projectRoot, sessionId, (current) => {
    const target = current.messages.find((m) => m.id === canonicalId);
    if (!target) {
      throw new Error(`Message msg:${canonicalId} was not found.`);
    }

    if (!actorsEqual(target.to, parsedActor)) {
      throw new Error(
        `Only the recipient (${actorKey(target.to)}) can mark this message read (caller: ${actorKey(parsedActor)}).`,
      );
    }

    if (target.delivery.readAt) {
      updatedMsg = target;
      return current;
    }

    const nextTarget: RelayMessage = {
      ...target,
      delivery: {
        ...target.delivery,
        readAt: now,
      },
    };
    updatedMsg = nextTarget;

    return {
      ...current,
      messages: current.messages.map((m) =>
        m.id === canonicalId ? nextTarget : m,
      ),
    };
  });

  return updatedMsg!;
}

export async function acknowledgeMessage(
  projectRoot: string,
  sessionId: string,
  messageId: string,
  actor: ThreadActor,
): Promise<RelayMessage> {
  const parsedActor = threadActorSchema.parse(actor);
  const canonicalId = messageId.startsWith('msg:')
    ? messageId.slice(4)
    : messageId;
  const now = new Date().toISOString();
  let updatedMsg: RelayMessage | undefined;

  await updateThreadsJournal(projectRoot, sessionId, (current) => {
    const target = current.messages.find((m) => m.id === canonicalId);
    if (!target) {
      throw new Error(`Message msg:${canonicalId} was not found.`);
    }

    if (!actorsEqual(target.to, parsedActor)) {
      throw new Error(
        `Only the recipient (${actorKey(target.to)}) can acknowledge this message (caller: ${actorKey(parsedActor)}).`,
      );
    }

    if (target.delivery.state === 'expired') {
      throw new Error('Expired messages cannot be acknowledged.');
    }

    if (target.delivery.state === 'acknowledged') {
      updatedMsg = target;
      return current;
    }

    const nextTarget: RelayMessage = {
      ...target,
      delivery: {
        ...target.delivery,
        state: 'acknowledged',
        acknowledgedAt: now,
        readAt: target.delivery.readAt ?? now,
      },
    };
    updatedMsg = nextTarget;

    return {
      ...current,
      messages: current.messages.map((m) =>
        m.id === canonicalId ? nextTarget : m,
      ),
    };
  });

  return updatedMsg!;
}

export async function expireQueuedMessages(
  projectRoot: string,
  sessionId: string,
  reason: 'recipient_ended' | 'task_closed' | 'ttl',
  targetRunId?: string,
): Promise<number> {
  const now = new Date().toISOString();
  let expiredCount = 0;

  await updateThreadsJournal(projectRoot, sessionId, (current) => {
    let changed = false;
    const nextMessages = current.messages.map((m) => {
      if (m.delivery.state !== 'queued') return m;

      let shouldExpire = false;
      if (reason === 'task_closed' || reason === 'ttl') {
        shouldExpire = true;
      } else if (reason === 'recipient_ended' && targetRunId) {
        shouldExpire = m.to.kind === 'run' && m.to.runId === targetRunId;
      }

      if (shouldExpire) {
        changed = true;
        expiredCount += 1;
        return {
          ...m,
          delivery: {
            ...m.delivery,
            state: 'expired' as const,
            expiredAt: now,
            expirationReason: reason,
          },
        };
      }
      return m;
    });

    if (!changed) return current;
    return {
      ...current,
      messages: nextMessages,
    };
  });

  return expiredCount;
}

export async function getInbox(
  projectRoot: string,
  sessionId: string,
  actor: ThreadActor,
  options: { unreadOnly?: boolean; peek?: boolean } = {},
): Promise<RelayMessage[]> {
  const parsedActor = threadActorSchema.parse(actor);
  if (options.peek) {
    const journal = await readThreadsJournal(projectRoot, sessionId);
    return journal.messages.filter(
      (message) =>
        actorsEqual(message.to, parsedActor) &&
        (!options.unreadOnly || !message.delivery.readAt),
    );
  }

  const now = new Date().toISOString();
  let persistedMessages: RelayMessage[] = [];
  await updateThreadsJournal(projectRoot, sessionId, (current) => {
    const matchingIds = new Set(
      current.messages
        .filter(
          (message) =>
            actorsEqual(message.to, parsedActor) &&
            (!options.unreadOnly || !message.delivery.readAt),
        )
        .map((message) => message.id),
    );
    let changed = false;
    const messages = current.messages.map((message) => {
      if (!matchingIds.has(message.id) || message.delivery.readAt)
        return message;
      changed = true;
      return {
        ...message,
        delivery: { ...message.delivery, readAt: now },
      };
    });
    persistedMessages = messages.filter((message) =>
      matchingIds.has(message.id),
    );
    return changed ? { ...current, messages } : current;
  });
  return persistedMessages;
}

export async function getThread(
  projectRoot: string,
  sessionId: string,
  threadId: string,
  caller: ThreadActor,
): Promise<RelayMessage[]> {
  const parsedCaller = threadActorSchema.parse(caller);
  const canonicalId = threadId.startsWith('thread:')
    ? threadId.slice(7)
    : threadId;
  const journal = await readThreadsJournal(projectRoot, sessionId);
  const threadMessages = journal.messages.filter(
    (m) => m.threadId === canonicalId,
  );

  if (threadMessages.length === 0) {
    throw new Error(`Thread thread:${canonicalId} was not found.`);
  }

  // Operator can read any thread; a run can read threads where it is a participant
  if (parsedCaller.kind !== 'operator') {
    const isParticipant = threadMessages.some(
      (m) =>
        actorsEqual(m.from, parsedCaller) || actorsEqual(m.to, parsedCaller),
    );
    if (!isParticipant) {
      throw new Error(
        `Access denied: caller is not a participant in thread:${canonicalId}.`,
      );
    }
  }

  return threadMessages.sort((a, b) => a.sequence - b.sequence);
}
