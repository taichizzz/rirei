import { z } from 'zod';

export const LATEST_THREADS_SCHEMA = 1;
export const THREADS_THREAD_LIMIT = 100;
export const THREADS_MESSAGE_LIMIT = 1000;
export const THREADS_MAX_JOURNAL_BYTES = 5 * 1024 * 1024; // 5 MiB
export const THREADS_MAX_BODY_BYTES = 8 * 1024; // 8 KiB UTF-8
export const THREADS_MAX_CARDS_BYTES = 16 * 1024; // 16 KiB UTF-8
export const THREADS_MAX_PAYLOAD_BYTES = 32 * 1024; // 32 KiB UTF-8

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function hasUnsafeControl(value: string, multiline: boolean): boolean {
  for (const character of value) {
    const code = character.codePointAt(0)!;
    const permittedWhitespace = multiline && (code === 0x09 || code === 0x0a);
    if (
      (code <= 0x1f && !permittedWhitespace) ||
      (code >= 0x7f && code <= 0x9f) ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069)
    ) {
      return true;
    }
  }
  return false;
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function boundedSafeString(
  name: string,
  maxBytes: number,
  options: {
    multiline?: boolean;
    nonblank?: boolean;
    maxCharacters?: number;
  } = {},
) {
  return z
    .string()
    .min(1)
    .refine((value) => !options.nonblank || value.trim().length > 0, {
      message: `${name} must not be blank`,
    })
    .refine((value) => !hasUnpairedSurrogate(value), {
      message: `${name} contains malformed Unicode`,
    })
    .refine((value) => !hasUnsafeControl(value, options.multiline ?? false), {
      message: `${name} contains unsafe control characters`,
    })
    .refine(
      (value) =>
        options.maxCharacters === undefined ||
        value.length <= options.maxCharacters,
      { message: `${name} exceeds ${options.maxCharacters} characters` },
    )
    .refine((value) => utf8Bytes(value) <= maxBytes, {
      message: `${name} exceeds ${maxBytes} UTF-8 bytes`,
    });
}

const identifierSchema = boundedSafeString('Identifier', 512, {
  nonblank: true,
});

export const sessionIdSchema = boundedSafeString('Session ID', 512, {
  nonblank: true,
});

export const messageBodySchema = boundedSafeString(
  'Message body',
  THREADS_MAX_BODY_BYTES,
  { multiline: true, nonblank: true },
);

export const threadActorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('operator') }).strict(),
  z
    .object({
      kind: z.literal('run'),
      runId: boundedSafeString('Run ID', 512, { nonblank: true }),
    })
    .strict(),
]);
export type ThreadActor = z.infer<typeof threadActorSchema>;

export const messageIntentSchema = z.enum(['request', 'inform', 'ack']);
export type MessageIntent = z.infer<typeof messageIntentSchema>;

export const deliveryModeSchema = z.enum(['inbox', 'next_safe_turn', 'wake']);
export type DeliveryMode = z.infer<typeof deliveryModeSchema>;

export const deliveryStateSchema = z.enum([
  'queued',
  'delivered',
  'acknowledged',
  'expired',
]);
export type DeliveryState = z.infer<typeof deliveryStateSchema>;

export const contextCardSchema = z
  .object({
    kind: z.enum(['note', 'checkpoint_summary']),
    sourceId: identifierSchema,
    title: boundedSafeString('Context card title', 800, {
      nonblank: true,
      maxCharacters: 200,
    }),
    text: boundedSafeString('Context card text', THREADS_MAX_CARDS_BYTES, {
      multiline: true,
      nonblank: true,
    }),
    capturedAt: z.string().datetime(),
  })
  .strict();
export type ContextCard = z.infer<typeof contextCardSchema>;

export const contextCardsSchema = z
  .array(contextCardSchema)
  .max(3)
  .superRefine((cards, context) => {
    const bytes = utf8Bytes(JSON.stringify(cards));
    if (bytes > THREADS_MAX_CARDS_BYTES) {
      context.addIssue({
        code: 'custom',
        message: `Combined context cards exceed ${THREADS_MAX_CARDS_BYTES} UTF-8 bytes (actual: ${bytes})`,
      });
    }
  });

