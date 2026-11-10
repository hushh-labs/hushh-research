import type { DirectMessage, DirectMessageReaction } from "@/lib/services/direct-messages-service";

// Metadata belongs only to the allocated optimistic array. A fresh server
// projection has no lease, so an older mutation cannot undo that projection.
const leases = Symbol("reaction mutations");
type Lease = { token: object; previous: DirectMessageReaction | undefined };
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
  next[leases]!.set(emoji, { token, previous });
  return { ...message, reactions: next };
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
