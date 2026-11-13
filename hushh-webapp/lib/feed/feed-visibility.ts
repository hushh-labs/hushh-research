import type { FeedItem } from "@/lib/services/feed-service";

/**
 * Whether a Feed row is held back in this build.
 *
 * CRM rows (`connected_systems_*`) stay behind the local CRM build flag.
 * Drive, Calendar, and Mail rows share the `connected_systems` domain but
 * are not CRM; their privacy-bounded activity always shows in Feed.
 */
export function isFeedItemHidden(
  item: Pick<FeedItem, "source_domain" | "event_type"> & { metadata?: Record<string, unknown> },
  crmEnabled: boolean,
): boolean {
  const eventType = String(item.event_type);
  // Also fence stale in-memory pages during a rolling backend deployment.
  // The server applies the policy before paging/counting; this is no authority.
  const metadata = item.metadata ?? {};
  if (item.source_domain === "location") {
    if (["location_access_request", "location_access_approved", "location_access_request_withdrawn",
      "location_share_viewed", "location_circle_message", "location_one_network_joined",
      "location_circle_code_joined", "location_circle_member_invite_accepted", "circle_member_left",
      "circle_invite_cancelled", "circle_member_invited", "location_public_invite_submitted"].includes(eventType)) return true;
    if (eventType.startsWith("location_share_") && metadata.feed_audience !== "recipient") return true;
    if (["location_sms_contact_added", "location_sms_contact_removed"].includes(eventType)
      && metadata.feed_audience !== "recipient") return true;
    if (eventType === "location_access_denied" && metadata.feed_audience !== "requester") return true;
  }
  if (item.source_domain === "connections") {
    if (metadata.actor_is_self === true || eventType === "connection_withdrawn") return true;
    if (eventType === "direct_message_received" && !metadata.wallet_card_grant_id && !metadata.wallet_card_request_id) return true;
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