export const deliveryClaimSchema = z
  .object({
    id: identifierSchema,
    claimant: identifierSchema,
    claimedAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
  })
  .strict()
  .refine(
    (claim) => Date.parse(claim.expiresAt) > Date.parse(claim.claimedAt),
    {
      message: 'Delivery claim expiration must follow its claim time',
    },
  );
export type DeliveryClaim = z.infer<typeof deliveryClaimSchema>;

const deliverySchema = z
  .object({
    state: deliveryStateSchema,
    attemptCount: z.number().int().nonnegative().max(16),
    lastAttemptAt: z.string().datetime().optional(),
    deliveredAt: z.string().datetime().optional(),
    readAt: z.string().datetime().optional(),
    acknowledgedAt: z.string().datetime().optional(),
    expiredAt: z.string().datetime().optional(),
    expirationReason: z
      .enum(['recipient_ended', 'task_closed', 'ttl'])
      .optional(),
    lastErrorCode: z
      .enum(['unsupported', 'provider_unavailable', 'timeout', 'rejected'])
      .optional(),
    claim: deliveryClaimSchema.optional(),
  })
  .strict()
  .superRefine((delivery, context) => {
    if (delivery.state === 'acknowledged' && !delivery.acknowledgedAt) {
      context.addIssue({
        code: 'custom',
        message: 'Acknowledged delivery requires acknowledgedAt',
      });
    }
    if (
      delivery.state === 'expired' &&
      (!delivery.expiredAt || !delivery.expirationReason)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Expired delivery requires expiredAt and expirationReason',
      });
    }
    if (delivery.acknowledgedAt && delivery.expiredAt) {
      context.addIssue({
        code: 'custom',
        message: 'Delivery cannot be both acknowledged and expired',
      });
    }
    if (delivery.acknowledgedAt && delivery.state !== 'acknowledged') {
      context.addIssue({
        code: 'custom',
        message: 'acknowledgedAt is valid only for acknowledged delivery',
      });
    }
    if (
      (delivery.expiredAt || delivery.expirationReason) &&
      delivery.state !== 'expired'
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Expiration metadata is valid only for expired delivery',
      });
    }
  });

const redactionSummarySchema = z
  .object({
    kind: boundedSafeString('Redaction kind', 128, { nonblank: true }),
    count: z.number().int().positive(),
  })
  .strict();

export const relayMessageSchema = z
  .object({
    id: z.string().uuid(),
    sequence: z.number().int().positive(),
    threadId: z.string().uuid(),
    replyToId: z.string().uuid().optional(),
    from: threadActorSchema,
    to: threadActorSchema,
    intent: messageIntentSchema,
    body: messageBodySchema,
    contextCards: contextCardsSchema,
    deliveryMode: deliveryModeSchema,
    createdAt: z.string().datetime(),
    delivery: deliverySchema,
    redactions: z.array(redactionSummarySchema).max(32),
  })
  .strict()
  .superRefine((message, context) => {
    if (actorsEqual(message.from, message.to)) {
      context.addIssue({
        code: 'custom',
        message: 'Message sender and recipient must differ',
      });
    }
    const bytes = utf8Bytes(JSON.stringify(message));
    if (bytes > THREADS_MAX_PAYLOAD_BYTES) {
      context.addIssue({
        code: 'custom',
        message: `Message payload exceeds ${THREADS_MAX_PAYLOAD_BYTES} UTF-8 bytes (actual: ${bytes})`,
      });
    }
  });
export type RelayMessage = z.infer<typeof relayMessageSchema>;

export const threadsOperationRecordSchema = z
  .object({
    actor: boundedSafeString('Operation actor', 512, { nonblank: true }),
    operationId: boundedSafeString('Operation ID', 512, { nonblank: true }),
    payloadHash: z.string().regex(/^[0-9a-f]{64}$/),
    messageId: z.string().uuid(),
    at: z.string().datetime(),
  })
  .strict();
export type ThreadsOperationRecord = z.infer<
  typeof threadsOperationRecordSchema
>;

