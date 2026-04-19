import type {
  ObservabilityAdapter,
  ObservabilityEventName,
  PrimitiveEventValue,
} from "@/lib/observability/events";
import {
  resolveAnalyticsMeasurementId,
  resolveGtmContainerId,
} from "@/lib/observability/env";

declare global {
  interface Window {
    dataLayer?: Array<Record<string, unknown>>;
    gtag?: (
      command: "event",
      eventName: ObservabilityEventName,
      payload: Record<string, unknown>
    ) => void;
  }
}

export const webGtmAdapter: ObservabilityAdapter = {
  name: "web-gtm",

  isAvailable(): boolean {
    return typeof window !== "undefined";
  },

  async track(
    eventName: ObservabilityEventName,
    payload: Record<string, PrimitiveEventValue>
  ): Promise<void> {
    if (typeof window === "undefined") return;

    window.dataLayer = window.dataLayer || [];
    const transportPayload = {
      event: eventName,
      event_source: "observability_v2",
      ...payload,
    };
    window.dataLayer.push(transportPayload);

    // If a real GTM container is configured, let GTM own downstream forwarding.
    if (resolveGtmContainerId()) {
      return;
    }

    if (!resolveAnalyticsMeasurementId()) {
      return;
    }

    if (typeof window.gtag === "function") {
      window.gtag("event", eventName, {
        event_source: "observability_v2",
        ...payload,
      });
    }
  },
};
