import { ApiService } from "@/lib/services/api-service";
import { currentFeedInvalidationEpoch } from "@/lib/cache/feed-invalidation-epoch";
import {
  CACHE_KEYS,
  CACHE_TTL,
  CacheService,
} from "@/lib/services/cache-service";

export type FeedSourceDomain =
  "consent" | "location" | "kai" | "kyc" | "connected_systems" | "connections" | "profile_discovery";

/**
 * The private-agent lifecycle vocabulary, emitted by
 * `personal_agent_provisioning_service.py`.
 *
 * Held as a value, not only a type, so a test can iterate it — and so the one
 * check that matters can compare it against the backend's own constants at run
 * time. None of these were in `FeedEventType` at all, which meant the union
 * offered no protection whatsoever against a typo'd or unrendered event name:
 * `FeedItem.event_type` widens to `| string`, so everything compiled either way.
 */
export const PERSONAL_AGENT_EVENT_TYPES = [
  "personal_agent_reserved",
  "personal_agent_provisioning",
  "personal_agent_connecting",
  "personal_agent_ready",
  "personal_agent_failed",
  "personal_agent_provisioning_capped",
  "personal_agent_reaped",
  "personal_agent_updated",
] as const;

export type PersonalAgentEventType = (typeof PERSONAL_AGENT_EVENT_TYPES)[number];

export type FeedEventType =
  | PersonalAgentEventType
  | ProfileDiscoveryEventType
  | "consent_requested"
  | "consent_granted"
  | "consent_revoked"
  | "location_share_created"
  | "location_share_revoked"
  | "location_share_shortened"
  | "location_share_duration_changed"
  | "location_share_expired"
  | "location_share_viewed"
  | "location_access_request"
  | "location_access_approved"
  | "location_access_denied"
  | "location_access_request_withdrawn"
  | "location_referral_invite"
  | "location_public_invite_submitted"
  | "location_one_network_joined"
  | "location_circle_code_joined"
  | "location_circle_message"
  | "location_circle_member_invite_accepted"
  | "location_sms_contact_added"
  | "location_sms_contact_removed"
  | "circle_member_invited"
  | "circle_member_added"
  | "funding_transfer_status"
  | "kai_analysis_completed"
  | "kyc_status_changed"
  | "connected_systems_approved"
  | "connected_systems_connected"
  | "connected_systems_rejected"
  | "connected_systems_failed"
  | "calendar_connected"
  | "calendar_reconnect_required"
  | "calendar_disconnected"
  | "calendar_event_created"
  | "calendar_event_rescheduled"
  | "calendar_event_canceled"
  | "mail_connected"
  | "mail_reconnect_required"
  | "mail_disconnected"
  | "mail_information_request_detected"
  | "mail_receipts_imported"
  | "mail_sync_completed"
  | "mail_sync_failed"
  | "mail_message_sent"
  | "mail_message_failed"
  | "mail_delivery_unconfirmed"
  | "connection_accepted"
  | "connection_rejected"
  | "connection_revoked"
  | "direct_message_received"
  | "calendar_action_failed"
  | "mail_mailbox_archive"
  | "mail_mailbox_trash"
  | "mail_mailbox_add_label"
  | "mail_mailbox_remove_label"
  | "mail_mailbox_mark_read"
  | "mail_mailbox_mark_unread"
  | "mail_mailbox_failed"
  | "connected_systems_mutation_succeeded"
  | "connected_systems_mutation_partial"
  | "connected_systems_disconnected"
  | "connector_connected"
  | "connector_reconnect_required"
  | "connector_disconnected"
  | "drive_search_completed"
  | "drive_search_limited"
  | "drive_search_failed"
  | "drive_search_stopped"
  | "drive_share_succeeded"
  | "drive_share_failed"
  | "drive_share_unconfirmed"
  | "drive_trash_succeeded"
  | "drive_trash_failed"
  | "drive_trash_unconfirmed"
  | "drive_bulk_received"
  | "drive_bulk_completed"
  | "drive_bulk_partial"
  | "drive_bulk_failed"
  | "drive_bulk_stopped"
  | "drive_question_withdrawn"
  | "drive_question_retry_required"
  | "kai_analysis_failed"
  | "kai_analysis_canceled"
  | "kai_import_completed"
  | "kai_import_failed"
  | "kai_import_canceled"
  | "consent_denied"
  | "consent_cancelled"
  | "consent_timed_out"
  | "circle_invite_declined"
  | "circle_invite_cancelled"
  | "circle_member_left"
  | "circle_membership_ended"
  | "circle_deleted"
  | "connection_withdrawn";

