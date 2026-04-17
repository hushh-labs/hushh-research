import type {
  ObservabilityAdapter,
  ObservabilityEventName,
  PrimitiveEventValue,
} from "@/lib/observability/events";

declare global {
  interface Window {
    dataLayer?: Array<Record<string, unknown>>;
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
    window.dataLayer.push({
      event: eventName,
      event_source: "observability_v2",
      ...payload,
    });
  },
};
