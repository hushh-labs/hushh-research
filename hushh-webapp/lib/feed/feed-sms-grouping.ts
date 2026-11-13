import type { FeedActionable } from "@/lib/feed/use-feed-actionables";

export interface FeedSmsAlertGroup {
  id: string;
  items: FeedActionable[];
  latest: FeedActionable;
  activeCount: number;
}

/** One current incident per sender. Older incidents never expand inside Feed. */
export function groupFeedSmsAlerts(items: readonly FeedActionable[]): FeedSmsAlertGroup[] {
  const groups = new Map<string, FeedActionable[]>();
  const seen = new Set<string>();
  for (const item of items) {
    if (!item.smsEmergency || seen.has(item.id)) continue;
    seen.add(item.id);
    // Labels are not identities. Unknown senders must never be joined together.
    const key = item.smsEmergency.senderId || item.id;
    const members = groups.get(key) ?? [];
    members.push(item);
    groups.set(key, members);
  }
  return [...groups].map(([id, members]) => {
    members.sort((a, b) => b.sortAt - a.sortAt || a.id.localeCompare(b.id));
    const latest = members[0]!;
    return { id, items: [latest], latest, activeCount: latest.emphasis === "emergency" ? 1 : 0 };
  }).sort((a, b) => b.latest.sortAt - a.latest.sortAt || a.id.localeCompare(b.id));
}
