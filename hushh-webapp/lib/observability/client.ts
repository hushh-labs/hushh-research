import { isAnalyticsExemptRoute } from "@/lib/navigation/routes";
import { Capacitor } from "@capacitor/core";

import {
  isObservabilityDebugEnabled,
  isObservabilityEnabled,
  resolveObservabilityEnvironment,
  resolveObservabilitySampleRate,
} from "@/lib/observability/env";
import type {
  CacheFootprintBucket,
  CacheFreshness,
  CacheResourceClass,
  CacheTier,
  CountBucket,
  DurationBucket,
  EventPayloadFor,
  EventPayloadWithContextFor,
  EventResult,
  MinuteDurationBucket,
  ObservabilityAdapter,
  ObservabilityEventName,
  ObservabilityPlatform,
  RefreshTrigger,
  RouteRenderPath,
  StatusBucket,
} from "@/lib/observability/events";
import { resolveObservabilityEventCategory } from "@/lib/observability/events";
import { nativeFirebaseAdapter } from "@/lib/observability/adapters/native-firebase";
import { webGtmAdapter } from "@/lib/observability/adapters/web-gtm";
import {
  normalizeApiPathToTemplate,
  resolveRouteId,
  type RouteId,
} from "@/lib/observability/route-map";
import { validateAndSanitizeEvent } from "@/lib/observability/schema";
import { redactObservabilityLogValue } from "@/lib/observability/log-redactor";
import { resolveClientVersion } from "@/lib/observability/client-version";
import { snapshotProductActivityScope } from "./product-activity-scope";
import { publishTrackedEvent } from "./tracked-event-bus";

interface TrackOptions {
  dedupeKey?: string;
  dedupeWindowMs?: number;
}

const ADAPTERS: ObservabilityAdapter[] = [webGtmAdapter, nativeFirebaseAdapter];
const lastEventAtByKey = new Map<string, number>();

const DEFAULT_DEDUPE_WINDOW_MS = 750;

function resolvePlatform(): ObservabilityPlatform {
  if (!Capacitor.isNativePlatform()) {
    return "web";
  }
  const platform = Capacitor.getPlatform();
  return platform === "ios" ? "ios" : "android";
}

function nowMs(): number {
  return Date.now();
}

function shouldDropByDedupe(key: string, dedupeWindowMs: number): boolean {
  const now = nowMs();
  const previous = lastEventAtByKey.get(key);
  if (previous && now - previous <= dedupeWindowMs) {
    return true;
  }
  lastEventAtByKey.set(key, now);
  return false;
}

function shouldSample(sampleRate: number): boolean {
  if (sampleRate >= 1) return true;
  if (sampleRate <= 0) return false;
  return Math.random() <= sampleRate;
}

function debugLog(...args: unknown[]) {
  if (!isObservabilityDebugEnabled()) return;
  console.info("[observability]", ...args.map(redactObservabilityLogValue));
}

/**
 * Returns whether the event was handed to an adapter.
 *
 * Callers that record a once-per-user milestone need to know: marking such a
 * milestone as sent when sampling or a disabled kill-switch dropped it burns
 * that step permanently for the device. Every existing caller ignores the
 * return value, so this is additive.
 */
