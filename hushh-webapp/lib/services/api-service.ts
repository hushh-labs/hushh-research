/**
 * API Service - Platform-Aware API Routing
 *
 * Production-grade service that handles API calls across platforms:
 * - iOS: Routes to Cloud Run backend (static export has no API routes)
 * - Web: Routes to local Next.js API routes
 *
 * MIGRATION GUIDE:
 * ================
 * When adding new API routes to the Next.js app, follow this checklist:
 *
 * 1. Add the route to Next.js as usual (app/api/...)
 * 2. Add a corresponding method to this service
 * 3. If the route has complex logic, consider adding to native Swift plugin
 * 4. Test on both web AND iOS simulator
 *
 * For routes that need to work offline on iOS, use Capacitor plugins:
 * - VaultService → HushhVault plugin
 * - ConsentService → HushhConsent plugin
 * - AuthService → HushhAuth plugin
 */

import { Capacitor, CapacitorHttp } from "@capacitor/core";
import { HushhVault, HushhAuth, HushhConsent, HushhNotifications } from "@/lib/capacitor";
import { Kai, PORTFOLIO_STREAM_EVENT, KAI_STREAM_EVENT } from "@/lib/capacitor/kai";
import type { PortfolioSharePayload } from "@/lib/portfolio-share/contract";
import { isKaiStreamEnvelope, type KaiStreamEnvelope } from "@/lib/streaming/kai-stream-types";
import { AuthService } from "@/lib/services/auth-service";
import type { AppRuntimeState, VoiceCapabilityResponse } from "@/lib/voice/voice-types";
import {
  toDurationBucket,
  trackApiRequestCompleted,
  trackEvent,
} from "@/lib/observability/client";
import {
  getOrCreateRequestId,
  REQUEST_ID_HEADER,
} from "@/lib/observability/request-id";
import { resolveRouteId } from "@/lib/observability/route-map";

const AUTH_REFRESH_RETRY_HEADER = "X-Hushh-Auth-Refresh-Retry";
const AUTH_SESSION_INVALIDATED_EVENT = "auth-session-invalidated";
const VAULT_LOCK_REQUESTED_EVENT = "vault-lock-requested";

type VaultOwnerAuthFailure = {
  shouldLockVault: boolean;
  reason: string | null;
};

const getEnvBackendUrl = (): string => {
  return (process.env.NEXT_PUBLIC_BACKEND_URL || "").trim().replace(/\/$/, "");
};

const LOCAL_NATIVE_HOSTS = new Set(["localhost", "127.0.0.1", "10.0.2.2"]);

function hostFromUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    return new URL(raw).hostname.trim().toLowerCase();
  } catch {
    return null;
  }
}

function isLocalNativeHost(host: string | null): boolean {
  return Boolean(host && LOCAL_NATIVE_HOSTS.has(host));
}

function normalizeNativeBackendUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/$/, "");
  if (Capacitor.getPlatform() !== "android") {
    return trimmed;
  }
  const backendHost = hostFromUrl(trimmed);
  if (backendHost === "localhost") {
    return trimmed.replace("localhost", "10.0.2.2");
  }
  if (backendHost === "127.0.0.1") {
    return trimmed.replace("127.0.0.1", "10.0.2.2");
  }
  return trimmed;
}

function detectHostedToLocalMismatch(apiBase: string): string | null {
  const backendHost = hostFromUrl(apiBase);
  if (!isLocalNativeHost(backendHost)) return null;

  if (typeof window === "undefined") return null;
  const origin = window.location.origin;
  const nativeServerOrigin =
    typeof origin === "string" && /^https?:\/\//i.test(origin)
      ? origin.replace(/\/$/, "")
      : null;
  const serverHost = hostFromUrl(nativeServerOrigin);
  const hostedServer = Boolean(serverHost && !isLocalNativeHost(serverHost));
  if (!hostedServer) return null;

  return `Hosted WebView origin (${nativeServerOrigin}) cannot use local backend (${apiBase}). Set NEXT_PUBLIC_BACKEND_URL to hosted backend before native build.`;
}

// API Base URL configuration
const getApiBaseUrl = (): string => {
  if (Capacitor.isNativePlatform()) {
    // Native must target backend directly via env-configured URL.
    // Never fall back to frontend/webview origin for API resolution.
    const explicit = getEnvBackendUrl();
    if (explicit) {
      return normalizeNativeBackendUrl(explicit);
    }
    return "";
  }

  // Web: Use relative paths (local Next.js server)
  return "";
};

// Direct Backend URL for streaming (bypasses Next.js proxy)
export const getDirectBackendUrl = (): string => {
  if (Capacitor.isNativePlatform()) {
    return getApiBaseUrl(); // Native already points to backend
  }

  return getEnvBackendUrl();
};

type VoiceTransportMode = {
  mode: "nextjs_proxy" | "direct_backend";
  reason:
    | "native_platform"
    | "missing_backend_url"
    | "explicit_proxy"
    | "explicit_direct"
    | "dev_local_default_direct"
    | "local_backend_default_direct"
    | "same_origin_default_direct"
    | "backend_url_default_direct"
    | "proxy_default";
  backendUrl?: string;
};

function getVoiceTransportMode(): VoiceTransportMode {
  if (Capacitor.isNativePlatform()) {
    return { mode: "nextjs_proxy", reason: "native_platform" };
  }
  const backend = getEnvBackendUrl();
  if (!backend) {
    return { mode: "nextjs_proxy", reason: "missing_backend_url" };
  }
  const explicitProxy =
    String(process.env.NEXT_PUBLIC_VOICE_FORCE_PROXY || "").toLowerCase() === "true";
  if (explicitProxy) {
    return { mode: "nextjs_proxy", reason: "explicit_proxy", backendUrl: backend };
  }
  const explicitDirect =
    String(process.env.NEXT_PUBLIC_VOICE_DIRECT_BACKEND || "").toLowerCase() === "true";
  if (explicitDirect) {
    return { mode: "direct_backend", reason: "explicit_direct", backendUrl: backend };
  }
  const backendHost = hostFromUrl(backend);
  const isDev = process.env.NODE_ENV !== "production";
  if (isLocalNativeHost(backendHost)) {
    return {
      mode: "direct_backend",
      reason: isDev ? "dev_local_default_direct" : "local_backend_default_direct",
      backendUrl: backend,
    };
  }
  if (typeof window !== "undefined") {
    const originHost = hostFromUrl(window.location.origin);
    if (backendHost && originHost && backendHost === originHost) {
      return { mode: "direct_backend", reason: "same_origin_default_direct", backendUrl: backend };
    }
  }
  if (backendHost) {
    return { mode: "direct_backend", reason: "backend_url_default_direct", backendUrl: backend };
  }
  return { mode: "nextjs_proxy", reason: "proxy_default", backendUrl: backend };
}

function isTruthyEnvFlag(raw: string | undefined): boolean {
  return ["1", "true", "yes", "on", "enabled"].includes(String(raw || "").trim().toLowerCase());
}

function isVoiceFailFastEnabled(): boolean {
  const disableFallbacks =
    isTruthyEnvFlag(process.env.NEXT_PUBLIC_DISABLE_VOICE_FALLBACKS) ||
    isTruthyEnvFlag(process.env.DISABLE_VOICE_FALLBACKS);
  const failFast =
    isTruthyEnvFlag(process.env.NEXT_PUBLIC_FAIL_FAST_VOICE) ||
    isTruthyEnvFlag(process.env.FAIL_FAST_VOICE);
  const forceRealtime =
    isTruthyEnvFlag(process.env.NEXT_PUBLIC_FORCE_REALTIME_VOICE) ||
    isTruthyEnvFlag(process.env.FORCE_REALTIME_VOICE);
  return disableFallbacks || failFast || forceRealtime;
}

function isVoiceDirectBackendRequired(): boolean {
  if (Capacitor.isNativePlatform()) return false;
  const explicitDirect = isTruthyEnvFlag(process.env.NEXT_PUBLIC_VOICE_DIRECT_BACKEND);
  return explicitDirect || isVoiceFailFastEnabled();
}

function normalizeVoiceAudioMimeType(rawMimeType: string | null | undefined): string {
  const normalized = String(rawMimeType || "").trim().toLowerCase();
  const base = (normalized.split(";", 1)[0] || "").trim();
  if (base === "video/webm") return "audio/webm";
  if (base === "audio/webm") return "audio/webm";
  if (base === "audio/wav" || base === "audio/x-wav") return "audio/wav";
  if (base === "audio/mp4" || base === "audio/m4a" || base === "audio/x-m4a") return "audio/mp4";
  if (base === "audio/mpeg" || base === "audio/mp3" || base === "audio/mpga") return "audio/mpeg";
  return "audio/webm";
}

function extFromVoiceAudioMimeType(mimeType: string): string {
  if (mimeType.includes("webm")) return "webm";
  if (mimeType.includes("wav")) return "wav";
  if (mimeType.includes("m4a") || mimeType.includes("mp4")) return "m4a";
  if (mimeType.includes("mpeg") || mimeType.includes("mp3")) return "mp3";
  return "webm";
}

function prepareVoiceAudioUpload(data: {
  audioBlob: Blob;
  mimeType?: string;
  filename?: string;
}): {
  audioFile: File;
  mimeType: string;
  filename: string;
  rawMimeType: string;
  blobBytes: number;
} {
  const rawMimeType = String(data.audioBlob.type || "").trim();
  const mimeType = normalizeVoiceAudioMimeType(data.mimeType || rawMimeType || "audio/webm");
  const ext = extFromVoiceAudioMimeType(mimeType);
  const filename = (data.filename || "").trim() || `kai-voice.${ext}`;
  const audioFile = new File([data.audioBlob], filename, { type: mimeType });
  return { audioFile, mimeType, filename, rawMimeType, blobBytes: audioFile.size };
}

function toResultFromStatus(status: number): "success" | "expected_error" | "error" {
  if (status >= 200 && status < 400) return "success";
  if (status >= 400 && status < 500) return "expected_error";
  return "error";
}

function toStatusBucketFromStatus(
  status: number
): "2xx" | "3xx" | "4xx_expected" | "4xx_unexpected" | "5xx" | "network_error" {
  if (status >= 200 && status < 300) return "2xx";
  if (status >= 300 && status < 400) return "3xx";
  if (status >= 400 && status < 500) return "4xx_unexpected";
  if (status >= 500) return "5xx";
  return "network_error";
}

async function classifyVaultOwnerAuthFailure(
  response: Response
): Promise<VaultOwnerAuthFailure> {
  try {
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      const payload = (await response.json().catch(() => null)) as
        | { error?: unknown; detail?: unknown; details?: unknown }
        | null;
      const reasonCandidates = [
        typeof payload?.error === "string" ? payload.error : null,
        typeof payload?.detail === "string" ? payload.detail : null,
        typeof payload?.details === "string" ? payload.details : null,
      ].filter(Boolean) as string[];
      const reason = reasonCandidates[0] ?? null;
      const normalized = (reason || "").toLowerCase();
      return {
        shouldLockVault:
          normalized.includes("token has been revoked") ||
          normalized.includes("invalid token"),
        reason,
      };
    }

    const raw = await response.text().catch(() => "");
    const normalized = raw.toLowerCase();
    return {
      shouldLockVault:
        normalized.includes("token has been revoked") ||
        normalized.includes("invalid token"),
      reason: raw || null,
    };
  } catch {
    return { shouldLockVault: false, reason: null };
  }
}

/**
 * Platform-aware fetch wrapper
 * Automatically adds base URL and common headers
 *
 * Wrapped with API progress tracking so the route progress bar can reflect
 * real network activity across the app.
 */
