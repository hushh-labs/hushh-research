import type { FeedActionable } from "@/lib/feed/use-feed-actionables";

export interface FeedSmsAlertGroup {
  id: string;
  items: FeedActionable[];
  latest: FeedActionable;
  activeCount: number;
}

/** Group presentation only; every incident retains its own grant and sent time. */
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
    const active = members.filter((item) => item.emphasis === "emergency");
    return { id, items: members, latest: active[0] ?? members[0]!, activeCount: active.length };
  }).sort((a, b) => b.latest.sortAt - a.latest.sortAt || a.id.localeCompare(b.id));
}