export function trackEvent<T extends ObservabilityEventName>(
  eventName: T,
  payload: EventPayloadFor<T>,
  options: TrackOptions = {}
): boolean {
  if (typeof window !== "undefined" && isAnalyticsExemptRoute(window.location.pathname)) return false;
  if (!isObservabilityEnabled()) return false;
  const dedupeKey = options.dedupeKey;
  if (dedupeKey) {
    const dedupeWindowMs = options.dedupeWindowMs ?? DEFAULT_DEDUPE_WINDOW_MS;
    if (shouldDropByDedupe(dedupeKey, dedupeWindowMs)) {
      debugLog("deduped", eventName, dedupeKey);
      return false;
    }
  }

  const fullPayload: EventPayloadWithContextFor<T> = {
    ...payload,
    env: resolveObservabilityEnvironment(),
    platform: resolvePlatform(),
    event_category: resolveObservabilityEventCategory(eventName),
    app_version: resolveClientVersion(),
  };

  const validation = validateAndSanitizeEvent(eventName, fullPayload);
  if (validation.fatal) {
    debugLog("payload_rejected", eventName, validation.droppedKeys);
    return false;
  }
  if (!validation.ok) {
    debugLog("payload_sanitized", eventName, validation.droppedKeys);
  }
  publishTrackedEvent(eventName, validation.sanitized);

  // Only admitted enum identifiers leave via the private pilot channel. Pin
  // identity before the import; GA sampling cannot change observation receipt.
  const productScope = snapshotProductActivityScope();
  const { action, result } = validation.sanitized;
  void import("@/lib/observability/product-activity-client").then(({ observeProductEvent }) => {
    observeProductEvent(eventName, action, result, productScope);
  }).catch(() => undefined);
  if (!shouldSample(resolveObservabilitySampleRate())) return false;

  const activeAdapters = ADAPTERS.filter((adapter) => adapter.isAvailable());
  if (activeAdapters.length === 0) {
    debugLog("no_adapter", eventName);
    return false;
  }

  void Promise.allSettled(
    activeAdapters.map((adapter) =>
      adapter.track(eventName, validation.sanitized).catch((error) => {
        debugLog("adapter_error", adapter.name, eventName, String(error));
      })
    )
  );
  return true;
}

export function trackPageView(pathname: string, navType: "route_change" | "initial_load" | "redirect" = "route_change"): void {
  const routeId = resolveRouteId(pathname);
  trackEvent(
    "page_view",
    {
      route_id: routeId,
      nav_type: navType,
    },
    {
      dedupeKey: `page_view:${routeId}:${pathname}`,
      dedupeWindowMs: 1000,
    }
  );
}

const EXPECTED_STATUS_BY_ENDPOINT: Record<string, Set<number>> = {
  "GET /api/kai/analyze/run/active": new Set([404]),
  "POST /api/kai/analyze/run/start": new Set([409]),
  "GET /api/pkm/metadata/{user_id}": new Set([401, 404]),
  "GET /api/kai/market/insights/baseline/{user_id}": new Set([401]),
  "GET /api/kai/market/insights/{user_id}": new Set([401]),
  "POST /db/vault/get": new Set([404]),
  "POST /db/vault/bootstrap-state": new Set([404]),
};

function toExpectedKey(httpMethod: string, endpointTemplate: string): string {
  return `${httpMethod.toUpperCase()} ${endpointTemplate}`;
}

function isExpectedStatus(
  httpMethod: string,
  endpointTemplate: string,
  statusCode: number
): boolean {
  const expected = EXPECTED_STATUS_BY_ENDPOINT[toExpectedKey(httpMethod, endpointTemplate)];
  return Boolean(expected?.has(statusCode));
}

export function toStatusBucket(
  statusCode: number | null,
  httpMethod: string,
  endpointTemplate: string
): StatusBucket {
  if (statusCode === null) return "network_error";
  if (statusCode >= 200 && statusCode < 300) return "2xx";
  if (statusCode >= 300 && statusCode < 400) return "3xx";
  if (statusCode >= 400 && statusCode < 500) {
    return isExpectedStatus(httpMethod, endpointTemplate, statusCode)
      ? "4xx_expected"
      : "4xx_unexpected";
  }
  return "5xx";
}

export function toEventResult(statusBucket: StatusBucket): EventResult {
  if (statusBucket === "2xx" || statusBucket === "3xx") return "success";
  if (statusBucket === "4xx_expected") return "expected_error";
  return "error";
}

export function toDurationBucket(durationMs: number): DurationBucket {
  if (durationMs < 100) return "lt_100ms";
  if (durationMs < 300) return "100ms_300ms";
  if (durationMs < 1000) return "300ms_1s";
  if (durationMs < 3000) return "1s_3s";
  if (durationMs < 10000) return "3s_10s";
  return "gte_10s";
}

/**
 * Minute-scale companion to `toDurationBucket` for background work. The
 * millisecond buckets keep their meaning; this scale starts where they end.
 * A missing, negative or non-finite duration is `unknown`, never `lt_1m`.
 */
