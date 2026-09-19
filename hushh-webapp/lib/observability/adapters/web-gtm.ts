import type {
  ObservabilityAdapter,
  ObservabilityEventName,
  PrimitiveEventValue,
} from "@/lib/observability/events";
import { resolveAnalyticsMeasurementId } from "@/lib/observability/env";
import { shouldDisableExternalTelemetryForAutomation } from "@/lib/testing/native-test";
import { getCurrentAnalyticsUserContext } from "@/lib/observability/identity";

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
    if (shouldDisableExternalTelemetryForAutomation()) return;

    const userCtx = getCurrentAnalyticsUserContext();
    const identityParams = userCtx.userInfo?.email ? {
      email: userCtx.userInfo.email,
      user_email: userCtx.userInfo.email,
      ...(userCtx.userInfo.displayName ? { display_name: userCtx.userInfo.displayName } : {}),
      ...(userCtx.userInfo.phoneNumber ? { phone_number: userCtx.userInfo.phoneNumber } : {}),
      ...(userCtx.userId ? { user_id: userCtx.userId } : {}),
    } : {};

    window.dataLayer = window.dataLayer || [];
    const transportPayload = {
      event: eventName,
      event_source: "observability_v2",
      ...identityParams,
      ...payload,
    };
    window.dataLayer.push(transportPayload);

    const measurementId = resolveAnalyticsMeasurementId();
    if (!measurementId) {
      return;
    }

    if (typeof window.gtag === "function") {
      window.gtag("event", eventName, {
        send_to: measurementId,
        event_source: "observability_v2",
        ...identityParams,
        ...payload,
      });
    }
  },
};
