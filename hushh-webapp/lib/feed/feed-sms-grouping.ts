import type { FeedActionable } from "@/lib/feed/use-feed-actionables";

export interface FeedSmsAlertGroup {
  id: string;
  items: FeedActionable[];
  latest: FeedActionable;
  activeCount: number;
}

/** Each incident stays separate; only revisions of its verified operation fold. */
export function groupFeedSmsAlerts(items: readonly FeedActionable[]): FeedSmsAlertGroup[] {
  const incidents = new Map<string, FeedActionable>();
  for (const item of items) {
    if (!item.smsEmergency) continue;
    const key = item.operationKey || item.id;
    const previous = incidents.get(key);
    if (!previous || item.sortAt > previous.sortAt || (item.sortAt === previous.sortAt && item.id > previous.id)) incidents.set(key, item);
  }
  return [...incidents].map(([id, latest]) => ({ id, items: [latest], latest,
    activeCount: latest.emphasis === "emergency" ? 1 : 0,
  })).sort((a, b) => b.activeCount - a.activeCount || b.latest.sortAt - a.latest.sortAt || a.id.localeCompare(b.id));
}
