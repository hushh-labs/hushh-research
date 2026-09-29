import { Capacitor } from "@capacitor/core";

import type {
  ObservabilityAdapter,
  ObservabilityEventName,
  PrimitiveEventValue,
} from "@/lib/observability/events";
import {
  createGtagHitBudget,
  type GtagHitPriority,
} from "@/lib/observability/adapters/gtag-hit-budget";
import { resolveAnalyticsMeasurementId } from "@/lib/observability/env";
import { shouldDisableExternalTelemetryForAutomation } from "@/lib/testing/native-test";

declare global {
  interface Window {
    dataLayer?: Array<Record<string, unknown>>;
    gtag?: (
      command: "event",
      eventName: ObservabilityEventName,
      payload: Record<string, unknown>
    ) => void;
    /** Registered by gtag.js per destination once that GA4 stream is live. */
    google_tag_manager?: Record<string, unknown>;
  }
}

/**
 * High-volume operational telemetry. It only spends gtag's event budget above
 * the reserve product events keep (see gtag-hit-budget.ts).
 */
const OPERATIONAL_EVENTS: ReadonlySet<ObservabilityEventName> = new Set([
  "api_request_completed",
  "cache_resource_resolved",
  "route_readiness_completed",
  "route_refresh_completed",
  "warmup_completed",
]);

let gtagHitBudget = createGtagHitBudget();

export function resetWebGtmHitBudgetForTests(): void {
  gtagHitBudget = createGtagHitBudget();
}

function resolveHitPriority(eventName: ObservabilityEventName): GtagHitPriority {
  return OPERATIONAL_EVENTS.has(eventName) ? "operational" : "product";
}

export const webGtmAdapter: ObservabilityAdapter = {
  name: "web-gtm",

  isAvailable(): boolean {
    return typeof window !== "undefined" && !Capacitor.isNativePlatform();
  },

  async track(
    eventName: ObservabilityEventName,
    payload: Record<string, PrimitiveEventValue>
  ): Promise<void> {
    if (!this.isAvailable()) return;
    if (shouldDisableExternalTelemetryForAutomation()) return;

    window.dataLayer = window.dataLayer || [];
    const transportPayload = {
      event: eventName,
      event_source: "observability_v2",
      ...payload,
    };
    window.dataLayer.push(transportPayload);

    const measurementId = resolveAnalyticsMeasurementId();
    if (!measurementId) {
      return;
    }

    if (typeof window.gtag !== "function") return;
    // Seen at the first event after gtag.js loads, so refill starts slightly
    // late. That only under-counts tokens; it never spends the product reserve.
    if (window.google_tag_manager?.[measurementId]) gtagHitBudget.markLive();
    if (!gtagHitBudget.admit(resolveHitPriority(eventName))) return;

    window.gtag("event", eventName, {
      send_to: measurementId,
      event_source: "observability_v2",
      ...payload,
    });
  },
};
