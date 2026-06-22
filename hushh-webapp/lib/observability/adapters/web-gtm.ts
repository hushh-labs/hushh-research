import type {
  ObservabilityAdapter,
  ObservabilityEventName,
  PrimitiveEventValue,
} from "@/lib/observability/events";
import { resolveAnalyticsMeasurementId } from "@/lib/observability/env";

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
    // Freeze the outbound payload so downstream GTM/dataLayer consumers cannot
    // mutate it after we hand it off (telemetry immutability at the transport edge).
    const transportPayload = Object.freeze({
      event: eventName,
      event_source: "observability_v2",
      ...payload,
    });
    window.dataLayer.push(transportPayload);

    const measurementId = resolveAnalyticsMeasurementId();
    if (!measurementId) {
      return;
    }

    if (typeof window.gtag === "function") {
      const gtagPayload = Object.freeze({
        send_to: measurementId,
        event_source: "observability_v2",
        ...payload,
      });
      window.gtag("event", eventName, gtagPayload);
    }
  },
};
