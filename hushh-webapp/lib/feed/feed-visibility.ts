import type { FeedItem } from "@/lib/services/feed-service";

/**
 * Whether a Feed row is held back in this build.
 *
 * CRM rows (`connected_systems_*`) stay behind the local CRM build flag.
 * Drive, Calendar, and Mail rows share the `connected_systems` domain but
 * are not CRM; their privacy-bounded activity always shows in Feed.
 */
export function isFeedItemHidden(
  item: Pick<FeedItem, "source_domain" | "event_type">,
  crmEnabled: boolean,
): boolean {
  const eventType = String(item.event_type);
  return (
    item.source_domain === "connected_systems" &&
    !eventType.startsWith("document_share_") &&
    !eventType.startsWith("calendar_") &&
    !eventType.startsWith("mail_") &&
    !crmEnabled
  );
}
