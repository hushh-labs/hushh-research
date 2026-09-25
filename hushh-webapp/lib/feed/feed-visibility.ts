import type { FeedItem } from "@/lib/services/feed-service";

/**
 * Whether a Feed row is held back in this build.
 *
 * CRM rows (`connected_systems_*`) stay behind the local CRM build flag.
 * Drive sharing and Drive question rows (migration 246) share the
 * `connected_systems` domain but are not CRM: they are how a person learns
 * that files were shared with them, so they always show.
 */
export function isFeedItemHidden(
  item: Pick<FeedItem, "source_domain" | "event_type">,
  crmEnabled: boolean,
): boolean {
  return (
    item.source_domain === "connected_systems" &&
    !String(item.event_type).startsWith("document_share_") &&
    !crmEnabled
  );
}