async function apiFetch(
  path: string,
  options: RequestInit = {}
): Promise<Response> {
  const apiBase = getApiBaseUrl();
  const url = `${apiBase}${path}`;
  const requestStartedAt = Date.now();
  const httpMethod = (options.method || "GET").toUpperCase();
  const routeId =
    typeof window !== "undefined" ? resolveRouteId(window.location.pathname) : undefined;
  const requestId = getOrCreateRequestId(options.headers);

  const mergedHeaders: Record<string, string> = {};
  if (!(options.body instanceof FormData)) {
    mergedHeaders["Content-Type"] = "application/json";
  }

  if (options.headers) {
    if (options.headers instanceof Headers) {
      options.headers.forEach((value, key) => {
        mergedHeaders[key] = value;
      });
    } else if (Array.isArray(options.headers)) {
      for (const [key, value] of options.headers) {
        mergedHeaders[String(key)] = String(value);
      }
    } else {
      for (const [key, value] of Object.entries(options.headers)) {
        if (value === undefined || value === null) continue;
        mergedHeaders[key] = String(value);
      }
    }
  }
  mergedHeaders[REQUEST_ID_HEADER] = requestId;

  const getAuthorizationBearer = () => {
    const authorization =
      mergedHeaders.Authorization ||
      mergedHeaders.authorization ||
      "";
    return authorization.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length).trim()
      : "";
  };

  const shouldAttemptFirebaseAuthRecovery = () => {
    const bearer = getAuthorizationBearer();
    if (!bearer) return false;
    if (bearer.startsWith("HCT:")) return false;
    return mergedHeaders[AUTH_REFRESH_RETRY_HEADER] !== "1";
  };

  const dispatchAuthSessionInvalidated = (reason: string) => {
    if (typeof window === "undefined") return;
    window.dispatchEvent(
      new CustomEvent(AUTH_SESSION_INVALIDATED_EVENT, {
        detail: { reason, path },
      })
    );
  };

  const dispatchVaultLockRequested = (reason: string) => {
    if (typeof window === "undefined") return;
    window.dispatchEvent(
      new CustomEvent(VAULT_LOCK_REQUESTED_EVENT, {
        detail: { reason, path },
      })
    );
  };

  const retryWithFreshFirebaseToken = async (): Promise<Response | null> => {
    if (!shouldAttemptFirebaseAuthRecovery()) {
      return null;
    }

    try {
      const freshToken = await AuthService.getIdToken(true);
      const currentBearer = getAuthorizationBearer();
      if (!freshToken || freshToken === currentBearer) {
        dispatchAuthSessionInvalidated("Firebase session is no longer valid");
        return null;
      }

      const retryHeaders = {
        ...mergedHeaders,
        Authorization: `Bearer ${freshToken}`,
        [AUTH_REFRESH_RETRY_HEADER]: "1",
      };
      return apiFetch(path, {
        ...options,
        headers: retryHeaders,
      });
    } catch (error) {
      console.warn("[ApiService] Firebase auth refresh failed:", error);
      dispatchAuthSessionInvalidated("Firebase session refresh failed");
      return null;
    }
  };

  const recordApiRequestMetric = (statusCode: number | null) => {
    trackApiRequestCompleted({
      path,
      httpMethod,
      statusCode,
      durationMs: Math.max(0, Date.now() - requestStartedAt),
      routeId,
    });
  };

  // Dynamically import tracker to avoid creating a hard dependency for environments
  // that don't care about progress (e.g., certain server-side usage).
  let trackStart: (() => void) | undefined;
  let trackEnd: (() => void) | undefined;
  try {
    const tracker = await import("../motion/api-progress-tracker");
    trackStart = tracker.trackRequestStart;
    trackEnd = tracker.trackRequestEnd;
  } catch {
    // If tracker cannot be loaded, we silently ignore and continue.
  }

  trackStart?.();
  try {
    if (Capacitor.isNativePlatform()) {
      if (!apiBase) {
        throw new Error(
          `Native API base URL is missing for route ${path}. Configure NEXT_PUBLIC_BACKEND_URL for native builds.`
        );
      }
      const mismatchMessage = detectHostedToLocalMismatch(apiBase);
      if (mismatchMessage) {
        throw new Error(mismatchMessage);
      }
      if (options.signal?.aborted) {
        throw new Error("Request aborted");
      }

      const method = (options.method || "GET").toUpperCase();
      const request: {
        url: string;
        method: string;
        headers?: Record<string, string>;
        data?: unknown;
      } = {
        url,
        method,
        headers: mergedHeaders,
      };

        if (options.body !== undefined && options.body !== null && method !== "GET") {
        if (options.body instanceof FormData) {
          // Multipart uploads route through native plugins; keep fetch fallback for safety.
          const formResponse = await fetch(url, {
            ...options,
            credentials: "include",
            headers: mergedHeaders,
          });
          recordApiRequestMetric(formResponse.status);
          return formResponse;
        }
        if (typeof options.body === "string") {
          const contentType =
            mergedHeaders["Content-Type"] ||
            mergedHeaders["content-type"] ||
            "";
          if (contentType.includes("application/json")) {
            try {
              request.data = JSON.parse(options.body);
            } catch {
              request.data = options.body;
            }
          } else {
            request.data = options.body;
          }
        } else if (options.body instanceof URLSearchParams) {
          request.data = options.body.toString();
        } else {
          request.data = options.body as unknown;
        }
      }

      const toResponse = (nativeResponse: Awaited<ReturnType<typeof CapacitorHttp.request>>) => {
        const responseHeaders = new Headers();
        Object.entries(nativeResponse.headers || {}).forEach(([key, value]) => {
          if (Array.isArray(value)) {
            responseHeaders.set(key, value.join(","));
          } else if (value !== undefined && value !== null) {
            responseHeaders.set(key, String(value));
          }
        });
        const responseBody =
          typeof nativeResponse.data === "string"
            ? nativeResponse.data
            : JSON.stringify(nativeResponse.data ?? null);
        return new Response(responseBody, {
          status: nativeResponse.status,
          headers: responseHeaders,
        });
      };

      const nativeResponse = await CapacitorHttp.request(request);
      const response = toResponse(nativeResponse);
      recordApiRequestMetric(response.status);
      return response;
    }

    const response = await fetch(url, {
      ...options,
      credentials: "include",
      headers: mergedHeaders,
    });
    if ((response.status === 401 || response.status === 403) && getAuthorizationBearer().startsWith("HCT:")) {
      const failure = await classifyVaultOwnerAuthFailure(response.clone());
      if (failure.shouldLockVault) {
        dispatchVaultLockRequested(
          failure.reason || "Vault access token is no longer valid"
        );
      }
    }
    if (response.status === 401) {
      const retryResponse = await retryWithFreshFirebaseToken();
      if (retryResponse) {
        return retryResponse;
      }
    }
    recordApiRequestMetric(response.status);
    return response;
  } catch (error) {
    recordApiRequestMetric(null);
    throw error;
  } finally {
    trackEnd?.();
  }
}

type VoiceTransportTimingState = {
  turnStartMs: number;
  lastStageMs: number;
};

const voiceTransportTimingByTurn = new Map<string, VoiceTransportTimingState>();

function emitVoiceTransportStage(
  turnId: string | undefined,
  stage: string,
  metadata: Record<string, unknown> = {},
  options?: { finalize?: boolean }
): void {
  if (!turnId) return;
  const nowMs = performance.now();
  const existing = voiceTransportTimingByTurn.get(turnId);
  if (!existing) {
    voiceTransportTimingByTurn.set(turnId, {
      turnStartMs: nowMs,
      lastStageMs: nowMs,
    });
  }
  const current = voiceTransportTimingByTurn.get(turnId)!;
  const sincePrevMs = existing ? Math.max(0, Math.round(nowMs - existing.lastStageMs)) : 0;
  const sinceTurnStartMs = Math.max(0, Math.round(nowMs - current.turnStartMs));
  voiceTransportTimingByTurn.set(turnId, {
    turnStartMs: current.turnStartMs,
    lastStageMs: nowMs,
  });

  console.info("[KAI_VOICE_TRACE_TRANSPORT]", {
    turn_id: turnId,
    timestamp: new Date().toISOString(),
    stage,
    since_prev_ms: sincePrevMs,
    since_turn_start_ms: sinceTurnStartMs,
    ...metadata,
  });

  if (options?.finalize) {
    voiceTransportTimingByTurn.delete(turnId);
  }
}

async function voiceFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const transport = getVoiceTransportMode();
  const directRequired = isVoiceDirectBackendRequired();
  const requestStartedAt = Date.now();
  const httpMethod = (options.method || "GET").toUpperCase();
  const routeId =
    typeof window !== "undefined" ? resolveRouteId(window.location.pathname) : undefined;
  const turnIdHeaderRaw =
    options.headers instanceof Headers
      ? options.headers.get("X-Voice-Turn-Id") || options.headers.get("x-voice-turn-id")
      : Array.isArray(options.headers)
        ? options.headers.find(([key]) => String(key).toLowerCase() === "x-voice-turn-id")?.[1]
        : options.headers && typeof options.headers === "object"
          ? (options.headers as Record<string, string>)["X-Voice-Turn-Id"] ||
            (options.headers as Record<string, string>)["x-voice-turn-id"]
          : undefined;
  const turnIdHeader = turnIdHeaderRaw || undefined;
  if (directRequired && transport.mode !== "direct_backend") {
    const reason = `VOICE_DIRECT_BACKEND_REQUIRED:${transport.reason}`;
    emitVoiceTransportStage(turnIdHeader, "transport_config_invalid", {
      route: path,
      mode: transport.mode,
      reason: transport.reason,
      direct_required: true,
      error: reason,
    }, { finalize: true });
    throw new Error(reason);
  }
  if (transport.mode !== "direct_backend") {
    emitVoiceTransportStage(turnIdHeader, "transport_request_started", {
      route: path,
      mode: "nextjs_proxy",
      reason: transport.reason,
      direct_required: directRequired,
    });
    console.info(
      `[VOICE_NET] transport=nextjs_proxy route=${path} reason=${transport.reason} turn_id=${turnIdHeader || "unknown"}`
    );
    try {
      const response = await apiFetch(path, options);
      emitVoiceTransportStage(
        turnIdHeader,
        "transport_response_received",
        {
          route: path,
          mode: "nextjs_proxy",
          status: response.status,
        },
        { finalize: true }
      );
      return response;
    } catch (error) {
      emitVoiceTransportStage(
        turnIdHeader,
        "transport_response_received",
        {
          route: path,
          mode: "nextjs_proxy",
          status: 0,
          error: error instanceof Error ? error.message : String(error),
        },
        { finalize: true }
      );
      throw error;
    }
  }

  const backend = transport.backendUrl || getEnvBackendUrl();
  const url = `${backend}${path}`;
  const requestId = getOrCreateRequestId(options.headers);
  const mergedHeaders: Record<string, string> = {};
  if (!(options.body instanceof FormData)) {
    mergedHeaders["Content-Type"] = "application/json";
  }

  if (options.headers) {
    if (options.headers instanceof Headers) {
      options.headers.forEach((value, key) => {
        mergedHeaders[key] = value;
      });
    } else if (Array.isArray(options.headers)) {
      for (const [key, value] of options.headers) {
        mergedHeaders[String(key)] = String(value);
      }
    } else {
      for (const [key, value] of Object.entries(options.headers)) {
        if (value === undefined || value === null) continue;
        mergedHeaders[key] = String(value);
      }
    }
  }
  mergedHeaders[REQUEST_ID_HEADER] = requestId;

  const recordVoiceRequestMetric = (statusCode: number | null) => {
    trackApiRequestCompleted({
      path,
      httpMethod,
      statusCode,
      durationMs: Math.max(0, Date.now() - requestStartedAt),
      routeId,
    });
  };

  console.info(
    `[VOICE_NET] transport=direct_backend route=${path} reason=${transport.reason} url=${url} turn_id=${turnIdHeader || "unknown"}`
  );
  emitVoiceTransportStage(turnIdHeader, "transport_request_started", {
    route: path,
    mode: "direct_backend",
    reason: transport.reason,
    target_url: url,
  });
  try {
    const response = await fetch(url, {
      ...options,
      headers: mergedHeaders,
    });
    recordVoiceRequestMetric(response.status);
    emitVoiceTransportStage(
      turnIdHeader,
      "transport_response_received",
      {
        route: path,
        mode: "direct_backend",
        status: response.status,
      },
      { finalize: true }
    );
    return response;
  } catch (error) {
    recordVoiceRequestMetric(null);
    emitVoiceTransportStage(
      turnIdHeader,
      "transport_response_received",
      {
        route: path,
        mode: "direct_backend",
        status: 0,
        reason: "direct_fetch_failed",
        direct_required: directRequired,
        fail_fast_voice: isVoiceFailFastEnabled(),
        error: error instanceof Error ? error.message : String(error),
      },
      { finalize: true }
    );
    throw error;
  }
}

export interface KaiHomeSparkPoint {
  t: number;
  p: number;
}

export interface KaiHomeHero {
  total_value: number | null;
  day_change_value: number | null;
  day_change_pct: number | null;
  sparkline_points: KaiHomeSparkPoint[];
  as_of: string | null;
  source_tags: string[];
  degraded: boolean;
  holdings_count?: number | null;
  portfolio_value_bucket?: string | null;
}

