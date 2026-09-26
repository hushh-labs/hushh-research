import { trackEvent } from "@/lib/observability/client";
import { ApiService } from "@/lib/services/api-service";
import { AuthService } from "@/lib/services/auth-service";
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
const gmailStatusCacheKey = (userId: string) =>
  `gmail_connection_status_${userId}`;

function trackGmailEventForOwner(
  userId: string,
  eventName: Parameters<typeof trackEvent>[0],
  payload: Parameters<typeof trackEvent>[1],
): void {
  if (AuthService.getCurrentUser()?.uid !== userId) return;
  trackEvent(eventName, payload as never);
}

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
  sync_mode?:
    "bootstrap" | "incremental" | "manual" | "recovery" | "backfill" | null;
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
  bootstrap_state?:
    "idle" | "queued" | "running" | "completed" | "failed" | null;
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
  /** Provider-side draft creation is separate from local composition and sending. */
  compose_permission_granted?: boolean;
  /** Google granted the Gmail send provider scope during the shared connection. */
  send_permission_granted?: boolean;
  last_sync_at?: string | null;
  last_sync_status:
    "idle" | "queued" | "running" | "completed" | "failed" | "canceled";
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

export interface GmailNativeConnectStartResponse {
  configured: boolean;
  server_client_id: string;
  purpose: "read" | "send" | "compose";
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function parseNativeConnectStartResponse(
  response: Response,
): Promise<GmailNativeConnectStartResponse> {
  const payload: unknown = await response.json();
  if (
    !isRecord(payload) ||
    typeof payload.configured !== "boolean" ||
    typeof payload.server_client_id !== "string" ||
    payload.server_client_id.trim().length === 0 ||
    (payload.purpose !== "read" && payload.purpose !== "send")
  ) {
    throw new Error("Mail OAuth start returned an invalid response.");
  }
  return payload as unknown as GmailNativeConnectStartResponse;
}

async function parseConnectStartResponse(
  response: Response,
): Promise<GmailConnectStartResponse> {
  const payload: unknown = await response.json();
  if (
    !isRecord(payload) ||
    typeof payload.configured !== "boolean" ||
    typeof payload.authorize_url !== "string" ||
    payload.authorize_url.trim().length === 0 ||
    typeof payload.state !== "string" ||
    payload.state.trim().length === 0 ||
    typeof payload.redirect_uri !== "string" ||
    typeof payload.expires_at !== "string" ||
    payload.expires_at.trim().length === 0
  ) {
    throw new Error("Mail OAuth start returned an invalid response.");
  }
  return payload as unknown as GmailConnectStartResponse;
}

async function parseConnectionStatus(
  response: Response,
): Promise<GmailConnectionStatus> {
  const payload: unknown = await response.json();
  if (
    !isRecord(payload) ||
    typeof payload.configured !== "boolean" ||
    payload.connected !== true ||
    payload.status !== "connected"
  ) {
    throw new Error("Mail OAuth completion returned an invalid response.");
  }
  return payload as unknown as GmailConnectionStatus;
}

async function extractError(
  response: Response,
  fallback: string,
): Promise<string> {
  const raw = await response.text().catch(() => "");
  try {
    const payload = (raw ? JSON.parse(raw) : null) as ErrorEnvelope | null;
    const detailObj =
      payload?.detail &&
      typeof payload.detail === "object" &&
      !Array.isArray(payload.detail)
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

function buildSealedHeaders(
  idToken: string,
  vaultOwnerToken: string,
): HeadersInit {
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
      },
    );

    if (!response.ok) {
      throw new Error(
        await extractError(response, "Failed to load Mail connector status."),
      );
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
    purpose?: "read" | "send" | "compose";
  }): Promise<GmailConnectStartResponse> {
    trackGmailEventForOwner(params.userId, "gmail_connect_started", {
      action: params.includeGrantedScopes ? "incremental" : "full",
      result: "success",
    });

    try {
      const response = await ApiService.apiFetch(
        GMAIL_RECEIPTS_API_TEMPLATES.connectStart,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${params.idToken}`,
          },
          body: JSON.stringify({
            user_id: params.userId,
            login_hint: params.loginHint || null,
            include_granted_scopes: params.includeGrantedScopes,
            purpose: params.purpose || "read",
          }),
        },
      );
      if (!response.ok) {
        throw new Error(
          await extractError(response, "Failed to start Mail OAuth."),
        );
      }
      const payload = await parseConnectStartResponse(response);
      trackGmailEventForOwner(params.userId, "gmail_connect_result", {
        action: "start",
        result: "success",
      });
      return payload;
    } catch (error) {
      trackGmailEventForOwner(params.userId, "gmail_connect_result", {
        action: "start",
        result: "error",
      });
      throw error;
    }
  }

  static async startNativeConnect(params: {
    idToken: string;
    userId: string;
    purpose?: "read" | "send" | "compose";
  }): Promise<GmailNativeConnectStartResponse> {
    trackGmailEventForOwner(params.userId, "gmail_connect_started", {
      action: params.purpose === "send" ? "incremental" : "full",
      result: "success",
    });
    try {
      const response = await ApiService.apiFetch(
        GMAIL_RECEIPTS_API_TEMPLATES.connectNativeStart,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${params.idToken}`,
          },
          body: JSON.stringify({ purpose: params.purpose || "read" }),
        },
      );
      if (!response.ok) {
        throw new Error(
          await extractError(response, "Failed to start native Mail OAuth."),
        );
      }
      const payload = await parseNativeConnectStartResponse(response);
      trackGmailEventForOwner(params.userId, "gmail_connect_result", {
        action: "start",
        result: "success",
      });
      return payload;
    } catch (error) {
      trackGmailEventForOwner(params.userId, "gmail_connect_result", {
        action: "start",
        result: "error",
      });
      throw error;
    }
  }

  static async completeNativeConnect(params: {
    idToken: string;
    userId: string;
    serverAuthCode: string;
    purpose?: "read" | "send";
  }): Promise<GmailConnectionStatus> {
    try {
      const response = await ApiService.apiFetch(
        GMAIL_RECEIPTS_API_TEMPLATES.connectNativeComplete,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${params.idToken}`,
          },
          body: JSON.stringify({
            user_id: params.userId,
            server_auth_code: params.serverAuthCode,
          }),
        },
      );
      if (!response.ok) {
        throw new Error(
          await extractError(response, "Failed to complete native Mail OAuth."),
        );
      }
      const status = await parseConnectionStatus(response);
      if (params.purpose === "send" && status.send_permission_granted !== true) {
        throw new Error("Mail authorization did not grant sending permission.");
      }
      trackGmailEventForOwner(params.userId, "gmail_connect_result", {
        action: "complete",
        result: "success",
      });
      return status;
    } catch (error) {
      trackGmailEventForOwner(params.userId, "gmail_connect_result", {
        action: "complete",
        result: "error",
      });
      throw error;
    }
  }

  static recordConsentFailure(error: unknown, userId?: string): void {
    const code =
      error && typeof error === "object" && "code" in error
        ? String(error.code || "").trim().toUpperCase()
        : "";
    const payload = {
      action: "complete",
      result: code === "USER_CANCELLED" ? "expected_error" : "error",
    } as const;
    if (userId) {
      trackGmailEventForOwner(userId, "gmail_connect_result", payload);
    } else {
      trackEvent("gmail_connect_result", payload);
    }
  }

  static recordConnectCompletion(result: "success" | "error"): void {
    trackEvent("gmail_connect_result", {
      action: "complete",
      result,
    });
  }

  static async completeConnect(params: {
    idToken: string;
    userId: string;
    code: string;
    state: string;
  }, options: { recordTelemetry?: boolean } = {}): Promise<GmailConnectionStatus> {
    const recordTelemetry = options.recordTelemetry !== false;
    try {
      const response = await ApiService.apiFetch(
        GMAIL_RECEIPTS_API_TEMPLATES.connectComplete,
        {
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
        },
      );
      if (!response.ok) {
        throw new Error(
          await extractError(response, "Failed to complete Mail OAuth."),
        );
      }
      const status = await parseConnectionStatus(response);
      if (recordTelemetry) {
        trackGmailEventForOwner(params.userId, "gmail_connect_result", {
          action: "complete",
          result: "success",
        });
      }
      return status;
    } catch (error) {
      if (recordTelemetry) {
        trackGmailEventForOwner(params.userId, "gmail_connect_result", {
          action: "complete",
          result: "error",
        });
      }
      throw error;
    }
  }

  static async disconnect(params: {
    idToken: string;
    userId: string;
  }): Promise<GmailConnectionStatus> {
    const response = await ApiService.apiFetch(
      GMAIL_RECEIPTS_API_TEMPLATES.disconnect,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${params.idToken}`,
        },
        body: JSON.stringify({ user_id: params.userId }),
      },
    );

    if (!response.ok) {
      trackGmailEventForOwner(params.userId, "gmail_disconnect_result", { result: "error" });
      throw new Error(
        await extractError(response, "Failed to disconnect Mail."),
      );
    }

    trackGmailEventForOwner(params.userId, "gmail_disconnect_result", { result: "success" });
    return (await response.json()) as GmailConnectionStatus;
  }

  static async reconcile(params: {
    idToken: string;
    userId: string;
  }): Promise<GmailConnectionStatus> {
    const response = await ApiService.apiFetch(
      GMAIL_RECEIPTS_API_TEMPLATES.reconcile,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${params.idToken}`,
        },
        body: JSON.stringify({ user_id: params.userId }),
      },
    );

    if (!response.ok) {
      throw new Error(
        await extractError(
          response,
          "Failed to refresh Mail connector status.",
        ),
      );
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

    const response = await ApiService.apiFetch(
      GMAIL_RECEIPTS_API_TEMPLATES.sync,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${params.idToken}`,
        },
        body: JSON.stringify({ user_id: params.userId }),
      },
    );

    if (!response.ok) {
      trackGmailEventForOwner(params.userId, "gmail_sync_result", {
        action: "queue",
        result: "error",
      });
      throw new Error(
        await extractError(response, "Failed to queue Mail receipt sync."),
      );
    }

    const payload = (await response.json()) as GmailSyncQueueResponse;
    trackGmailEventForOwner(params.userId, "gmail_sync_result", {
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
      },
    );

    if (!response.ok) {
      throw new Error(
        await extractError(response, "Failed to load Mail sync run status."),
      );
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
      },
    );

    if (!response.ok) {
      trackGmailEventForOwner(params.userId, "gmail_receipts_loaded", {
        result: "error",
      });
      throw new Error(
        await extractError(response, "Failed to load synced Mail receipts."),
      );
    }

    trackGmailEventForOwner(params.userId, "gmail_receipts_loaded", {
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
      },
    );

    if (!response.ok) {
      throw new Error(
        await extractError(response, "Failed to load Mail nudges."),
      );
    }

    return (await response.json()) as GmailNudgesResponse;
  }
}
