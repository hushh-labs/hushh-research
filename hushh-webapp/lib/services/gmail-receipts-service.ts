import { trackEvent } from "@/lib/observability/client";
import { ApiService } from "@/lib/services/api-service";
import { CACHE_TTL, CacheService } from "@/lib/services/cache-service";
import {
  buildGmailNudgesPath,
  buildGmailReceiptsPath,
  buildGmailStatusPath,
  buildGmailSyncRunPath,
  GMAIL_RECEIPTS_API_TEMPLATES,
} from "@/lib/services/kai-profile-api-paths";

// SHORT (1 min) TTL: fast enough to still reflect a just-completed OAuth
// connect (callers that need guaranteed-fresh data, like the OAuth return
// page, pass `force: true` to bypass this cache), but long enough that
// repeated mounts of the same screen (e.g. `/one/setup`) within a few
// seconds don't each trigger their own network round trip.
const gmailStatusCacheKey = (userId: string) => `gmail_connection_status_${userId}`;

export type GmailConnectionState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "syncing"
  | "connected_initial_scan_running"
  | "connected_backfill_running"
  | "needs_reauthentication"
  | "sync_failed"
  | "error";

export interface GmailSyncRun {
  run_id: string;
  user_id: string;
  trigger_source: string;
  status: "queued" | "running" | "completed" | "failed" | "canceled";
  sync_mode?: "bootstrap" | "incremental" | "manual" | "recovery" | "backfill" | null;
  start_history_id?: string | null;
  end_history_id?: string | null;
  requested_at?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  listed_count: number;
  filtered_count: number;
  synced_count: number;
  extracted_count: number;
  duplicates_dropped: number;
  extraction_success_rate: number;
  error_message?: string | null;
  metrics?: Record<string, unknown>;
}

export interface GmailConnectionStatus {
  configured: boolean;
  connected: boolean;
  status: "connected" | "disconnected" | "error";
  connection_state?:
    | "not_configured"
    | "not_connected"
    | "connected"
    | "needs_reauth"
    | "error"
    | null;
  sync_state?:
    | "idle"
    | "syncing"
    | "incremental_running"
    | "bootstrap_running"
    | "backfill_running"
    | "failed"
    | null;
  bootstrap_state?: "idle" | "queued" | "running" | "completed" | "failed" | null;
  watch_status?:
    | "unknown"
    | "active"
    | "expiring"
    | "expired"
    | "failed"
    | "not_configured"
    | null;
  watch_expires_at?: string | null;
  status_refreshed_at?: string | null;
  needs_reauth?: boolean | null;
  receipt_counts?: Record<string, number | null> | null;
  google_email?: string | null;
  google_sub?: string | null;
  scope_csv: string;
  /** Google granted the Gmail send provider scope during the shared connection. */
  send_permission_granted?: boolean;
  last_sync_at?: string | null;
  last_sync_status: "idle" | "queued" | "running" | "completed" | "failed" | "canceled";
  last_sync_error?: string | null;
  auto_sync_enabled: boolean;
  revoked: boolean;
  connected_at?: string | null;
  disconnected_at?: string | null;
  latest_run?: GmailSyncRun | null;
}

export interface GmailConnectStartResponse {
  configured: boolean;
  authorize_url: string;
  state: string;
  redirect_uri: string;
  expires_at: string;
}

export interface GmailSyncQueueResponse {
  accepted: boolean;
  reason?: string;
  run?: GmailSyncRun | null;
}

export interface ReceiptListItem {
  id: number;
  gmail_message_id: string;
  gmail_thread_id?: string | null;
  gmail_internal_date?: string | null;
  subject?: string | null;
  snippet?: string | null;
  from_name?: string | null;
  from_email?: string | null;
  merchant_name?: string | null;
  order_id?: string | null;
  currency?: string | null;
  amount?: number | null;
  receipt_date?: string | null;
  classification_confidence?: number | null;
  classification_source?: "deterministic" | "llm";
  created_at?: string;
  updated_at?: string;
}

export interface ReceiptListResponse {
  items: ReceiptListItem[];
  page: number;
  per_page: number;
  total: number;
  has_more: boolean;
}

export type GmailNudgeType = "needs_reply" | "upcoming_meeting";