export interface KaiHomeWatchlistItem {
  symbol: string;
  symbol_quality?: string;
  company_name: string;
  price: number | null;
  change_pct: number | null;
  volume: number | null;
  market_cap: number | null;
  sector?: string | null;
  recommendation: string;
  recommendation_detail?: string | null;
  source_tags: string[];
  degraded: boolean;
  as_of: string | null;
}

export interface KaiHomeRenaissanceItem {
  symbol: string;
  input_symbol?: string | null;
  quote_symbol?: string | null;
  company_name: string;
  sector?: string | null;
  tier?: string | null;
  tier_rank?: number | null;
  conviction_weight?: number | null;
  recommendation_bias?: string | null;
  investment_thesis?: string | null;
  fcf_billions?: number | null;
  price: number | null;
  change_pct: number | null;
  volume: number | null;
  market_cap: number | null;
  source_tags: string[];
  degraded: boolean;
  alias_repaired?: boolean;
  quote_provider?: string | null;
  quote_status?: string | null;
  filtered_out_reason?: string | null;
  as_of: string | null;
}

export interface KaiHomePickSource {
  id: string;
  label: string;
  kind: "default" | "ria";
  state: "ready" | "pending" | "unavailable";
  is_default: boolean;
  share_status?: string | null;
  share_origin?: string | null;
  share_granted_at?: string | null;
}

export interface KaiStockPreviewQuote {
  price: number | null;
  change_pct: number | null;
  as_of: string | null;
  company_name: string;
  sector?: string | null;
  market_cap?: number | null;
  volume?: number | null;
  source_tags: string[];
  degraded: boolean;
}

export interface KaiStockPreviewListMatch {
  in_list: boolean;
  source_id: string;
  label: string;
  company_name?: string | null;
  sector?: string | null;
  tier?: string | null;
  tier_rank?: number | null;
  conviction_weight?: number | null;
  recommendation_bias?: string | null;
  investment_thesis?: string | null;
  fcf_billions?: number | null;
}

export interface KaiStockPreviewAdvisorSummary {
  source_id: string;
  source_label: string;
  kind: "default" | "ria";
  state: "ready" | "pending" | "unavailable";
  package_note?: string | null;
  top_pick_count: number;
  avoid_count: number;
  screening_section_count: number;
  screening_row_count: number;
  ticker_status: "included" | "excluded" | "screened" | "not_listed" | "pending" | "unavailable";
  avoid_reason?: string | null;
  resolved_with_fallback: boolean;
}

export interface KaiStockPreviewResponse {
  symbol: string;
  active_pick_source: string;
  pick_sources: KaiHomePickSource[];
  quote: KaiStockPreviewQuote;
  list_match: KaiStockPreviewListMatch;
  advisor_summary?: KaiStockPreviewAdvisorSummary | null;
}

export interface KaiHomeMover {
  symbol: string;
  company_name: string;
  price: number | null;
  change_pct: number | null;
  volume: number | null;
  source_tags: string[];
  degraded: boolean;
  as_of: string | null;
}

export interface KaiHomeMovers {
  gainers: KaiHomeMover[];
  losers: KaiHomeMover[];
  active: KaiHomeMover[];
  as_of: string | null;
  source_tags: string[];
  degraded: boolean;
}

export interface KaiHomeSectorItem {
  sector: string;
  change_pct: number | null;
  as_of: string | null;
  source_tags: string[];
  degraded: boolean;
}

export interface KaiHomeNewsItem {
  symbol: string;
  title: string;
  url: string;
  published_at: string;
  source_name: string;
  provider: string;
  sentiment_hint?: string | null;
  degraded: boolean;
}

export interface KaiHomeSignal {
  id: string;
  title: string;
  summary: string;
  confidence: number;
  source_tags: string[];
  supporting_items?: Array<{
    symbol: string;
    company_name?: string;
  }>;
  degraded: boolean;
}

export interface KaiHomeOverviewItem {
  label: string;
  value: string | number | null;
  delta_pct: number | null;
  as_of: string | null;
  source: string;
  degraded: boolean;
}

export interface KaiHomeSpotlightItem {
  symbol: string;
  company_name: string;
  price: number | null;
  change_pct: number | null;
  recommendation: string;
  recommendation_detail?: string | null;
  recommendation_source?: string | null;
  story?: string | null;
  confidence?: number | null;
  headline?: string | null;
  headline_url?: string | null;
  headline_source?: string | null;
  source_tags: string[];
  as_of: string | null;
  degraded: boolean;
}

export interface KaiHomeThemeItem {
  title: string;
  subtitle: string;
  symbol?: string;
  change_pct?: number | null;
  headline?: string | null;
  source_tags: string[];
  degraded: boolean;
}

export interface KaiHomeMeta {
  stale: boolean;
  stale_reason?: string;
  cache_age_seconds: number;
  cache_tier?: "memory" | "postgres" | "live";
  cache_hit?: boolean;
  warm_source?: "startup" | "unlock" | "request";
  market_mode?: "baseline" | "personalized";
  baseline_cache_tier?: "memory" | "postgres" | "live" | null;
  personalized_cache_tier?: "memory" | "postgres" | "live" | null;
  provider_cooldowns?: Record<string, number>;
  provider_status: Record<string, string>;
  symbol_quality?: {
    requested_count: number;
    accepted_count: number;
    filtered_count: number;
  };
  filtered_symbols?: Array<{
    input_symbol: string;
    normalized_symbol: string;
    reason: string;
    trust_tier: string;
  }>;
}

export interface KaiHomeInsightsV2 {
  layout_version?: string;
  user_id?: string;
  generated_at?: string;
  stale?: boolean;
  stale_reason?: string;
  cache_age_seconds?: number;
  provider_status?: Record<string, string>;
  hero?: KaiHomeHero;
  watchlist?: KaiHomeWatchlistItem[];
  pick_sources?: KaiHomePickSource[];
  active_pick_source?: string;
  pick_rows?: KaiHomeRenaissanceItem[];
  renaissance_list?: KaiHomeRenaissanceItem[];
  movers?: KaiHomeMovers;
  sector_rotation?: KaiHomeSectorItem[];
  news_tape?: KaiHomeNewsItem[];
  signals?: KaiHomeSignal[];
  meta?: KaiHomeMeta;
  // Backward-compatible fields still supported during transition.
  market_overview?: KaiHomeOverviewItem[];
  spotlights?: KaiHomeSpotlightItem[];
  themes?: KaiHomeThemeItem[];
}

export interface KaiDashboardProfilePick {
  symbol: string;
  company_name: string;
  sector?: string | null;
  tier?: string | null;
  conviction_weight: number;
  price?: number | null;
  change_percent?: number | null;
  recommendation_bias?: string | null;
  rationale: string;
  source_tags: string[];
  degraded: boolean;
  as_of?: string | null;
}

export interface KaiDashboardProfilePicksResponse {
  user_id: string;
  generated_at: string;
  risk_profile: string;
  picks: KaiDashboardProfilePick[];
  context?: Record<string, unknown>;
}

/**
 * API Service for platform-aware API calls
 */
export class ApiService {
  private static readonly dashboardProfilePicksInflight = new Map<
    string,
    Promise<KaiDashboardProfilePicksResponse>
  >();

  private static dashboardProfilePicksKey(data: {
    userId: string;
    symbols?: string[];
    limit?: number;
  }): string {
    const symbolsKey = Array.isArray(data.symbols) && data.symbols.length > 0
      ? [...data.symbols]
          .map((symbol) => String(symbol || "").trim().toUpperCase())
          .filter(Boolean)
          .sort((a, b) => a.localeCompare(b))
          .join(",")
      : "default";
    const limit = typeof data.limit === "number" && Number.isFinite(data.limit)
      ? data.limit
      : 3;
    return `${data.userId}:${symbolsKey}:${limit}`;
  }

  // ==================== Auth Helpers ====================

  /**
   * Get auth headers for API requests.
   * 
   * SECURITY: Token must be passed explicitly from useVault() hook.
   * Never reads from sessionStorage (XSS protection).
   * 
   * @param vaultOwnerToken - The VAULT_OWNER token (optional, for protected routes)
   * @returns HeadersInit object with Authorization header if token provided
   */
  static getAuthHeaders(vaultOwnerToken?: string): HeadersInit {
    return vaultOwnerToken ? { Authorization: `Bearer ${vaultOwnerToken}` } : {};
  }

  /**
   * Get the vault owner token.
   * 
   * DEPRECATED: Use useVault() hook directly in components.
   * This method exists only for backward compatibility.
   * 
   * @returns null - Token should be passed explicitly from useVault()
   */
  static getVaultOwnerToken(): string | null {
    console.warn("[ApiService] getVaultOwnerToken() is deprecated. Use useVault() hook and pass token explicitly.");
    return null;
  }

  /**
   * Platform-aware fetch wrapper (exposed for other services)
   * Automatically adds base URL and common headers
   */
  static async apiFetch(
    path: string,
    options: RequestInit = {}
  ): Promise<Response> {
    return apiFetch(path, options);
  }

  /**
   * Platform-aware fetch wrapper for Streaming/SSE
   * Returns the raw Response object for stream consumption.
   */
  static async apiFetchStream(
    path: string,
    options: RequestInit = {}
  ): Promise<Response> {
    return apiFetch(path, {
      ...options,
      headers: {
        ...options.headers,
        Accept: "text/event-stream",
      },
    });
  }

  /**
   * Get direct backend URL (bypassing proxy)
   */
  static getDirectBackendUrl(): string {
    return getDirectBackendUrl();
  }

  static getVoiceTransportMode(): VoiceTransportMode {
    return getVoiceTransportMode();
  }

  // ==================== Kai Voice ====================

