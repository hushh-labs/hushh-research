import { Capacitor } from "@capacitor/core";

import type {
  PrimitiveEventValue,
  ObservabilityAdapter,
  ObservabilityEventName,
} from "@/lib/observability/events";

let firebaseAnalyticsModulePromise:
  | Promise<typeof import("@capacitor-firebase/analytics")>
  | null = null;

function getFirebaseAnalyticsModule() {
  firebaseAnalyticsModulePromise =
    firebaseAnalyticsModulePromise || import("@capacitor-firebase/analytics");
  return firebaseAnalyticsModulePromise;
}

const hasOwnProperty = Object.prototype.hasOwnProperty;

function toFirebaseParams(payload: Record<string, PrimitiveEventValue>) {
  const params: Record<string, string | number> = {};

  for (const key in payload) {
    if (!hasOwnProperty.call(payload, key)) continue;

    const value = payload[key];
    if (value === null || value === undefined) continue;

    params[key] = typeof value === "boolean" ? (value ? "true" : "false") : value;
  }

  return params;
}

export const nativeFirebaseAdapter: ObservabilityAdapter = {
  name: "native-firebase",

  isAvailable(): boolean {
    return Capacitor.isNativePlatform();
  },

  async track(
    eventName: ObservabilityEventName,
    payload: Record<string, PrimitiveEventValue>
  ): Promise<void> {
    if (!this.isAvailable()) return;
    const { FirebaseAnalytics } = await getFirebaseAnalyticsModule();
    await FirebaseAnalytics.logEvent({
      name: eventName,
      params: toFirebaseParams(payload),
    });
  },
};