export interface GmailNudge {
  type: GmailNudgeType;
  thread_id: string;
  message_id: string;
  title: string;
  sender: string;
  sender_email: string;
  received_at: string | null;
  /** Meeting start time for upcoming_meeting nudges; null otherwise. */
  starts_at?: string | null;
  /** Conferencing "join" link for upcoming_meeting nudges; null when unavailable. */
  meeting_url?: string | null;
}

export interface GmailNudgesResponse {
  user_id: string;
  account_email: string | null;
  nudges: GmailNudge[];
}

interface ErrorEnvelope {
  detail?:
    | string
    | {
        message?: string;
        code?: string;
      };
  message?: string;
  error?: string;
}

async function extractError(response: Response, fallback: string): Promise<string> {
  const raw = await response.text().catch(() => "");
  try {
    const payload = (raw ? JSON.parse(raw) : null) as ErrorEnvelope | null;
    const detailObj =
      payload?.detail && typeof payload.detail === "object" && !Array.isArray(payload.detail)
        ? payload.detail
        : null;
    const message =
      (typeof detailObj?.message === "string" ? detailObj.message : null) ||
      (typeof payload?.detail === "string" ? payload.detail : null) ||
      (typeof payload?.message === "string" ? payload.message : null) ||
      (typeof payload?.error === "string" ? payload.error : null);
    return (message || fallback).trim();
  } catch {
    return raw.trim() || fallback;
  }
}

function buildSealedHeaders(idToken: string, vaultOwnerToken: string): HeadersInit {
  return {
    Authorization: `Bearer ${idToken}`,
    "X-Hushh-Consent": `Bearer ${vaultOwnerToken}`,
  };
}