  static async transcribeKaiVoice(data: {
    userId: string;
    vaultOwnerToken: string;
    audioBlob: Blob;
    mimeType?: string;
    filename?: string;
    voiceTurnId?: string;
  }): Promise<Response> {
    const prepared = prepareVoiceAudioUpload(data);
    const form = new FormData();
    form.append("user_id", data.userId);
    form.append("audio_file", prepared.audioFile, prepared.filename);
    form.append("audio_mime_type", prepared.mimeType);
    console.info(
      "[VOICE_AUDIO_UPLOAD] route=/api/kai/voice/stt turn_id=%s blob_bytes=%s raw_mime=%s normalized_mime=%s filename=%s",
      data.voiceTurnId || "unknown",
      prepared.blobBytes,
      prepared.rawMimeType || "(empty)",
      prepared.mimeType,
      prepared.filename
    );

    return voiceFetch("/api/kai/voice/stt", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${data.vaultOwnerToken}`,
        ...(data.voiceTurnId ? { "X-Voice-Turn-Id": data.voiceTurnId } : {}),
      },
      body: form,
    });
  }

  static async understandKaiVoice(data: {
    userId: string;
    vaultOwnerToken: string;
    audioBlob: Blob;
    context?: Record<string, unknown>;
    appState?: AppRuntimeState;
    mimeType?: string;
    filename?: string;
    voiceTurnId?: string;
    signal?: AbortSignal;
  }): Promise<Response> {
    const prepared = prepareVoiceAudioUpload(data); // Takes less than 1ms 
    const form = new FormData();
    form.append("user_id", data.userId);
    form.append("audio_file", prepared.audioFile, prepared.filename);
    form.append("audio_mime_type", prepared.mimeType);
    form.append("context_json", JSON.stringify(data.context || {}));
    form.append("app_state_json", JSON.stringify(data.appState || {}));
    console.info(
      "[VOICE_AUDIO_UPLOAD] route=/api/kai/voice/understand turn_id=%s blob_bytes=%s raw_mime=%s normalized_mime=%s filename=%s",
      data.voiceTurnId || "unknown",
      prepared.blobBytes,
      prepared.rawMimeType || "(empty)",
      prepared.mimeType,
      prepared.filename
    );

    return voiceFetch("/api/kai/voice/understand", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${data.vaultOwnerToken}`,
        ...(data.voiceTurnId ? { "X-Voice-Turn-Id": data.voiceTurnId } : {}),
      },
      body: form,
      signal: data.signal,
    });
  }

  static async planKaiVoiceIntent(data: {
    userId: string;
    vaultOwnerToken: string;
    transcript: string;
    context?: Record<string, unknown>;
    appState?: AppRuntimeState;
    plannerV2?: {
      turnId: string;
      transcriptFinal: string;
      structuredContext?: unknown;
      memoryShort?: unknown[];
      memoryRetrieved?: unknown[];
    };
    voiceTurnId?: string;
    signal?: AbortSignal;
  }): Promise<Response> {
    return voiceFetch("/api/kai/voice/plan", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${data.vaultOwnerToken}`,
        ...(data.voiceTurnId ? { "X-Voice-Turn-Id": data.voiceTurnId } : {}),
      },
      body: JSON.stringify({
        user_id: data.userId,
        transcript: data.transcript,
        context: data.context || {},
        app_state: data.appState,
        turn_id: data.plannerV2?.turnId,
        transcript_final: data.plannerV2?.transcriptFinal,
        context_structured: data.plannerV2?.structuredContext,
        memory_short: data.plannerV2?.memoryShort || [],
        memory_retrieved: data.plannerV2?.memoryRetrieved || [],
      }),
      signal: data.signal,
    });
  }

  static async synthesizeKaiVoice(data: {
    userId: string;
    vaultOwnerToken: string;
    text: string;
    voice?: string;
    voiceTurnId?: string;
    signal?: AbortSignal;
  }): Promise<Response> {
    return voiceFetch("/api/kai/voice/tts", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${data.vaultOwnerToken}`,
        ...(data.voiceTurnId ? { "X-Voice-Turn-Id": data.voiceTurnId } : {}),
      },
      body: JSON.stringify({
        user_id: data.userId,
        text: data.text,
        voice: data.voice,
      }),
      signal: data.signal,
    });
  }

  static async createKaiRealtimeSession(data: {
    userId: string;
    vaultOwnerToken: string;
    voice?: string;
    voiceTurnId?: string;
    signal?: AbortSignal;
  }): Promise<Response> {
    return voiceFetch("/api/kai/voice/realtime/session", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${data.vaultOwnerToken}`,
        ...(data.voiceTurnId ? { "X-Voice-Turn-Id": data.voiceTurnId } : {}),
      },
      body: JSON.stringify({
        user_id: data.userId,
        voice: data.voice,
      }),
      signal: data.signal,
    });
  }

  static async getKaiVoiceCapability(data: {
    userId: string;
    vaultOwnerToken: string;
    voiceTurnId?: string;
    signal?: AbortSignal;
  }): Promise<Response> {
    return voiceFetch("/api/kai/voice/capability", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${data.vaultOwnerToken}`,
        ...(data.voiceTurnId ? { "X-Voice-Turn-Id": data.voiceTurnId } : {}),
      },
      body: JSON.stringify({
        user_id: data.userId,
      }),
      signal: data.signal,
    });
  }

  static async getKaiVoiceCapabilityJson(data: {
    userId: string;
    vaultOwnerToken: string;
    voiceTurnId?: string;
    signal?: AbortSignal;
  }): Promise<VoiceCapabilityResponse> {
    const response = await ApiService.getKaiVoiceCapability(data);
    const payload = (await response.json().catch(() => ({}))) as Partial<VoiceCapabilityResponse>;
    if (!response.ok) {
      const detail =
        typeof (payload as Record<string, unknown>).detail === "string"
          ? String((payload as Record<string, unknown>).detail)
          : `VOICE_CAPABILITY_HTTP_${response.status}`;
      throw new Error(detail);
    }
    const enabled =
      typeof payload.enabled === "boolean"
        ? payload.enabled
        : typeof payload.realtime_enabled === "boolean"
          ? payload.realtime_enabled
          : payload.voice_enabled === true;
    const reason =
      typeof payload.reason === "string"
        ? payload.reason
        : typeof payload.rollout_reason === "string"
          ? payload.rollout_reason
          : null;
    return {
      ...payload,
      enabled,
      reason,
    };
  }

  // ==================== App Config ====================

  /**
   * Runtime app-review-mode config served from backend env (not frontend build env).
   *
   * Web: hits Next.js proxy route `/api/app-config/review-mode`
   * Native: hits backend directly (API_BASE points at backend)
   */
  static async getAppReviewModeConfig(): Promise<{ enabled: boolean }> {
    try {
      const response = await apiFetch("/api/app-config/review-mode", {
        method: "GET",
        cache: "no-store",
      });

      if (!response.ok) return { enabled: false };

      const data = (await response.json().catch(() => ({}))) as {
        enabled?: unknown;
      };

      return { enabled: data.enabled === true };
    } catch (error) {
      console.warn("[ApiService] getAppReviewModeConfig failed:", error);
      return { enabled: false };
    }
  }

  /**
   * Request a backend-minted Firebase custom token for reviewer login.
   * Only available when app-review mode is enabled server-side.
   */
  static async createAppReviewModeSession(subject: "reviewer" = "reviewer"): Promise<{ token: string }> {
    const response = await apiFetch("/api/app-config/review-mode/session", {
      method: "POST",
      cache: "no-store",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ subject }),
    });

    const payload = (await response.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;

    if (!response.ok) {
      const msg =
        (typeof payload.error === "string" && payload.error) ||
        (typeof payload.detail === "string" && payload.detail) ||
        "Reviewer login unavailable";
      throw new Error(msg);
    }

    const token = payload.token;
    if (typeof token !== "string" || token.length === 0) {
      throw new Error("Invalid reviewer session token");
    }

    return { token };
  }

  // ==================== Auth ====================

  /**
   * Create/update session
   */
  static async createSession(data: {
    userId: string;
    email: string;
    idToken?: string;
    displayName?: string;
    photoUrl?: string;
    emailVerified?: boolean;
    phoneNumber?: string;
  }): Promise<Response> {
    return apiFetch("/api/auth/session", {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  /**
   * Delete session (logout)
   */
  static async deleteSession(): Promise<Response> {
    return apiFetch("/api/auth/session", {
      method: "DELETE",
    });
  }

  // ==================== Consent ====================

  /**
   * Get session token for consent protocol
   */
  static async getSessionToken(data: {
    userId: string;
    scope: string;
    agentId?: string;
  }): Promise<Response> {
    const firebaseIdToken = await this.getFirebaseToken();
    if (!firebaseIdToken) {
      return new Response(
        JSON.stringify({ error: "Missing Firebase ID token" }),
        { status: 401 }
      );
    }
    return apiFetch("/api/consent/session-token", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${firebaseIdToken}`,
      },
      body: JSON.stringify(data),
    });
  }

  /**
   * Logout from consent protocol
   */
  static async consentLogout(data: { token: string }): Promise<Response> {
    return apiFetch("/api/consent/logout", {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  /**
   * Approve pending consent
   * Requires VAULT_OWNER token for authentication.
   */
  static async approvePendingConsent(data: {
    token?: string;
    requestId?: string;
    userId: string;
    vaultOwnerToken: string;
    encryptedData?: string;
    encryptedIv?: string;
    encryptedTag?: string;
    wrappedExportKey?: string;
    wrappedKeyIv?: string;
    wrappedKeyTag?: string;
    senderPublicKey?: string;
    wrappingAlg?: string;
    connectorKeyId?: string;
    sourceContentRevision?: number;
    sourceManifestRevision?: number;
    durationHours?: number;
  }): Promise<Response> {
    const requestId = data.requestId || data.token;
    const vaultOwnerToken = data.vaultOwnerToken;
    trackEvent("consent_action_submitted", {
      action: "approve",
      result: "success",
    });

    if (!vaultOwnerToken) {
      const response = new Response(
        JSON.stringify({ error: "Vault must be unlocked" }),
        { status: 401 }
      );
      trackEvent("consent_action_result", {
        action: "approve",
        result: "error",
        status_bucket: "4xx_unexpected",
      });
      return response;
    }

    if (Capacitor.isNativePlatform()) {
      try {
        const { HushhConsent } = await import("@/lib/capacitor");

        await HushhConsent.approve({
          requestId: requestId!,
          userId: data.userId,
          encryptedData: data.encryptedData,
          encryptedIv: data.encryptedIv,
          encryptedTag: data.encryptedTag,
          wrappedExportKey: data.wrappedExportKey,
          wrappedKeyIv: data.wrappedKeyIv,
          wrappedKeyTag: data.wrappedKeyTag,
          senderPublicKey: data.senderPublicKey,
          wrappingAlg: data.wrappingAlg,
          connectorKeyId: data.connectorKeyId,
          sourceContentRevision: data.sourceContentRevision,
          sourceManifestRevision: data.sourceManifestRevision,
          durationHours: data.durationHours,
          vaultOwnerToken,
        });

        const response = new Response(JSON.stringify({ success: true }), { status: 200 });
        trackEvent("consent_action_result", {
          action: "approve",
          result: "success",
          status_bucket: "2xx",
        });
        return response;
      } catch (e) {
        console.error("[ApiService] Native approvePendingConsent error:", e);
        const response = new Response(JSON.stringify({ error: (e as Error).message }), {
          status: 500,
        });
        trackEvent("consent_action_result", {
          action: "approve",
          result: "error",
          status_bucket: "5xx",
        });
        return response;
      }
    }

    const response = await apiFetch("/api/consent/pending/approve", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${vaultOwnerToken}`,
      },
      body: JSON.stringify({
        userId: data.userId,
        requestId,
        encryptedData: data.encryptedData,
        encryptedIv: data.encryptedIv,
        encryptedTag: data.encryptedTag,
        wrappedExportKey: data.wrappedExportKey,
        wrappedKeyIv: data.wrappedKeyIv,
        wrappedKeyTag: data.wrappedKeyTag,
        senderPublicKey: data.senderPublicKey,
        wrappingAlg: data.wrappingAlg,
        connectorKeyId: data.connectorKeyId,
        sourceContentRevision: data.sourceContentRevision,
        sourceManifestRevision: data.sourceManifestRevision,
        durationHours: data.durationHours,
      }),
    });
    trackEvent("consent_action_result", {
      action: "approve",
      result: toResultFromStatus(response.status),
      status_bucket: toStatusBucketFromStatus(response.status),
    });
    return response;
  }

  /**
   * Deny pending consent
   * Requires VAULT_OWNER token for authentication.
   */
  static async denyPendingConsent(data: {
    token?: string;
    requestId?: string;
    userId: string;
    vaultOwnerToken: string;
  }): Promise<Response> {
    const requestId = data.requestId || data.token;
    const vaultOwnerToken = data.vaultOwnerToken;
    trackEvent("consent_action_submitted", {
      action: "deny",
      result: "success",
    });

    if (!vaultOwnerToken) {
      const response = new Response(
        JSON.stringify({ error: "Vault must be unlocked" }),
        { status: 401 }
      );
      trackEvent("consent_action_result", {
        action: "deny",
        result: "error",
        status_bucket: "4xx_unexpected",
      });
      return response;
    }

    if (Capacitor.isNativePlatform()) {
      try {
        const { HushhConsent } = await import("@/lib/capacitor");

        await HushhConsent.deny({
          requestId: requestId!,
          userId: data.userId,
          vaultOwnerToken,
        });

        const response = new Response(JSON.stringify({ success: true }), { status: 200 });
        trackEvent("consent_action_result", {
          action: "deny",
          result: "success",
          status_bucket: "2xx",
        });
        return response;
      } catch (e) {
        console.error("[ApiService] Native denyPendingConsent error:", e);
        const response = new Response(JSON.stringify({ error: (e as Error).message }), {
          status: 500,
        });
        trackEvent("consent_action_result", {
          action: "deny",
          result: "error",
          status_bucket: "5xx",
        });
        return response;
      }
    }

    const response = await apiFetch("/api/consent/pending/deny", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${vaultOwnerToken}`,
      },
      body: JSON.stringify({ userId: data.userId, requestId }),
    });
    trackEvent("consent_action_result", {
      action: "deny",
      result: toResultFromStatus(response.status),
      status_bucket: toStatusBucketFromStatus(response.status),
    });
    return response;
  }

  /**
   * Revoke consent
   * Route: POST /api/consent/revoke
   */
  static async revokeConsent(data: {
    token: string;
    userId: string;
    scope?: string;
  }): Promise<Response> {
    const vaultOwnerToken = data.token;
    trackEvent("consent_action_submitted", {
      action: "revoke",
      result: "success",
    });
    if (!vaultOwnerToken) {
      const response = new Response(
        JSON.stringify({ error: "Vault must be unlocked" }),
        { status: 401 }
      );
      trackEvent("consent_action_result", {
        action: "revoke",
        result: "error",
        status_bucket: "4xx_unexpected",
      });
      return response;
    }

    // Scope is required by backend. On native we enforce + normalize to prevent
    // silent failures (e.g. sending scope="").
    const rawScope = (data.scope || "").trim();
    if (!rawScope) {
      const response = new Response(
        JSON.stringify({ error: "Missing required parameter: scope" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
      trackEvent("consent_action_result", {
        action: "revoke",
        result: "error",
        status_bucket: "4xx_unexpected",
      });
      return response;
    }

    const normalizedScope =
      rawScope === "VAULT_OWNER" || rawScope === "ConsentScope.VAULT_OWNER"
        ? "vault.owner"
        : rawScope;

    if (Capacitor.isNativePlatform()) {
      try {
        // Use revokeConsent that calls the backend and returns lockVault flag
        const result = await HushhConsent.revokeConsent({
          userId: data.userId,
          scope: normalizedScope,
          vaultOwnerToken,
        });

        // Pass through the lockVault flag from native plugin response
        const response = new Response(
          JSON.stringify({ 
            success: true, 
            lockVault: result.lockVault ?? false 
          }), 
          { status: 200 }
        );
        trackEvent("consent_action_result", {
          action: "revoke",
          result: "success",
          status_bucket: "2xx",
        });
        return response;
      } catch (e) {
        console.error("[ApiService] Native revokeConsent error:", e);
        const response = new Response((e as Error).message || "Failed", { status: 500 });
        trackEvent("consent_action_result", {
          action: "revoke",
          result: "error",
          status_bucket: "5xx",
        });
        return response;
      }
    }

    const response = await apiFetch("/api/consent/revoke", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${vaultOwnerToken}`,
      },
      body: JSON.stringify({ ...data, scope: normalizedScope }),
    });
    trackEvent("consent_action_result", {
      action: "revoke",
      result: toResultFromStatus(response.status),
      status_bucket: toStatusBucketFromStatus(response.status),
    });
    return response;
  }

  /**
   * Get pending consent requests
   * Route: GET /api/consent/pending?userId=xxx
   * Requires VAULT_OWNER token for authentication.
   */
  static async getPendingConsents(
    userId: string,
    vaultOwnerToken: string
  ): Promise<Response> {
    if (!vaultOwnerToken) {
      const response = new Response(
        JSON.stringify({ error: "Vault must be unlocked" }),
        { status: 401 }
      );
      trackEvent("consent_pending_loaded", {
        result: "error",
      });
      return response;
    }

    if (Capacitor.isNativePlatform()) {
      try {
        const { consents } = await HushhConsent.getPending({
          userId,
          vaultOwnerToken,
        });
        const response = new Response(JSON.stringify({ pending: consents || [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
        trackEvent("consent_pending_loaded", {
          result: "success",
        });
        return response;
      } catch (e) {
        console.warn("[ApiService] Native getPendingConsents error:", e);
        const response = new Response(JSON.stringify({ error: (e as Error).message }), {
          status: 500,
        });
        trackEvent("consent_pending_loaded", {
          result: "error",
        });
        return response;
      }
    }
    const response = await apiFetch(
      `/api/consent/pending?userId=${encodeURIComponent(userId)}`,
      {
        headers: {
          Authorization: `Bearer ${vaultOwnerToken}`,
        },
      }
    );
    trackEvent("consent_pending_loaded", {
      result: toResultFromStatus(response.status),
    });
    return response;
  }

  static async markPendingConsentOpened(data: {
    userId: string;
    vaultOwnerToken: string;
    requestId?: string;
    bundleId?: string;
    openedVia?: string;
  }): Promise<Response> {
    if (!data.vaultOwnerToken) {
      return new Response(JSON.stringify({ error: "Vault must be unlocked" }), {
        status: 401,
      });
    }

    return apiFetch("/api/consent/pending/opened", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${data.vaultOwnerToken}`,
      },
      body: JSON.stringify({
        userId: data.userId,
        requestId: data.requestId,
        bundleId: data.bundleId,
        openedVia: data.openedVia,
      }),
    });
  }

  /**
   * Register push notification token (FCM/APNs) for consent notifications.
   * Route: POST /api/notifications/register
   * Requires Firebase ID token in Authorization (Bearer).
   */
  static async registerPushToken(
    userId: string,
    token: string,
    platform: "web" | "ios" | "android",
    idToken: string
  ): Promise<Response> {
    if (Capacitor.isNativePlatform()) {
      try {
        const backendUrl = this.getDirectBackendUrl();
        const result = await HushhNotifications.registerPushToken({
          userId,
          token,
          platform,
          idToken,
          backendUrl,
        });
        return new Response(JSON.stringify(result), {
          status: result.success ? 200 : 500,
          headers: { "Content-Type": "application/json" },
        });
      } catch (e) {
        console.warn("[ApiService] Native registerPushToken error:", e);
        return new Response(
          JSON.stringify({ error: (e as Error).message || "Native error" }),
          { status: 500, headers: { "Content-Type": "application/json" } }
        );
      }
    }
    return apiFetch("/api/notifications/register", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${idToken}`,
      },
      body: JSON.stringify({
        user_id: userId,
        token,
        platform,
      }),
    });
  }

  /**
   * Unregister push notification tokens (logout flow).
   * Route: DELETE /api/notifications/unregister
   */
  static async unregisterPushToken(
    userId: string,
    idToken: string,
    platform?: "web" | "ios" | "android"
  ): Promise<Response> {
    if (Capacitor.isNativePlatform()) {
      try {
        const backendUrl = this.getDirectBackendUrl();
        const result = await HushhNotifications.unregisterPushToken({
          userId,
          idToken,
          ...(platform ? { platform } : {}),
          backendUrl,
        });
        return new Response(JSON.stringify(result), {
          status: result.success ? 200 : 500,
          headers: { "Content-Type": "application/json" },
        });
      } catch (e) {
        console.warn("[ApiService] Native unregisterPushToken error:", e);
        return new Response(
          JSON.stringify({ error: (e as Error).message || "Native error" }),
          { status: 500, headers: { "Content-Type": "application/json" } }
        );
      }
    }
    return apiFetch("/api/notifications/unregister", {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${idToken}`,
      },
      body: JSON.stringify({
        user_id: userId,
        ...(platform ? { platform } : {}),
      }),
    });
  }

  /**
   * Get active consents
   * Route: GET /api/consent/active?userId=xxx
   */
  static async getActiveConsents(
    userId: string,
    vaultOwnerToken: string
  ): Promise<Response> {
    if (!vaultOwnerToken) {
      return new Response(
        JSON.stringify({ error: "Vault must be unlocked" }),
        { status: 401 }
      );
    }

    if (Capacitor.isNativePlatform()) {
      try {
        const { consents } = await HushhConsent.getActive({
          userId,
          vaultOwnerToken,
        });
        return new Response(JSON.stringify({ active: consents || [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      } catch (e) {
        console.warn("[ApiService] Native getActiveConsents error:", e);
        return new Response(JSON.stringify({ error: (e as Error).message }), {
          status: 500,
        });
      }
    }
    
    return apiFetch(`/api/consent/active?userId=${encodeURIComponent(userId)}`, {
      headers: {
        Authorization: `Bearer ${vaultOwnerToken}`,
      },
    });
  }

  /**
   * Get consent history/audit log
   * Route: GET /api/consent/history?userId=xxx&page=1&limit=50
   */
  static async getConsentHistory(
    userId: string,
    vaultOwnerToken: string,
    page: number = 1,
    limit: number = 50
  ): Promise<Response> {
    if (!vaultOwnerToken) {
      return new Response(
        JSON.stringify({ error: "Vault must be unlocked" }),
        { status: 401 }
      );
    }

    if (Capacitor.isNativePlatform()) {
      try {
        const { items } = await HushhConsent.getHistory({
          userId,
          vaultOwnerToken,
          page,
          limit,
        });
        return new Response(JSON.stringify({ items: items || [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      } catch (e) {
        console.warn("[ApiService] Native getConsentHistory error:", e);
        return new Response(JSON.stringify({ error: (e as Error).message }), {
          status: 500,
        });
      }
    }
    return apiFetch(
      `/api/consent/history?userId=${encodeURIComponent(
        userId
      )}&page=${page}&limit=${limit}`,
      {
        headers: {
          Authorization: `Bearer ${vaultOwnerToken}`,
        },
      }
    );
  }

  /**
   * Cancel consent request
   * Route: POST /api/consent/cancel
   */
  static async cancelConsent(data: {
    userId: string;
    requestId: string;
  }): Promise<Response> {
    return apiFetch("/api/consent/cancel", {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  // ==================== Vault ====================
  // Mirrors: /api/vault/* routes

  /**
   * Check if user has a vault
   * Route: GET /api/vault/check?userId=xxx
   * Web callers resolve through bootstrap-state so placeholder rows stay current.
   */
  static async checkVault(userId: string): Promise<Response> {
    return apiFetch(`/api/vault/check?userId=${encodeURIComponent(userId)}`);
  }

  /**
   * Get vault key data
   * Route: GET /api/vault/get?userId=xxx
   */
  static async getVault(userId: string): Promise<Response> {
    return apiFetch(`/api/vault/get?userId=${encodeURIComponent(userId)}`);
  }

  /**
   * Setup vault for new user
   * Route: POST /api/vault/setup
   */
  static async setupVault(data: {
    userId: string;
    authMethod?: string;
    encryptedVaultKey: string;
    salt: string;
    iv: string;
    recoveryEncryptedVaultKey: string;
    recoverySalt: string;
    recoveryIv: string;
  }): Promise<Response> {
    return apiFetch("/api/vault/setup", {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  /**
   * Get vault status (domain counts without encrypted data)
   * Requires VAULT_OWNER token
   *
   * Platform routing:
   * - Native: Direct backend call → /db/vault/status
   * - Web: Next.js proxy → Backend
   *
   * Route: GET /api/vault/status (web) or POST /db/vault/status (native)
   */
  static async getVaultStatus(
    userId: string,
    vaultOwnerToken: string
  ): Promise<Response> {
    if (Capacitor.isNativePlatform()) {
      try {
        // Native: Prefer plugin proxy to avoid fetch/env/cert inconsistencies
        const authToken = await this.getFirebaseToken();
        if (!authToken) {
          return new Response(
            JSON.stringify({ error: "Missing Firebase auth token" }),
            { status: 401 }
          );
        }

        const result = await HushhVault.getVaultStatus({
          userId,
          vaultOwnerToken,
          authToken,
        });

        return new Response(JSON.stringify(result), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      } catch (error) {
        console.error("[ApiService] Native getVaultStatus error:", error);
        return new Response(JSON.stringify({ error: (error as Error).message }), {
          status: 500,
        });
      }
    }

    // Web: Use Next.js proxy
    const firebaseIdToken = await this.getFirebaseToken();
    if (!firebaseIdToken) {
      return new Response(
        JSON.stringify({ error: "Missing Firebase ID token" }),
        { status: 401 }
      );
    }
    return apiFetch("/api/vault/status", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${firebaseIdToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ userId, consentToken: vaultOwnerToken }),
    });
  }

  /**
   * Store preferences to vault (generic)
   * Route: POST /api/vault/store-preferences
   */
  static async storePreferences(data: {
    userId: string;
    domain?: string;
    preferences: Record<string, any>;
    consentToken: string;
  }): Promise<Response> {
    if (Capacitor.isNativePlatform()) {
      try {
        const authToken = await this.getFirebaseToken();
        const promises = [];

        // Iterate through all preference keys and store them individually
        // This maps to the /api/$domain/preferences/store endpoint via the plugin
        for (const [key, value] of Object.entries(data.preferences)) {
          const domain = data.domain || "general";
          promises.push(
            HushhVault.storePreferencesToCloud({
              userId: data.userId,
              domain: domain,
              fieldName: key,
              ciphertext: value.ciphertext,
              iv: value.iv,
              tag: value.tag || "",
              consentToken: data.consentToken,
              authToken: authToken,
            })
          );
        }

        await Promise.all(promises);
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      } catch (e) {
        console.error("❌ [ApiService] Native storePreferences error:", e);
        return new Response(JSON.stringify({ error: (e as Error).message }), {
          status: 500,
        });
      }
    }

    return apiFetch("/api/vault/store-preferences", {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  // ==================== Helpers ====================

  /**
   * Get the configured API base URL
   */
  static getBaseUrl(): string {
    return getApiBaseUrl();
  }

  static isNative(): boolean {
    return Capacitor.isNativePlatform();
  }

  // Helper to get Firebase ID Token for Native calls
  private static async getFirebaseToken(): Promise<string | undefined> {
    if (Capacitor.isNativePlatform()) {
      try {
        const { idToken } = await HushhAuth.getIdToken();
        return idToken || undefined;
      } catch (e) {
        console.warn("[ApiService] Failed to get native ID token:", e);
      }
    } else {
      const token = await AuthService.getIdToken().catch(() => null);
      return token || undefined;
    }
    return undefined;
  }

  // ==================== Kai Agent Methods ====================

  /**
   * Grant Kai Consent
   */
  static async kaiGrantConsent(data: {
    userId: string;
    scopes?: string[];
  }): Promise<Response> {
    // Updated to use dynamic attr.* scopes instead of legacy vault.read.*/vault.write.*
    const scopes = data.scopes || [
      "attr.financial.risk_profile",  // Replaces vault.read.risk_profile
      "agent.kai.analyze",
    ];

    const authToken = await this.getFirebaseToken();
    if (!authToken) {
      return new Response(JSON.stringify({ error: "Missing Firebase ID token" }), {
        status: 401,
      });
    }

    if (Capacitor.isNativePlatform()) {
      try {
        const result = await Kai.grantConsent({
          userId: data.userId,
          scopes,
          authToken,
        });

        return new Response(JSON.stringify(result), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      } catch (error) {
        console.error("[ApiService] Native kaiGrantConsent error:", error);
        return new Response(JSON.stringify({ error: (error as Error).message }), {
          status: 500,
        });
      }
    }

    return apiFetch("/api/kai/consent/grant", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({ user_id: data.userId, scopes }),
    });
  }

  /**
   * Analyze stock ticker
   */
  static async kaiAnalyze(data: {
    userId: string;
    ticker: string;
    consentToken: string;
    riskProfile: string;
    processingMode: string;
  }): Promise<Response> {
    if (Capacitor.isNativePlatform()) {
      try {
        const vaultOwnerToken = this.getVaultOwnerToken() || undefined;
        const result = await Kai.analyze({
          userId: data.userId,
          ticker: data.ticker,
          consentToken: data.consentToken,
          riskProfile: data.riskProfile,
          processingMode: data.processingMode,
          vaultOwnerToken,
        });

        return new Response(JSON.stringify(result.decision), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      } catch (error) {
        console.error("[ApiService] Native kaiAnalyze error:", error);
        return new Response(JSON.stringify({ error: (error as Error).message }), {
          status: 500,
        });
      }
    }

    const vaultOwnerToken = this.getVaultOwnerToken();
    if (!vaultOwnerToken) {
      return new Response(JSON.stringify({ error: "Vault must be unlocked" }), {
        status: 401,
      });
    }

    return apiFetch("/api/kai/analyze", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${vaultOwnerToken}`,
      },
      body: JSON.stringify({
        user_id: data.userId,
        ticker: data.ticker,
        consent_token: data.consentToken,
        risk_profile: data.riskProfile,
        processing_mode: data.processingMode,
      }),
    });
  }

  /**
   * Send message to Kai chat agent
   *
   * This is the primary method for conversational interaction with Kai.
   * Supports persistent chat history and insertable UI components.
   *
   * Authentication: Requires VAULT_OWNER token (consent-first architecture).
   */
  static async sendKaiMessage(data: {
    userId: string;
    message: string;
    conversationId?: string;
    vaultOwnerToken: string;
  }): Promise<Response> {
    if (Capacitor.isNativePlatform()) {
      try {
        const result = await Kai.chat({
          userId: data.userId,
          message: data.message,
          conversationId: data.conversationId,
          vaultOwnerToken: data.vaultOwnerToken,
        });

        return new Response(JSON.stringify(result), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      } catch (error) {
        console.error("[ApiService] Native sendKaiMessage error:", error);
        return new Response(JSON.stringify({ error: (error as Error).message }), {
          status: 500,
        });
      }
    }

    // Web: Use VAULT_OWNER token for consent-gated access
    return apiFetch("/api/kai/chat", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${data.vaultOwnerToken}`,
      },
      body: JSON.stringify({
        user_id: data.userId,
        message: data.message,
        conversation_id: data.conversationId,
      }),
    });
  }

  /**
   * Import portfolio from brokerage statement
   *
   * Accepts CSV or PDF files and returns portfolio analysis with losers.
   * Uses the Kai plugin for tri-flow architecture compliance.
   *
   * Authentication: Requires VAULT_OWNER token (consent-first architecture).
   */
  /**
   * Import portfolio via streaming endpoint (SSE).
   * Tri-flow compliant: use this instead of direct fetch() in components.
   */
  static async importPortfolioStream(params: {
    formData: FormData;
    vaultOwnerToken: string;
    signal?: AbortSignal;
  }): Promise<Response> {
    const headers: HeadersInit = {
      Authorization: `Bearer ${params.vaultOwnerToken}`,
      Accept: "text/event-stream",
    };

    // Native: use Kai plugin for real-time SSE (WKWebView buffers fetch() response body)
    if (Capacitor.isNativePlatform()) {
      try {
        const file = params.formData.get("file") as File;
        const userId = params.formData.get("user_id") as string;
        if (!file || !userId) {
          return new Response(
            JSON.stringify({ error: "Missing file or user_id in formData" }),
            { status: 400 }
          );
        }
        const fileBase64 = await this.fileToBase64(file);
        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            let sawTerminalEvent = false;
            let closed = false;
            let listener: { remove: () => void } | null = null;

            const cleanup = () => {
              if (listener) {
                listener.remove();
                listener = null;
              }
            };
            const close = () => {
              if (closed) return;
              closed = true;
              cleanup();
              controller.close();
            };
            const toSafeStreamError = (error: unknown): Error => {
              const raw =
                error instanceof Error ? String(error.message || "") : String(error || "");
              if (
                /network connection was lost|stream error|failed to fetch|network error/i.test(
                  raw
                )
              ) {
                return new Error(
                  "Connection was interrupted while importing. Reopen import to continue."
                );
              }
              return error instanceof Error ? error : new Error(String(error));
            };
            const fail = (error: unknown) => {
              if (closed) return;
              closed = true;
              cleanup();
              controller.error(toSafeStreamError(error));
            };
            const handleAbort = () => {
              fail(new DOMException("Aborted", "AbortError"));
            };

            try {
              params.signal?.addEventListener("abort", handleAbort, { once: true });
              listener = await Kai.addListener(
                PORTFOLIO_STREAM_EVENT,
                (event: Record<string, unknown>) => {
                  if (closed) return;
                  const eventType =
                    typeof event.event === "string" ? event.event : null;
                  const envelopeCandidate = event.data;
                  if (!eventType || !isKaiStreamEnvelope(envelopeCandidate)) {
                    fail(new Error("Invalid native portfolio stream event"));
                    return;
                  }

                  const envelope = envelopeCandidate as KaiStreamEnvelope;
                  if (envelope.event !== eventType) {
                    fail(new Error("Native SSE event mismatch"));
                    return;
                  }

                  controller.enqueue(
                    encoder.encode(
                      `event: ${eventType}\ndata: ${JSON.stringify(envelope)}\n\n`
                    )
                  );

                  if (envelope.terminal) {
                    sawTerminalEvent = true;
                  }
                }
              );

              await Kai.streamPortfolioImport({
                userId,
                fileBase64,
                fileName: file.name,
                mimeType: file.type || "application/octet-stream",
                vaultOwnerToken: params.vaultOwnerToken,
              });

              if (!sawTerminalEvent) {
                fail(new Error("Native import stream ended without terminal event"));
                return;
              }
              close();
            } catch (error) {
              fail(error);
            } finally {
              params.signal?.removeEventListener("abort", handleAbort);
            }
          },
        });
        return new Response(stream, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      } catch (error) {
        console.error("[ApiService] Native importPortfolioStream error:", error);
        throw error;
      }
    }

    // Web: use Next.js proxy
    return apiFetch("/api/kai/portfolio/import/stream", {
      method: "POST",
      body: params.formData,
      headers,
      signal: params.signal,
    });
  }

  static async startPortfolioImportRun(params: {
    formData: FormData;
    vaultOwnerToken: string;
    signal?: AbortSignal;
  }): Promise<Response> {
    const response = await apiFetch("/api/kai/portfolio/import/run/start", {
      method: "POST",
      body: params.formData,
      headers: {
        Authorization: `Bearer ${params.vaultOwnerToken}`,
      },
      signal: params.signal,
    });
    trackEvent("import_upload_started", {
      result: toResultFromStatus(response.status),
    });
    return response;
  }

  static async getActivePortfolioImportRun(params: {
    userId: string;
    vaultOwnerToken: string;
  }): Promise<Response> {
    const query = new URLSearchParams({ user_id: params.userId });
    return apiFetch(`/api/kai/portfolio/import/run/active?${query.toString()}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${params.vaultOwnerToken}`,
      },
    });
  }

  static async streamPortfolioImportRun(params: {
    runId: string;
    userId: string;
    vaultOwnerToken: string;
    cursor?: number;
    signal?: AbortSignal;
  }): Promise<Response> {
    if (Capacitor.isNativePlatform()) {
      try {
        const vaultOwnerToken = params.vaultOwnerToken;
        if (!vaultOwnerToken) {
          return new Response(
            JSON.stringify({ error: "Vault must be unlocked" }),
            { status: 401 }
          );
        }

        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            let sawTerminalEvent = false;
            let closed = false;
            let listener: { remove: () => void } | null = null;

            const cleanup = () => {
              if (listener) {
                listener.remove();
                listener = null;
              }
            };
            const close = () => {
              if (closed) return;
              closed = true;
              cleanup();
              controller.close();
            };
            const fail = (error: unknown) => {
              if (closed) return;
              closed = true;
              cleanup();
              controller.error(
                error instanceof Error ? error : new Error(String(error))
              );
            };
            const handleAbort = () => {
              fail(new DOMException("Aborted", "AbortError"));
            };

            try {
              params.signal?.addEventListener("abort", handleAbort, { once: true });
              listener = await Kai.addListener(
                PORTFOLIO_STREAM_EVENT,
                (event: Record<string, unknown>) => {
                  if (closed) return;
                  const eventType =
                    typeof event.event === "string" ? event.event : null;
                  const envelopeCandidate = event.data;
                  if (!eventType || !isKaiStreamEnvelope(envelopeCandidate)) {
                    fail(new Error("Invalid native portfolio stream event"));
                    return;
                  }

                  const envelope = envelopeCandidate as KaiStreamEnvelope;
                  if (envelope.event !== eventType) {
                    fail(new Error("Native SSE event mismatch"));
                    return;
                  }

                  controller.enqueue(
                    encoder.encode(
                      `event: ${eventType}\ndata: ${JSON.stringify(envelope)}\n\n`
                    )
                  );

                  if (envelope.terminal) {
                    sawTerminalEvent = true;
                  }
                }
              );

              await Kai.streamPortfolioImportRun({
                runId: params.runId,
                userId: params.userId,
                cursor: Math.max(0, params.cursor ?? 0),
                vaultOwnerToken,
              });

              if (!sawTerminalEvent) {
                fail(new Error("Native import stream ended without terminal event"));
                return;
              }
              close();
            } catch (error) {
              fail(error);
            } finally {
              params.signal?.removeEventListener("abort", handleAbort);
            }
          },
        });

        return new Response(stream, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      } catch (error) {
        console.error("[ApiService] Native streamPortfolioImportRun error:", error);
        return new Response(JSON.stringify({ error: (error as Error).message }), {
          status: 500,
        });
      }
    }

    const query = new URLSearchParams({
      user_id: params.userId,
      cursor: String(Math.max(0, params.cursor ?? 0)),
    });
    return apiFetch(
      `/api/kai/portfolio/import/run/${encodeURIComponent(params.runId)}/stream?${query.toString()}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${params.vaultOwnerToken}`,
          Accept: "text/event-stream",
        },
        signal: params.signal,
      }
    );
  }

  static async cancelPortfolioImportRun(params: {
    runId: string;
    userId: string;
    vaultOwnerToken: string;
  }): Promise<Response> {
    const query = new URLSearchParams({ user_id: params.userId });
    return apiFetch(
      `/api/kai/portfolio/import/run/${encodeURIComponent(params.runId)}/cancel?${query.toString()}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${params.vaultOwnerToken}`,
        },
      }
    );
  }

  static async createPortfolioShareLink(data: {
    payload: PortfolioSharePayload;
  }): Promise<Response> {
    return apiFetch("/api/portfolio/share-link", {
      method: "POST",
      body: JSON.stringify({
        payload: data.payload,
      }),
    });
  }

  static async importPortfolio(data: {
    userId: string;
    file: File;
    vaultOwnerToken: string;
  }): Promise<Response> {
    trackEvent("import_upload_started", {
      result: "success",
    });
    // Use VAULT_OWNER token for consent-gated access
    if (!data.vaultOwnerToken) {
      const response = new Response(
        JSON.stringify({ error: "Vault must be unlocked to import portfolio" }),
        { status: 401 }
      );
      trackEvent("import_quality_gate_failed", {
        result: "error",
      });
      return response;
    }

    try {
      // Convert File to base64 for plugin compatibility
      const fileBase64 = await this.fileToBase64(data.file);

      // Import the Kai plugin
      const { Kai } = await import("@/lib/capacitor/kai");

      // Use Kai plugin for both web and native (tri-flow compliant)
      const result = await Kai.importPortfolio({
        userId: data.userId,
        fileBase64,
        fileName: data.file.name,
        mimeType: data.file.type || "application/octet-stream",
        vaultOwnerToken: data.vaultOwnerToken,
      });

      // Wrap result in Response for backward compatibility
      const response = new Response(JSON.stringify(result), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
      trackEvent("import_parse_completed", {
        result: "success",
      });
      trackEvent("import_quality_gate_passed", {
        result: "success",
      });
      trackEvent("import_save_completed", {
        result: "success",
      });
      return response;
    } catch (error) {
      console.error("[ApiService] importPortfolio error:", error);
      const response = new Response(
        JSON.stringify({
          success: false,
          error: (error as Error).message,
        }),
        { status: 500 }
      );
      trackEvent("import_parse_completed", {
        result: "error",
      });
      trackEvent("import_quality_gate_failed", {
        result: "error",
      });
      trackEvent("import_save_completed", {
        result: "error",
      });
      return response;
    }
  }

  /**
   * Convert a File object to base64 string
   */
  private static async fileToBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result as string;
        // Remove data URL prefix (e.g., "data:application/pdf;base64,")
        const base64 = result.split(",")[1] || "";
        resolve(base64);
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  /**
   * Get portfolio summary from PKM
   */
  static async getPortfolioSummary(data: {
    userId: string;
    vaultOwnerToken: string;
  }): Promise<Response> {
    return apiFetch(`/api/kai/portfolio/summary/${data.userId}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${data.vaultOwnerToken}`,
      },
    });
  }

  /**
   * Fetch baseline market insights for Kai home without requiring vault access.
   */
  static async getKaiMarketBaselineInsights(data: {
    userId: string;
    daysBack?: number;
    signal?: AbortSignal;
  }): Promise<KaiHomeInsightsV2> {
    const startedAt = Date.now();
    const authToken = await this.getFirebaseToken();
    if (!authToken) {
      throw new Error("Missing Firebase ID token for market baseline");
    }

    const query = new URLSearchParams();
    if (typeof data.daysBack === "number" && Number.isFinite(data.daysBack)) {
      query.set("days_back", String(data.daysBack));
    }
    const suffix = query.toString() ? `?${query.toString()}` : "";
    const path = `/api/kai/market/insights/baseline/${data.userId}${suffix}`;

    const response = await apiFetch(path, {
      method: "GET",
      signal: data.signal,
      headers: {
        Authorization: `Bearer ${authToken}`,
      },
    });
    const durationMs = Math.max(0, Date.now() - startedAt);
    trackEvent("market_insights_loaded", {
      result: toResultFromStatus(response.status),
      status_bucket: toStatusBucketFromStatus(response.status),
      duration_ms_bucket: toDurationBucket(durationMs),
    });
    if (!response.ok) {
      throw new Error(`Failed to load baseline market insights: ${response.status}`);
    }
    return (await response.json()) as KaiHomeInsightsV2;
  }

  /**
   * Fetch cached live market insights for Kai home.
   */
  static async getKaiMarketInsights(data: {
    userId: string;
    vaultOwnerToken: string;
    symbols?: string[];
    daysBack?: number;
    pickSource?: string;
    signal?: AbortSignal;
  }): Promise<KaiHomeInsightsV2> {
    const startedAt = Date.now();
    const query = new URLSearchParams();
    if (Array.isArray(data.symbols) && data.symbols.length > 0) {
      query.set("symbols", data.symbols.join(","));
    }
    if (typeof data.daysBack === "number" && Number.isFinite(data.daysBack)) {
      query.set("days_back", String(data.daysBack));
    }
    if (typeof data.pickSource === "string" && data.pickSource.trim()) {
      query.set("pick_source", data.pickSource.trim());
    }
    const suffix = query.toString() ? `?${query.toString()}` : "";
    const path = `/api/kai/market/insights/${data.userId}${suffix}`;

    const response = await apiFetch(path, {
      method: "GET",
      signal: data.signal,
      headers: {
        Authorization: `Bearer ${data.vaultOwnerToken}`,
      },
    });
    const durationMs = Math.max(0, Date.now() - startedAt);
    trackEvent("market_insights_loaded", {
      result: toResultFromStatus(response.status),
      status_bucket: toStatusBucketFromStatus(response.status),
      duration_ms_bucket: toDurationBucket(durationMs),
    });
    if (!response.ok) {
      throw new Error(`Failed to load market insights: ${response.status}`);
    }
    return (await response.json()) as KaiHomeInsightsV2;
  }

  static async getKaiStockPreview(data: {
    userId: string;
    symbol: string;
    vaultOwnerToken: string;
    pickSource?: string;
    signal?: AbortSignal;
  }): Promise<KaiStockPreviewResponse> {
    const query = new URLSearchParams({
      symbol: data.symbol.trim().toUpperCase(),
    });
    if (typeof data.pickSource === "string" && data.pickSource.trim()) {
      query.set("pick_source", data.pickSource.trim());
    }
    const response = await apiFetch(`/api/kai/stock-preview/${data.userId}?${query.toString()}`, {
      method: "GET",
      signal: data.signal,
      headers: {
        Authorization: `Bearer ${data.vaultOwnerToken}`,
      },
    });
    if (!response.ok) {
      throw new Error(`Failed to load stock preview: ${response.status}`);
    }
    return (await response.json()) as KaiStockPreviewResponse;
  }

  /**
   * Fetch profile-based picks for dashboard cards (real-user context only).
   */
  static async getDashboardProfilePicks(data: {
    userId: string;
    vaultOwnerToken: string;
    symbols?: string[];
    limit?: number;
    signal?: AbortSignal;
  }): Promise<KaiDashboardProfilePicksResponse> {
    const startedAt = Date.now();
    const query = new URLSearchParams();
    if (Array.isArray(data.symbols) && data.symbols.length > 0) {
      query.set("symbols", data.symbols.join(","));
    }
    if (typeof data.limit === "number" && Number.isFinite(data.limit)) {
      query.set("limit", String(data.limit));
    }
    const suffix = query.toString() ? `?${query.toString()}` : "";
    const path = `/api/kai/dashboard/profile-picks/${data.userId}${suffix}`;
    const dedupeKey = this.dashboardProfilePicksKey(data);
    const existing = this.dashboardProfilePicksInflight.get(dedupeKey);
    if (existing) {
      return existing;
    }

    if (data.signal?.aborted) {
      throw new Error("Profile picks request aborted");
    }

    const request = (async () => {
      const response = await apiFetch(path, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${data.vaultOwnerToken}`,
        },
      });
      const durationMs = Math.max(0, Date.now() - startedAt);
      trackEvent("profile_picks_loaded", {
        result: toResultFromStatus(response.status),
        status_bucket: toStatusBucketFromStatus(response.status),
        duration_ms_bucket: toDurationBucket(durationMs),
      });
      if (!response.ok) {
        throw new Error(`Failed to load profile picks: ${response.status}`);
      }
      return (await response.json()) as KaiDashboardProfilePicksResponse;
    })();

    this.dashboardProfilePicksInflight.set(dedupeKey, request);
    try {
      return await request;
    } finally {
      if (this.dashboardProfilePicksInflight.get(dedupeKey) === request) {
        this.dashboardProfilePicksInflight.delete(dedupeKey);
      }
    }
  }

  /**
   * Analyze a portfolio loser
   */
  static async analyzeLoser(data: {
    userId: string;
    symbol: string;
    conversationId?: string;
    vaultOwnerToken: string;
  }): Promise<Response> {
    const body = {
      user_id: data.userId,
      symbol: data.symbol,
      conversation_id: data.conversationId,
    };

    return apiFetch("/api/kai/chat/analyze-loser", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${data.vaultOwnerToken}`,
      },
      body: JSON.stringify(body),
    });
  }

  /**
   * Analyze portfolio losers (criteria-first) using Renaissance rubric.
   *
   * IMPORTANT: Backend does not persist full holdings (BYOK). Caller must provide
   * loser positions computed client-side from the imported portfolio data.
   */
  static async analyzePortfolioLosers(data: {
    userId: string;
    losers: Array<{
      symbol: string;
      name?: string;
      gain_loss_pct?: number;
      gain_loss?: number;
      market_value?: number;
    }>;
    thresholdPct?: number;
    maxPositions?: number;
    vaultOwnerToken: string;
    holdings?: Array<{
      symbol: string;
      name?: string;
      gain_loss_pct?: number;
      gain_loss?: number;
      market_value?: number;
      sector?: string;
      asset_type?: string;
    }>;
    forceOptimize?: boolean;
    userPreferences?: Record<string, unknown>;
  }): Promise<Response> {
    const body = {
      user_id: data.userId,
      losers: data.losers,
      threshold_pct: data.thresholdPct ?? -5.0,
      max_positions: data.maxPositions ?? 10,
      holdings: data.holdings,
      force_optimize: data.forceOptimize,
      user_preferences: data.userPreferences,
    };

    if (Capacitor.isNativePlatform()) {
      try {
        const result = await Kai.analyzePortfolioLosers({
          userId: data.userId,
          losers: data.losers,
          thresholdPct: body.threshold_pct,
          maxPositions: body.max_positions,
          vaultOwnerToken: data.vaultOwnerToken,
        });
        return new Response(JSON.stringify(result), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      } catch (error) {
        console.error("[ApiService] Native analyzePortfolioLosers error:", error);
        return new Response(JSON.stringify({ error: (error as Error).message }), {
          status: 500,
        });
      }
    }

    return apiFetch("/api/kai/portfolio/analyze-losers", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${data.vaultOwnerToken}`,
      },
      body: JSON.stringify(body),
    });
  }

  /**
   * Streaming version of portfolio losers analysis with AI reasoning.
   * 
   * Returns a Response with SSE stream that emits:
   * - 'stage' events: Current processing stage
   * - 'thinking' events: AI reasoning/thought summaries
   * - 'chunk' events: Partial response text
   * - 'complete' events: Final parsed JSON result
   * - 'error' events: Error messages
   * 
   * @example
   * const response = await ApiService.analyzePortfolioLosersStream({...});
   * const reader = response.body?.getReader();
   * const decoder = new TextDecoder();
   * while (true) {
   *   const { done, value } = await reader.read();
   *   if (done) break;
   *   const text = decoder.decode(value);
   *   // Parse SSE events from text
   * }
   */
  static async analyzePortfolioLosersStream(data: {
    userId: string;
    losers: Array<{
      symbol: string;
      name?: string;
      gain_loss_pct?: number;
      gain_loss?: number;
      market_value?: number;
    }>;
    thresholdPct?: number;
    maxPositions?: number;
    vaultOwnerToken: string;
    holdings?: Array<{
      symbol: string;
      name?: string;
      gain_loss_pct?: number;
      gain_loss?: number;
      market_value?: number;
      sector?: string;
      asset_type?: string;
    }>;
    forceOptimize?: boolean;
    userPreferences?: Record<string, unknown>;
    signal?: AbortSignal;
  }): Promise<Response> {
    const body = {
      user_id: data.userId,
      losers: data.losers,
      threshold_pct: data.thresholdPct ?? -5.0,
      max_positions: data.maxPositions ?? 10,
      holdings: data.holdings,
      force_optimize: data.forceOptimize,
      user_preferences: data.userPreferences,
    };

    // Native: use Kai plugin for real-time SSE (WKWebView buffers fetch() response body)
    if (Capacitor.isNativePlatform()) {
      try {
        const vaultOwnerToken = data.vaultOwnerToken;
        if (!vaultOwnerToken) {
          return new Response(
            JSON.stringify({ error: "Vault must be unlocked" }),
            { status: 401 }
          );
        }

        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            let sawTerminalEvent = false;
            let closed = false;
            let listener: { remove: () => void } | null = null;

            const cleanup = () => {
              if (listener) {
                listener.remove();
                listener = null;
              }
            };
            const close = () => {
              if (closed) return;
              closed = true;
              cleanup();
              controller.close();
            };
            const fail = (error: unknown) => {
              if (closed) return;
              closed = true;
              cleanup();
              controller.error(
                error instanceof Error ? error : new Error(String(error))
              );
            };
            const handleAbort = () => {
              fail(new DOMException("Aborted", "AbortError"));
            };

            try {
              data.signal?.addEventListener("abort", handleAbort, { once: true });
              listener = await Kai.addListener(
                PORTFOLIO_STREAM_EVENT,
                (event: Record<string, unknown>) => {
                  if (closed) return;
                  const eventType =
                    typeof event.event === "string" ? event.event : null;
                  const envelopeCandidate = event.data;
                  if (!eventType || !isKaiStreamEnvelope(envelopeCandidate)) {
                    fail(new Error("Invalid native optimize stream event"));
                    return;
                  }

                  const envelope = envelopeCandidate as KaiStreamEnvelope;
                  if (envelope.event !== eventType) {
                    fail(new Error("Native SSE event mismatch"));
                    return;
                  }

                  controller.enqueue(
                    encoder.encode(
                      `event: ${eventType}\ndata: ${JSON.stringify(envelope)}\n\n`
                    )
                  );

                  if (envelope.terminal) {
                    sawTerminalEvent = true;
                  }
                }
              );

              await Kai.streamPortfolioAnalyzeLosers({
                body: body as Record<string, unknown>,
                vaultOwnerToken,
              });

              if (!sawTerminalEvent) {
                fail(new Error("Native optimize stream ended without terminal event"));
                return;
              }
              close();
            } catch (error) {
              fail(error);
            } finally {
              data.signal?.removeEventListener("abort", handleAbort);
            }
          },
        });
        return new Response(stream, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      } catch (error) {
        console.error("[ApiService] Native analyzePortfolioLosersStream error:", error);
        return new Response(JSON.stringify({ error: (error as Error).message }), {
          status: 500,
        });
      }
    }

    // For web, use the Next.js proxy
    return apiFetch("/api/kai/portfolio/analyze-losers/stream", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${data.vaultOwnerToken}`,
      },
      body: JSON.stringify(body),
      signal: data.signal,
    });
  }

  /**
   * Analyze a stock using Kai's 3-agent investment committee
   * 
   * Returns a decision card with buy/hold/reduce recommendation.
   */
  static async analyzeStock(data: {
    userId: string;
    ticker: string;
    riskProfile?: "conservative" | "balanced" | "aggressive";
    context?: Record<string, unknown>;
    vaultOwnerToken: string;
  }): Promise<Response> {
    const body = {
      user_id: data.userId,
      ticker: data.ticker.toUpperCase(),
      risk_profile: data.riskProfile || "balanced",
      processing_mode: "hybrid",
      context: data.context,
    };

    if (Capacitor.isNativePlatform()) {
      try {
        const vaultOwnerToken = data.vaultOwnerToken;
        if (!vaultOwnerToken) {
          return new Response(
            JSON.stringify({ error: "Vault must be unlocked" }),
            { status: 401 }
          );
        }

        // Use the native Kai plugin (consistent with Tri-Flow and avoids WebView networking quirks).
        const result = await Kai.analyze({
          userId: data.userId,
          ticker: data.ticker.toUpperCase(),
          // Backend still expects consent_token in body for some routes; plugin supports it.
          consentToken: "",
          riskProfile: body.risk_profile,
          processingMode: body.processing_mode,
          context: data.context,
          vaultOwnerToken,
        });

        return new Response(JSON.stringify(result), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      } catch (error) {
        console.error("[ApiService] Native analyzeStock error:", error);
        return new Response(JSON.stringify({ error: (error as Error).message }), {
          status: 500,
        });
      }
    }

    return apiFetch("/api/kai/analyze", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${data.vaultOwnerToken}`,
      },
      body: JSON.stringify(body),
    });
  }

  /**
   * Stream Kai stock analysis with real-time SSE events
   * 
   * Returns a Response with SSE stream that emits:
   * - 'agent_start' events: Agent begins analysis
   * - 'agent_token' events: Streaming tokens showing AI thinking
   * - 'agent_complete' events: Agent finished with summary
   * - 'debate_round' events: Each round of agent debate
   * - 'decision' events: Final decision card
   * - 'error' events: Error messages
   * 
   * SSE Format from Backend:
   * event: agent_start
   * data: {"event": "agent_start", "data": {"agent": "..."}, "id": "..."}
   * 
   * Native Kai plugin uses different format, we normalize to SSE standard.
   */
  static async streamKaiAnalysis(data: {
    userId: string;
    ticker: string;
    riskProfile: string;
    userContext?: any;
    vaultOwnerToken: string;
    signal?: AbortSignal;
  }): Promise<Response> {
    const body = {
      user_id: data.userId,
      ticker: data.ticker.toUpperCase(),
      risk_profile: data.riskProfile,
      context: data.userContext,
    };

    // Native: use Kai plugin and expose a ReadableStream of SSE text
    if (Capacitor.isNativePlatform()) {
      try {
        const vaultOwnerToken = data.vaultOwnerToken;
        if (!vaultOwnerToken) {
          return new Response(
            JSON.stringify({ error: "Vault must be unlocked" }),
            { status: 401 }
          );
        }

        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            let sawTerminalEvent = false;
            let closed = false;
            let listener: { remove: () => void } | null = null;

            const cleanup = () => {
              if (listener) {
                listener.remove();
                listener = null;
              }
            };
            const close = () => {
              if (closed) return;
              closed = true;
              cleanup();
              controller.close();
            };
            const fail = (error: unknown) => {
              if (closed) return;
              closed = true;
              cleanup();
              controller.error(
                error instanceof Error ? error : new Error(String(error))
              );
            };
            const handleAbort = () => {
              fail(new DOMException("Aborted", "AbortError"));
            };

            try {
              data.signal?.addEventListener("abort", handleAbort, { once: true });
              listener = await Kai.addListener(
                KAI_STREAM_EVENT,
                (event: Record<string, unknown>) => {
                  if (closed) return;
                  const eventType =
                    typeof event.event === "string" ? event.event : null;
                  const envelopeCandidate = event.data;
                  if (!eventType || !isKaiStreamEnvelope(envelopeCandidate)) {
                    fail(new Error("Invalid native analyze stream event"));
                    return;
                  }

                  const envelope = envelopeCandidate as KaiStreamEnvelope;
                  if (envelope.event !== eventType) {
                    fail(new Error("Native SSE event mismatch"));
                    return;
                  }

                  if (envelope.terminal) {
                    sawTerminalEvent = true;
                  }

                  controller.enqueue(
                    encoder.encode(
                      `event: ${eventType}\ndata: ${JSON.stringify(envelope)}\n\n`
                    )
                  );
                }
              );

              await Kai.streamKaiAnalysis({
                body: body as Record<string, unknown>,
                vaultOwnerToken,
              });

              if (!sawTerminalEvent) {
                fail(new Error("Native analyze stream ended without terminal event"));
                return;
              }
              close();
            } catch (error) {
              fail(error);
            } finally {
              data.signal?.removeEventListener("abort", handleAbort);
            }
          },
        });

        return new Response(stream, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      } catch (error) {
        console.error("[ApiService] Native streamKaiAnalysis error:", error);
        return new Response(JSON.stringify({ error: (error as Error).message }), {
          status: 500,
        });
      }
    }

    // For web, use the Next.js proxy
    return apiFetch("/api/kai/analyze/stream", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${data.vaultOwnerToken}`,
      },
      body: JSON.stringify(body),
      signal: data.signal,
    });
  }

  static async startKaiDebateRun(data: {
    userId: string;
    debateSessionId: string;
    ticker: string;
    riskProfile: string;
    userContext?: Record<string, unknown>;
    pickSource?: string;
    pickSourceLabel?: string;
    pickSourceKind?: string;
    vaultOwnerToken: string;
  }): Promise<Response> {
    const response = await apiFetch("/api/kai/analyze/run/start", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${data.vaultOwnerToken}`,
      },
      body: JSON.stringify({
        user_id: data.userId,
        debate_session_id: data.debateSessionId,
        ticker: data.ticker.toUpperCase(),
        risk_profile: data.riskProfile,
        context: data.userContext,
        pick_source: data.pickSource,
        pick_source_label: data.pickSourceLabel,
        pick_source_kind: data.pickSourceKind,
      }),
    });
    if (response.ok) {
      trackEvent("analysis_stream_started", {
        result: "success",
      });
    } else if (response.status === 409) {
      trackEvent("analysis_stream_aborted", {
        result: "expected_error",
        reason: "run_already_active",
      });
    } else {
      trackEvent("analysis_stream_error", {
        result: "error",
      });
    }
    return response;
  }

  static async getActiveKaiDebateRun(data: {
    userId: string;
    debateSessionId: string;
    vaultOwnerToken: string;
  }): Promise<Response> {
    const query = new URLSearchParams({
      user_id: data.userId,
      debate_session_id: data.debateSessionId,
    }).toString();
    return apiFetch(`/api/kai/analyze/run/active?${query}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${data.vaultOwnerToken}`,
      },
    });
  }

  static async cancelKaiDebateRun(data: {
    runId: string;
    userId: string;
    vaultOwnerToken: string;
  }): Promise<Response> {
    const query = new URLSearchParams({ user_id: data.userId }).toString();
    const response = await apiFetch(`/api/kai/analyze/run/${encodeURIComponent(data.runId)}/cancel?${query}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${data.vaultOwnerToken}`,
      },
    });
    if (response.ok) {
      trackEvent("analysis_stream_aborted", {
        result: "expected_error",
        reason: "user_cancelled",
      });
    } else {
      trackEvent("analysis_stream_error", {
        result: "error",
      });
    }
    return response;
  }

  static async streamKaiDebateRun(data: {
    userId: string;
    runId: string;
    resumeCursor?: number;
    vaultOwnerToken: string;
    signal?: AbortSignal;
  }): Promise<Response> {
    const body = {
      user_id: data.userId,
      ticker: "RUN_RESUME",
      risk_profile: "balanced",
      run_id: data.runId,
      resume_cursor: data.resumeCursor ?? 0,
      context: {},
    };

    if (Capacitor.isNativePlatform()) {
      try {
        const vaultOwnerToken = data.vaultOwnerToken;
        if (!vaultOwnerToken) {
          return new Response(
            JSON.stringify({ error: "Vault must be unlocked" }),
            { status: 401 }
          );
        }

        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            let sawTerminalEvent = false;
            let closed = false;
            let listener: { remove: () => void } | null = null;

            const cleanup = () => {
              if (listener) {
                listener.remove();
                listener = null;
              }
            };
            const close = () => {
              if (closed) return;
              closed = true;
              cleanup();
              controller.close();
            };
            const fail = (error: unknown) => {
              if (closed) return;
              closed = true;
              cleanup();
              controller.error(
                error instanceof Error ? error : new Error(String(error))
              );
            };
            const handleAbort = () => {
              fail(new DOMException("Aborted", "AbortError"));
            };

            try {
              data.signal?.addEventListener("abort", handleAbort, { once: true });
              listener = await Kai.addListener(
                KAI_STREAM_EVENT,
                (event: Record<string, unknown>) => {
                  if (closed) return;
                  const eventType =
                    typeof event.event === "string" ? event.event : null;
                  const envelopeCandidate = event.data;
                  if (!eventType || !isKaiStreamEnvelope(envelopeCandidate)) {
                    fail(new Error("Invalid native analyze stream event"));
                    return;
                  }

                  const envelope = envelopeCandidate as KaiStreamEnvelope;
                  if (envelope.event !== eventType) {
                    fail(new Error("Native SSE event mismatch"));
                    return;
                  }

                  if (envelope.terminal) {
                    sawTerminalEvent = true;
                  }

                  controller.enqueue(
                    encoder.encode(
                      `event: ${eventType}\ndata: ${JSON.stringify(envelope)}\n\n`
                    )
                  );
                }
              );

              await Kai.streamKaiAnalysis({
                body: body as Record<string, unknown>,
                vaultOwnerToken,
              });

              if (!sawTerminalEvent) {
                fail(new Error("Native analyze stream ended without terminal event"));
                return;
              }
              close();
            } catch (error) {
              fail(error);
            } finally {
              data.signal?.removeEventListener("abort", handleAbort);
            }
          },
        });

        return new Response(stream, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      } catch (error) {
        console.error("[ApiService] Native streamKaiDebateRun error:", error);
        return new Response(JSON.stringify({ error: (error as Error).message }), {
          status: 500,
        });
      }
    }

    const query = new URLSearchParams({
      user_id: data.userId,
      cursor: String(data.resumeCursor ?? 0),
    }).toString();
    return apiFetch(`/api/kai/analyze/run/${encodeURIComponent(data.runId)}/stream?${query}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${data.vaultOwnerToken}`,
      },
      signal: data.signal,
    });
  }
}

// Re-export for convenience
export { getApiBaseUrl };
