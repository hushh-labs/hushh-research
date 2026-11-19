import type { FeedItem } from "@/lib/services/feed-service";

import policy from "./activity-policy.generated.json";

type EventPolicy = { agent: string; kind: string; operation: string; metadata?: Readonly<Record<string, readonly string[]>> };
const EVENTS: Readonly<Record<string, EventPolicy>> = policy.events;

export function feedEventPolicy(eventType: string): EventPolicy | undefined {
  return Object.hasOwn(EVENTS, eventType) ? EVENTS[eventType] : undefined;
}

/**
 * Whether a Feed row is held back in this build.
 *
 * CRM rows (`connected_systems_*`) stay behind the local CRM build flag.
 * Drive, Calendar, and Mail rows share the `connected_systems` domain but
 * are not CRM; their eligible activity remains available without CRM.
 */
export function isFeedItemHidden(
  item: Pick<FeedItem, "source_domain" | "event_type"> & Partial<Pick<FeedItem, "metadata">>,
  crmEnabled: boolean,
): boolean {
  const eventType = String(item.event_type);
  if (item.source_domain === "connections" && item.metadata?.actor_is_self === true) return true;
  // Mirrors the canonical backend admission policy for older cached pages.
  const rule = feedEventPolicy(eventType);
  if (!rule || rule.kind === "routine") return true;
  for (const [field, values] of Object.entries(rule.metadata || {})) {
    const value = item.metadata?.[field];
    if (typeof value !== "string" || !values.includes(value)) return true;
  }
  return (
    item.source_domain === "connected_systems" &&
    !eventType.startsWith("document_share_") &&
    !eventType.startsWith("drive_") &&
    !eventType.startsWith("connector_") &&
    !eventType.startsWith("calendar_") &&
    !eventType.startsWith("mail_") &&
    !crmEnabled
  );
}