export type ProfileDiscoveryEventType =
  | "profile_discovery_queued"
  | "profile_discovery_scanning"
  | "profile_discovery_needs_details"
  | "profile_discovery_ready"
  | "profile_discovery_failed"
  | "profile_discovery_claimed"
  | "profile_discovery_cancelled";

export type FeedItem = {
  id: string;
  source_domain: FeedSourceDomain;
  event_type: FeedEventType | string;
  actor_label: string | null;
  metadata: Record<string, unknown>;
  read: boolean;
  created_at: string;
};

export type FeedListResponse = {
  items: FeedItem[];
  next_cursor: string | null;
  unread_count: number;
};

type ErrorPayload = {
  detail?: string | { message?: unknown; code?: unknown };
  error?: string;
};

function feedRequestError(payload: ErrorPayload, status: number): Error {
  const detail = payload.detail;
  const message =
    typeof detail === "string"
      ? detail
      : detail && typeof detail.message === "string"
        ? detail.message
        : payload.error;
  return new Error(message || `Request failed: ${status}`);
}

async function authHeader(idToken: string): Promise<Record<string, string>> {
  return { Authorization: `Bearer ${idToken}` };
}

export class FeedService {
  /**
   * The first page (no cursor) is the only page cached: it's what a revisit
   * needs to render instantly, and it's what the mutation/poll paths below
   * can coherently invalidate. Pagination ("load more") always calls this
   * with a cursor and a `userId`-less request, so it skips the cache.
   */
  static async list(options: {
    idToken: string;
    userId?: string;
    cursor?: string | null;
    limit?: number;
    force?: boolean;
  }): Promise<FeedListResponse> {
    const isFirstPage = !options.cursor;
    const firstPageUserId = isFirstPage ? options.userId : undefined;
    const cacheKey = firstPageUserId
      ? CACHE_KEYS.FEED_LIST(firstPageUserId)
      : null;
    const cache = CacheService.getInstance();
    const epoch = firstPageUserId ? currentFeedInvalidationEpoch(firstPageUserId) : null;
    if (cacheKey && !options.force) {
      const cached = cache.get<FeedListResponse>(cacheKey);
      if (cached) return cached;
    }

    const query = new URLSearchParams();
    if (options.cursor) query.set("cursor", options.cursor);
    if (options.limit) query.set("limit", String(options.limit));
    const search = query.toString();
    const response = await ApiService.apiFetch(
      `/api/one/feed${search ? `?${search}` : ""}`,
      {
        method: "GET",
        headers: await authHeader(options.idToken),
      },
    );
    const payload = (await response
      .json()
      .catch(() => ({}))) as FeedListResponse & ErrorPayload;
    if (!response.ok) {
      throw feedRequestError(payload, response.status);
    }
    if (cacheKey && firstPageUserId && epoch === currentFeedInvalidationEpoch(firstPageUserId)) {
      cache.set(cacheKey, payload, CACHE_TTL.SHORT);
      // The list response and bottom-nav badge describe the same snapshot.
      // Seed both keyed projections together so opening Feed does not launch a
      // redundant count request or briefly display an older badge.
      cache.set(
        CACHE_KEYS.FEED_UNREAD_COUNT(firstPageUserId),
        payload.unread_count,
        CACHE_TTL.SHORT,
      );
    }
    return payload;
  }

  static async unreadCount(options: {
    idToken: string;
    userId: string;
    force?: boolean;
  }): Promise<number> {
    const cacheKey = CACHE_KEYS.FEED_UNREAD_COUNT(options.userId);
    const cache = CacheService.getInstance();
    const epoch = currentFeedInvalidationEpoch(options.userId);
    if (!options.force) {
      const cached = cache.get<number>(cacheKey);
      if (cached != null) return cached;
    }
    const response = await ApiService.apiFetch("/api/one/feed/unread-count", {
      method: "GET",
      headers: await authHeader(options.idToken),
    });
    const payload = (await response.json().catch(() => ({}))) as {
      unread_count?: number;
    } & ErrorPayload;
    if (!response.ok) {
      throw feedRequestError(payload, response.status);
    }
    const count = payload.unread_count ?? 0;
    if (epoch === currentFeedInvalidationEpoch(options.userId)) cache.set(cacheKey, count, CACHE_TTL.SHORT);
    return count;
  }

  static async markRead(options: {
    idToken: string;
    upToId: string;
  }): Promise<void> {
    const response = await ApiService.apiFetch("/api/one/feed/read", {
      method: "POST",
      headers: {
        ...(await authHeader(options.idToken)),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        // Keep bigint identifiers as decimal strings in JavaScript. Pydantic
        // validates/coerces the request without crossing Number's 53-bit limit.
        up_to_id: options.upToId,
      }),
    });
    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as ErrorPayload;
      throw feedRequestError(payload, response.status);
    }
  }
}