export function toMinuteDurationBucket(
  durationMs: number | null | undefined,
): MinuteDurationBucket {
  if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs < 0) {
    return "unknown";
  }
  if (durationMs < 60_000) return "lt_1m";
  if (durationMs < 5 * 60_000) return "1m_5m";
  if (durationMs < 15 * 60_000) return "5m_15m";
  if (durationMs < 60 * 60_000) return "15m_1h";
  return "gte_1h";
}

/** A small count as a band. A count nobody could take is `unknown`, not `0`. */
export function toCountBucket(count: number | null | undefined): CountBucket {
  if (typeof count !== "number" || !Number.isFinite(count) || count < 0) return "unknown";
  if (count < 1) return "0";
  if (count < 2) return "1";
  if (count <= 5) return "2_5";
  if (count <= 20) return "6_20";
  return "gt_20";
}

export function trackApiRequestCompleted(params: {
  path: string;
  httpMethod: string;
  statusCode: number | null;
  durationMs: number;
  routeId?: RouteId;
  retryCount?: number;
}): void {
  const endpointTemplate = normalizeApiPathToTemplate(params.path);
  const statusBucket = toStatusBucket(
    params.statusCode,
    params.httpMethod,
    endpointTemplate
  );

  trackEvent("api_request_completed", {
    route_id: params.routeId,
    endpoint_template: endpointTemplate,
    http_method: params.httpMethod.toUpperCase(),
    result: toEventResult(statusBucket),
    status_bucket: statusBucket,
    duration_ms_bucket: toDurationBucket(params.durationMs),
    retry_count: params.retryCount,
  });
}

export function trackRouteReadinessCompleted(params: {
  routeId: RouteId;
  result: EventResult;
  renderPath: RouteRenderPath;
  cacheTier: CacheTier;
  resourceClass: CacheResourceClass;
  durationMs: number;
  blockingLoaderShown: boolean;
  staleRendered: boolean;
}): void {
  trackEvent("route_readiness_completed", {
    route_id: params.routeId,
    result: params.result,
    render_path: params.renderPath,
    cache_tier: params.cacheTier,
    resource_class: params.resourceClass,
    duration_ms_bucket: toDurationBucket(params.durationMs),
    blocking_loader_shown: params.blockingLoaderShown,
    stale_rendered: params.staleRendered,
  });
}

export function trackCacheResourceResolved(params: {
  result: EventResult;
  resourceClass: CacheResourceClass;
  cacheTier: CacheTier;
  freshness: CacheFreshness;
  durationMs: number;
  routeId?: RouteId;
  footprintBucket?: CacheFootprintBucket;
}): void {
  trackEvent("cache_resource_resolved", {
    route_id: params.routeId,
    result: params.result,
    resource_class: params.resourceClass,
    cache_tier: params.cacheTier,
    freshness: params.freshness,
    duration_ms_bucket: toDurationBucket(params.durationMs),
    footprint_bucket: params.footprintBucket,
  });
}

export function trackRouteRefreshCompleted(params: {
  routeId: RouteId;
  result: EventResult;
  resourceClass: CacheResourceClass;
  refreshTrigger: RefreshTrigger;
  durationMs: number;
  retryCount?: number;
}): void {
  trackEvent("route_refresh_completed", {
    route_id: params.routeId,
    result: params.result,
    resource_class: params.resourceClass,
    refresh_trigger: params.refreshTrigger,
    duration_ms_bucket: toDurationBucket(params.durationMs),
    retry_count: params.retryCount,
  });
}

export function trackWarmupCompleted(params: {
  result: EventResult;
  resourceClass: CacheResourceClass;
  cacheTier: CacheTier;
  warmPriority: string;
  durationMs: number;
  routeId?: RouteId;
  footprintBucket?: CacheFootprintBucket;
}): void {
  trackEvent("warmup_completed", {
    route_id: params.routeId,
    result: params.result,
    resource_class: params.resourceClass,
    cache_tier: params.cacheTier,
    warm_priority: params.warmPriority,
    duration_ms_bucket: toDurationBucket(params.durationMs),
    footprint_bucket: params.footprintBucket,
  });
}
