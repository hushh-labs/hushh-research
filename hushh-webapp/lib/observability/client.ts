import { Capacitor } from "@capacitor/core";

import {
  isObservabilityDebugEnabled,
  isObservabilityEnabled,
  resolveObservabilityEnvironment,
  resolveObservabilitySampleRate,
} from "@/lib/observability/env";
import type {
  DurationBucket,
  EventPayloadFor,
  EventPayloadWithContextFor,
  EventResult,
  ObservabilityAdapter,
  ObservabilityEventName,
  ObservabilityPlatform,
  StatusBucket,
} from "@/lib/observability/events";
import { nativeFirebaseAdapter } from "@/lib/observability/adapters/native-firebase";
import { webGtmAdapter } from "@/lib/observability/adapters/web-gtm";
import {
  normalizeApiPathToTemplate,
  resolveRouteId,
  type RouteId,
} from "@/lib/observability/route-map";
import { validateAndSanitizeEvent } from "@/lib/observability/schema";

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
  console.info("[observability]", ...args);
}

export function trackEvent<T extends ObservabilityEventName>(
  eventName: T,
  payload: EventPayloadFor<T>,
  options: TrackOptions = {}
): void {
  if (!isObservabilityEnabled()) return;
  if (!shouldSample(resolveObservabilitySampleRate())) return;

  const dedupeKey = options.dedupeKey;
  if (dedupeKey) {
    const dedupeWindowMs = options.dedupeWindowMs ?? DEFAULT_DEDUPE_WINDOW_MS;
    if (shouldDropByDedupe(dedupeKey, dedupeWindowMs)) {
      debugLog("deduped", eventName, dedupeKey);
      return;
    }
  }

  const fullPayload: EventPayloadWithContextFor<T> = {
    ...payload,
    env: resolveObservabilityEnvironment(),
    platform: resolvePlatform(),
  };

  const validation = validateAndSanitizeEvent(eventName, fullPayload);
  if (!validation.ok) {
    debugLog("payload_sanitized", eventName, validation.droppedKeys);
  }

  const activeAdapters = ADAPTERS.filter((adapter) => adapter.isAvailable());
  if (activeAdapters.length === 0) {
    debugLog("no_adapter", eventName);
    return;
  }

  void Promise.allSettled(
    activeAdapters.map((adapter) =>
      adapter.track(eventName, validation.sanitized).catch((error) => {
        debugLog("adapter_error", adapter.name, eventName, String(error));
      })
    )
  );
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
