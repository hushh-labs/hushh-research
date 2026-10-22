export const ONE_MEMORY_ACTIONS = [
  "export_saved",
  "capture_prepared",
  "capture_saved",
  "detail_edited",
  "detail_deleted",
  "auto_save_changed",
] as const;
export const ONE_WALLET_ACTIONS = ["card_added", "card_deleted"] as const;
export const ONE_CALENDAR_ACTIONS = ["connected", "disconnected", "chat_opened"] as const;
export const ONE_KYC_ACTIONS = [
  "redraft_completed",
  "reply_sent",
  "reply_rejected",
  "workflow_refreshed",
  "access_approved",
  "access_denied",
] as const;
export const ONE_CRM_ACTIONS = ["record_created", "record_updated", "record_deleted"] as const;
export const GMAIL_CONNECT_STARTED_ACTIONS = ["incremental", "full"] as const;
export const GMAIL_CONNECT_RESULT_ACTIONS = ["start", "complete"] as const;
export const GMAIL_SYNC_RESULT_ACTIONS = ["queue", "already_running", "complete", "poll"] as const;

/**
 * Low-cardinality One Location actions used to connect the Location, Connect,
 * Circles and Profile surfaces without sending any record identifiers or
 * user-authored text to analytics.
 */
export const ONE_LOCATION_JOURNEY_ACTIONS = [
  "contact_sync_started",
  "contact_invitation_handoff",
  "circle_tab_opened",
  "circle_create_started",
  "circle_join_started",
  "circle_opened",
  "circle_joined",
  "circle_member_invited",
  "circle_member_removed",
  "circle_invite_cancelled",
  "circle_invite_declined",
  "circle_left",
  "circle_deleted",
  "circle_code_shared",
  "location_request_approved",
  "location_request_denied",
  "location_request_fulfilled",
  "location_share_viewed",
  "nearby_check_in_result",
  "public_link_opened",
  "public_link_shared",
  "public_link_revoked",
] as const;

export type OneLocationJourneyAction = (typeof ONE_LOCATION_JOURNEY_ACTIONS)[number];

export type OneLocationJourneyEntrySurface =
  | "location_hub"
  | "connect_people"
  | "connect_circles"
  | "profile"
  | "consent_center"
  | "public_link"
  | "agent"
  | "unknown";

export type OneLocationJourneyTarget =
  | "person"
  | "circle"
  | "contacts"
  | "public"
  | "none";
