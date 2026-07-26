import { ApiService } from "@/lib/services/api-service";
import { CACHE_KEYS, CACHE_TTL, CacheService } from "@/lib/services/cache-service";

export type FeedSourceDomain =
  | "consent"
  | "location"
  | "kai"
  | "kyc"
  | "connected_systems"
  | "connections";

export type FeedEventType =
  | "consent_requested"
  | "consent_granted"
  | "consent_revoked"
  | "location_share_created"
  | "location_share_revoked"
  | "location_share_expired"
  | "location_access_request"
  | "location_access_approved"
  | "location_access_denied"
  | "kai_analysis_completed"
  | "kyc_status_changed"
  | "connected_systems_approved"
  | "connected_systems_connected"
  | "connected_systems_rejected"
  | "connected_systems_failed"
  | "connection_accepted"
  | "connection_rejected"
  | "connection_revoked";

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

type ErrorPayload = { detail?: string; error?: string };

async function authHeader(idToken: string): Promise<Record<string, string>> {
  return { Authorization: `Bearer ${idToken}` };
}

export class FeedService {
  static async list(options: {
    idToken: string;
    cursor?: string | null;
    limit?: number;
  }): Promise<FeedListResponse> {
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
      throw new Error(payload.detail || payload.error || `Request failed: ${response.status}`);
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
    if (!options.force) {
      const cached = cache.get<number>(cacheKey);
      if (cached != null) return cached;
    }
    const response = await ApiService.apiFetch("/api/one/feed/unread-count", {
      method: "GET",
      headers: await authHeader(options.idToken),
    });
    const payload = (await response
      .json()
      .catch(() => ({}))) as { unread_count?: number } & ErrorPayload;
    if (!response.ok) {
      throw new Error(payload.detail || payload.error || `Request failed: ${response.status}`);
    }
    const count = payload.unread_count ?? 0;
    cache.set(cacheKey, count, CACHE_TTL.SHORT);
    return count;
  }

  static async markRead(options: { idToken: string; upToId?: string | null }): Promise<void> {
    const response = await ApiService.apiFetch("/api/one/feed/read", {
      method: "POST",
      headers: {
        ...(await authHeader(options.idToken)),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        up_to_id: options.upToId ? Number(options.upToId) : null,
      }),
    });
    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as ErrorPayload;
      throw new Error(payload.detail || payload.error || `Request failed: ${response.status}`);
    }
  }
}