export class GmailReceiptsService {
  static async getStatus(params: {
    idToken: string;
    userId: string;
    /** Bypass the short-TTL cache when the caller needs guaranteed-fresh data. */
    force?: boolean;
  }): Promise<GmailConnectionStatus> {
    const cache = CacheService.getInstance();
    const cacheKey = gmailStatusCacheKey(params.userId);
    if (!params.force) {
      const cached = cache.get<GmailConnectionStatus>(cacheKey);
      if (cached) return cached;
    }

    const response = await ApiService.apiFetch(
      buildGmailStatusPath(params.userId),
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${params.idToken}`,
        },
      }
    );

    if (!response.ok) {
      throw new Error(await extractError(response, "Failed to load Gmail connector status."));
    }

    const status = (await response.json()) as GmailConnectionStatus;
    cache.set(cacheKey, status, CACHE_TTL.SHORT);
    return status;
  }

  static async startConnect(params: {
    idToken: string;
    userId: string;
    loginHint?: string | null;
    includeGrantedScopes: boolean;
  }): Promise<GmailConnectStartResponse> {
    trackEvent("gmail_connect_started", {
      action: params.includeGrantedScopes ? "incremental" : "full",
      result: "success",
    });

    const response = await ApiService.apiFetch(GMAIL_RECEIPTS_API_TEMPLATES.connectStart, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${params.idToken}`,
      },
      body: JSON.stringify({
        user_id: params.userId,
        login_hint: params.loginHint || null,
        include_granted_scopes: params.includeGrantedScopes,
      }),
    });

    if (!response.ok) {
      trackEvent("gmail_connect_result", {
        action: "start",
        result: "error",
      });
      throw new Error(await extractError(response, "Failed to start Gmail OAuth."));
    }

    trackEvent("gmail_connect_result", {
      action: "start",
      result: "success",
    });
    return (await response.json()) as GmailConnectStartResponse;
  }

  static async completeConnect(params: {
    idToken: string;
    userId: string;
    code: string;
    state: string;
  }): Promise<GmailConnectionStatus> {
    const response = await ApiService.apiFetch(GMAIL_RECEIPTS_API_TEMPLATES.connectComplete, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${params.idToken}`,
      },
      body: JSON.stringify({
        user_id: params.userId,
        code: params.code,
        state: params.state,
      }),
    });

    if (!response.ok) {
      trackEvent("gmail_connect_result", {
        action: "complete",
        result: "error",
      });
      throw new Error(await extractError(response, "Failed to complete Gmail OAuth."));
    }

    trackEvent("gmail_connect_result", {
      action: "complete",
      result: "success",
    });
    return (await response.json()) as GmailConnectionStatus;
  }

  static async disconnect(params: {
    idToken: string;
    userId: string;
  }): Promise<GmailConnectionStatus> {
    const response = await ApiService.apiFetch(GMAIL_RECEIPTS_API_TEMPLATES.disconnect, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${params.idToken}`,
      },
      body: JSON.stringify({ user_id: params.userId }),
    });

    if (!response.ok) {
      trackEvent("gmail_disconnect_result", { result: "error" });
      throw new Error(await extractError(response, "Failed to disconnect Gmail."));
    }

    trackEvent("gmail_disconnect_result", { result: "success" });
    return (await response.json()) as GmailConnectionStatus;
  }

  static async reconcile(params: {
    idToken: string;
    userId: string;
  }): Promise<GmailConnectionStatus> {
    const response = await ApiService.apiFetch(GMAIL_RECEIPTS_API_TEMPLATES.reconcile, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${params.idToken}`,
      },
      body: JSON.stringify({ user_id: params.userId }),
    });

    if (!response.ok) {
      throw new Error(await extractError(response, "Failed to refresh Gmail connector status."));
    }

    const status = (await response.json()) as GmailConnectionStatus;
    CacheService.getInstance().set(
      gmailStatusCacheKey(params.userId),
      status,
      CACHE_TTL.SHORT,
    );
    return status;
  }

  static async syncNow(params: {
    idToken: string;
    userId: string;
  }): Promise<GmailSyncQueueResponse> {
    trackEvent("gmail_sync_requested", {
      action: "manual",
      result: "success",
    });

    const response = await ApiService.apiFetch(GMAIL_RECEIPTS_API_TEMPLATES.sync, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${params.idToken}`,
      },
      body: JSON.stringify({ user_id: params.userId }),
    });

    if (!response.ok) {
      trackEvent("gmail_sync_result", {
        action: "queue",
        result: "error",
      });
      throw new Error(await extractError(response, "Failed to queue Gmail receipt sync."));
    }

    const payload = (await response.json()) as GmailSyncQueueResponse;
    trackEvent("gmail_sync_result", {
      action: payload.accepted ? "queue" : "already_running",
      result: payload.accepted ? "success" : "expected_error",
    });
    return payload;
  }

  static async getSyncRun(params: {
    idToken: string;
    userId: string;
    runId: string;
  }): Promise<{ run: GmailSyncRun }> {
    const query = new URLSearchParams({ user_id: params.userId }).toString();
    const response = await ApiService.apiFetch(
      `${buildGmailSyncRunPath(params.runId)}?${query}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${params.idToken}`,
        },
      }
    );

    if (!response.ok) {
      throw new Error(await extractError(response, "Failed to load Gmail sync run status."));
    }

    return (await response.json()) as { run: GmailSyncRun };
  }

  static async listReceipts(params: {
    idToken: string;
    vaultOwnerToken: string;
    userId: string;
    page?: number;
    perPage?: number;
  }): Promise<ReceiptListResponse> {
    const query = new URLSearchParams({
      page: String(params.page ?? 1),
      per_page: String(params.perPage ?? 25),
    }).toString();
    const response = await ApiService.apiFetch(
      `${buildGmailReceiptsPath(params.userId)}?${query}`,
      {
        method: "GET",
        headers: buildSealedHeaders(params.idToken, params.vaultOwnerToken),
      }
    );

    if (!response.ok) {
      trackEvent("gmail_receipts_loaded", {
        result: "error",
      });
      throw new Error(await extractError(response, "Failed to load synced Gmail receipts."));
    }

    trackEvent("gmail_receipts_loaded", {
      result: "success",
    });
    return (await response.json()) as ReceiptListResponse;
  }

  static async listNudges(params: {
    idToken: string;
    vaultOwnerToken: string;
    userId: string;
    limit?: number;
  }): Promise<GmailNudgesResponse> {
    const query = new URLSearchParams({
      limit: String(params.limit ?? 10),
    }).toString();
    const response = await ApiService.apiFetch(
      `${buildGmailNudgesPath(params.userId)}?${query}`,
      {
        method: "GET",
        headers: buildSealedHeaders(params.idToken, params.vaultOwnerToken),
      }
    );

    if (!response.ok) {
      throw new Error(await extractError(response, "Failed to load Gmail nudges."));
    }

    return (await response.json()) as GmailNudgesResponse;
  }
}
