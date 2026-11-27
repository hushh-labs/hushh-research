import type { DirectMessage, DirectMessageReaction } from "@/lib/services/direct-messages-service";

// Leases stay on the in-memory reaction array, scoped to the current visit.
const leases = Symbol("reaction mutations");
type Lease = { token: object; previous: DirectMessageReaction | undefined; reactedByViewer: boolean };
type Reactions = DirectMessageReaction[] & { [leases]?: Map<string, Lease> };

function replaceEmoji(current: Reactions, emoji: string, entry: DirectMessageReaction | undefined) {
  const next: Reactions = current.filter((reaction) => reaction.emoji !== emoji);
  if (entry) next.push(entry);
  Object.defineProperty(next, leases, { value: new Map(current[leases]) });
  return next;
}

export function beginReaction(message: DirectMessage, emoji: string, token: object, removing: boolean): DirectMessage {
  if (message.deletedForEveryoneAt) return { ...message, reactions: [] };
  const current: Reactions = message.reactions ?? [];
  const previous = current.find((reaction) => reaction.emoji === emoji);
  const count = (previous?.count ?? 0) + (removing ? -1 : 1);
  const next = replaceEmoji(current, emoji, count > 0
    ? { emoji, count, reactedByViewer: !removing } : undefined);
  next[leases]!.set(emoji, { token, previous, reactedByViewer: !removing });
  return { ...message, reactions: next };
}

/** Accept refreshed server fields without erasing an unconfirmed local reaction. */
export function reconcileReactions(current: DirectMessage, incoming: DirectMessage): DirectMessage {
  if (current.id !== incoming.id || current.conversationId !== incoming.conversationId || incoming.deletedForEveryoneAt) return incoming;
  const pending = (current.reactions as Reactions | undefined)?.[leases];
  if (!pending?.size) return incoming;
  let reactions: Reactions = incoming.reactions ?? [];
  for (const [emoji, lease] of pending) {
    const previous = reactions.find(reaction => reaction.emoji === emoji);
    // A server echo confirms intent. Retire its lease so a delayed older
    // mutation response cannot overwrite newer authoritative counts.
    if (Boolean(previous?.reactedByViewer) === lease.reactedByViewer) continue;
    const count = (previous?.count ?? 0) + (lease.reactedByViewer ? 1 : -1);
    reactions = replaceEmoji(reactions, emoji, count > 0
      ? { emoji, count, reactedByViewer: lease.reactedByViewer } : undefined);
    reactions[leases]!.set(emoji, { ...lease, previous });
  }
  return { ...incoming, reactions };
}

export function settleReaction(message: DirectMessage, emoji: string, token: object, result?: DirectMessage): DirectMessage {
  if (message.deletedForEveryoneAt) return { ...message, reactions: [] };
  const current: Reactions = message.reactions ?? [];
  const lease = current[leases]?.get(emoji);
  if (lease?.token !== token) return message;
  const entry = result ? result.reactions?.find((reaction) => reaction.emoji === emoji) : lease.previous;
  const next = replaceEmoji(current, emoji, entry);
  next[leases]!.delete(emoji);
  return { ...message, reactions: next };
}
