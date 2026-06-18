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

function freezeTransportPayload<T extends Record<string, unknown>>(payload: T): T {
  return Object.freeze(payload);
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
    const transportPayload = freezeTransportPayload({
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
      const gtagPayload = freezeTransportPayload({
        send_to: measurementId,
        event_source: "observability_v2",
        ...payload,
      });
      window.gtag("event", eventName, gtagPayload);
    }
  },
};
