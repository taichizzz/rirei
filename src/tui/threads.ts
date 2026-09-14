import {
  actorKey,
  actorsEqual,
  type RelayMessage,
  type ThreadActor,
  type ThreadsJournal,
} from '../messages/schema.js';
import {
  countUnreadMessages,
  summarizeThreads,
  type ThreadSummary,
} from '../messages/projection.js';

export type CanonicalActorRef = 'operator' | `run:${string}`;

export interface ThreadPeer {
  readonly actor: ThreadActor;
  readonly ref: CanonicalActorRef;
  readonly agent?: string;
  readonly deliveryModes: readonly ['inbox'];
}

export interface ThreadsData {
  readonly status: 'ready' | 'unavailable';
  readonly writable: boolean;
  readonly error?: string;
  readonly projectRoot?: string;
  readonly sessionId?: string;
  readonly actor: ThreadActor;
  readonly actorRef: CanonicalActorRef;
  readonly peers: ThreadPeer[];
  readonly summaries: ThreadSummary[];
  readonly messages: RelayMessage[];
  readonly unreadCount: number;
  readonly revision: number;
}

export interface ThreadPeerSource {
  readonly runId: string;
  readonly agent?: string;
}

export function canonicalActorRef(actor: ThreadActor): CanonicalActorRef {
  return actorKey(actor) as CanonicalActorRef;
}

export function parseCanonicalActorRef(value: string): ThreadActor {
  if (value === 'operator') return { kind: 'operator' };
  if (value.startsWith('run:') && value.length > 4) {
    return { kind: 'run', runId: value.slice(4) };
  }
  throw new Error('Actor must be a canonical ref: operator or run:<id>.');
}

export function unavailableThreadsData(
  error = 'No active Relay task.',
): ThreadsData {
  return {
    status: 'unavailable',
    writable: false,
    error,
    actor: { kind: 'operator' },
    actorRef: 'operator',
    peers: [],
    summaries: [],
    messages: [],
    unreadCount: 0,
    revision: 0,
  };
}

export function buildThreadsData(options: {
  journal: ThreadsJournal;
  actor: ThreadActor;
  peerRuns: readonly ThreadPeerSource[];
  projectRoot?: string;
  writable?: boolean;
}): ThreadsData {
  const { journal, actor } = options;
  const peers: ThreadPeer[] = [];
  if (actor.kind === 'run') {
    peers.push({
      actor: { kind: 'operator' },
      ref: 'operator',
      deliveryModes: ['inbox'],
    });
  }
  for (const run of options.peerRuns) {
    const peerActor: ThreadActor = { kind: 'run', runId: run.runId };
    if (actorsEqual(peerActor, actor)) continue;
    peers.push({
      actor: peerActor,
      ref: canonicalActorRef(peerActor),
      agent: run.agent,
      // Current adapters advertise Relay inbox delivery only.
      deliveryModes: ['inbox'],
    });
  }

  const messages =
    actor.kind === 'operator'
      ? journal.messages
      : journal.messages.filter(
          (message) =>
            actorsEqual(message.from, actor) || actorsEqual(message.to, actor),
        );

  return {
    status: 'ready',
    writable: options.writable ?? true,
    projectRoot: options.projectRoot,
    sessionId: journal.sessionId,
    actor,
    actorRef: canonicalActorRef(actor),
    peers,
    summaries: summarizeThreads(journal, actor),
    messages,
    unreadCount: countUnreadMessages(journal, actor),
    revision: journal.revision,
  };
}

export function filterThreadSummaries(
  summaries: readonly ThreadSummary[],
  query: string,
  unreadOnly: boolean,
): ThreadSummary[] {
  const normalized = query.trim().toLowerCase();
  return summaries.filter((summary) => {
    if (unreadOnly && summary.unreadCount === 0) return false;
    if (!normalized) return true;
    return (
      summary.threadId.toLowerCase().includes(normalized) ||
      summary.latestExcerpt.toLowerCase().includes(normalized) ||
      summary.participants.some((actor) =>
        canonicalActorRef(actor).toLowerCase().includes(normalized),
      )
    );
  });
}

export function messagesForThread(
  data: ThreadsData,
  threadId: string,
): RelayMessage[] {
  return data.messages
    .filter((message) => message.threadId === threadId)
    .sort((a, b) => a.sequence - b.sequence);
}

export function canActOnReceipt(
  message: RelayMessage | undefined,
  actor: ThreadActor,
): boolean {
  return Boolean(message && actorsEqual(message.to, actor));
}

export function receiptLabel(message: RelayMessage): string {
  const receipt = message.delivery;
  if (receipt.acknowledgedAt) return `ACK ${receipt.acknowledgedAt}`;
  if (receipt.readAt) return `READ ${receipt.readAt}`;
  if (receipt.deliveredAt) return `DELIVERED ${receipt.deliveredAt}`;
  if (receipt.expiredAt) {
    return `EXPIRED ${receipt.expirationReason ?? ''} ${receipt.expiredAt}`.trim();
  }
  if (receipt.lastErrorCode) return `ERROR ${receipt.lastErrorCode}`;
  return receipt.state.toUpperCase();
}