export const threadsJournalSchema = z
  .object({
    schemaVersion: z.literal(LATEST_THREADS_SCHEMA),
    sessionId: sessionIdSchema,
    revision: z.number().int().nonnegative(),
    nextSequence: z.number().int().positive(),
    recentOperations: z
      .array(threadsOperationRecordSchema)
      .max(THREADS_MESSAGE_LIMIT),
    messages: z.array(relayMessageSchema).max(THREADS_MESSAGE_LIMIT),
  })
  .strict()
  .superRefine((journal, context) => {
    const ids = new Set<string>();
    const sequences = new Set<number>();
    const roots = new Set<string>();
    const messagesById = new Map<string, RelayMessage>();
    let previousSequence = 0;

    for (const [index, message] of journal.messages.entries()) {
      if (ids.has(message.id)) {
        context.addIssue({
          code: 'custom',
          path: ['messages', index, 'id'],
          message: `Duplicate message ID ${message.id}`,
        });
      }
      if (
        sequences.has(message.sequence) ||
        message.sequence <= previousSequence
      ) {
        context.addIssue({
          code: 'custom',
          path: ['messages', index, 'sequence'],
          message: 'Message sequences must be unique and strictly increasing',
        });
      }
      ids.add(message.id);
      sequences.add(message.sequence);
      previousSequence = message.sequence;

      if (!message.replyToId) {
        roots.add(message.threadId);
        if (message.threadId !== message.id) {
          context.addIssue({
            code: 'custom',
            path: ['messages', index, 'threadId'],
            message: 'Root message thread ID must equal its message ID',
          });
        }
      } else {
        const parent = messagesById.get(message.replyToId);
        if (!parent || parent.threadId !== message.threadId) {
          context.addIssue({
            code: 'custom',
            path: ['messages', index, 'replyToId'],
            message: 'Reply parent must precede the reply in the same thread',
          });
        } else {
          const fromParticipates =
            actorsEqual(message.from, parent.from) ||
            actorsEqual(message.from, parent.to);
          const toParticipates =
            actorsEqual(message.to, parent.from) ||
            actorsEqual(message.to, parent.to);
          if (!fromParticipates || !toParticipates) {
            context.addIssue({
              code: 'custom',
              path: ['messages', index],
              message: 'Reply actors must remain within the parent thread',
            });
          }
          if (
            message.intent === 'ack' &&
            !actorsEqual(message.from, parent.to)
          ) {
            context.addIssue({
              code: 'custom',
              path: ['messages', index, 'intent'],
              message:
                'Only the parent recipient may send an acknowledgement reply',
            });
          }
          if (
            message.intent === 'ack' &&
            parent.delivery.state !== 'acknowledged'
          ) {
            context.addIssue({
              code: 'custom',
              path: ['messages', index, 'intent'],
              message: 'Acknowledgement reply requires an acknowledged parent',
            });
          }
        }
      }
      messagesById.set(message.id, message);
    }

    if (roots.size > THREADS_THREAD_LIMIT) {
      context.addIssue({
        code: 'custom',
        path: ['messages'],
        message: `Journal exceeds the ${THREADS_THREAD_LIMIT} thread limit`,
      });
    }
    if (journal.nextSequence <= previousSequence) {
      context.addIssue({
        code: 'custom',
        path: ['nextSequence'],
        message: 'nextSequence must exceed every persisted message sequence',
      });
    }

    for (const [index, operation] of journal.recentOperations.entries()) {
      if (!ids.has(operation.messageId)) {
        context.addIssue({
          code: 'custom',
          path: ['recentOperations', index, 'messageId'],
          message: 'Operation record must refer to a persisted message',
        });
      }
    }
  });
export type ThreadsJournal = z.infer<typeof threadsJournalSchema>;

export function actorKey(actor: ThreadActor): string {
  return actor.kind === 'operator' ? 'operator' : `run:${actor.runId}`;
}

export function actorsEqual(a: ThreadActor, b: ThreadActor): boolean {
  if (a.kind === 'operator' && b.kind === 'operator') return true;
  if (a.kind === 'run' && b.kind === 'run') return a.runId === b.runId;
  return false;
}
