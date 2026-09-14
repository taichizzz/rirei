import {
  actorKey,
  actorsEqual,
  type DeliveryState,
  type MessageIntent,
  type RelayMessage,
  type ThreadActor,
  type ThreadsJournal,
} from './schema.js';

export interface ThreadSummary {
  threadId: string;
  participants: ThreadActor[];
  messageCount: number;
  unreadCount: number;
  latestExcerpt: string;
  intent: MessageIntent;
  deliveryState: DeliveryState;
  createdAt: string;
  updatedAt: string;
}

export function countUnreadMessages(
  journal: ThreadsJournal,
  actor: ThreadActor,
): number {
  return journal.messages.filter(
    (m) => actorsEqual(m.to, actor) && !m.delivery.readAt,
  ).length;
}

export function summarizeThreads(
  journal: ThreadsJournal,
  viewer: ThreadActor,
  options: { filter?: string } = {},
): ThreadSummary[] {
  const threadsMap = new Map<string, RelayMessage[]>();

  for (const message of journal.messages) {
    const list = threadsMap.get(message.threadId) || [];
    list.push(message);
    threadsMap.set(message.threadId, list);
  }

  const summaries: ThreadSummary[] = [];

  for (const [threadId, messages] of threadsMap.entries()) {
    messages.sort((a, b) => a.sequence - b.sequence);
    const first = messages[0]!;
    const latest = messages[messages.length - 1]!;

    const participants: ThreadActor[] = [first.from, first.to];

    // Viewer check: operator sees all; run sees threads where it participates
    if (viewer.kind !== 'operator') {
      const participates = participants.some((p) => actorsEqual(p, viewer));
      if (!participates) continue;
    }

    const unreadCount = messages.filter(
      (m) => actorsEqual(m.to, viewer) && !m.delivery.readAt,
    ).length;

    const summary: ThreadSummary = {
      threadId,
      participants,
      messageCount: messages.length,
      unreadCount,
      latestExcerpt: latest.body.slice(0, 160),
      intent: latest.intent,
      deliveryState: latest.delivery.state,
      createdAt: first.createdAt,
      updatedAt: latest.createdAt,
    };

    if (options.filter) {
      const q = options.filter.toLowerCase();
      const match =
        summary.threadId.toLowerCase().includes(q) ||
        messages.some((message) => message.body.toLowerCase().includes(q)) ||
        participants.some((p) => actorKey(p).toLowerCase().includes(q));
      if (!match) continue;
    }

    summaries.push(summary);
  }

  // Sort by updatedAt descending (newest activity first)
  return summaries.sort(
    (a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
  );
}
