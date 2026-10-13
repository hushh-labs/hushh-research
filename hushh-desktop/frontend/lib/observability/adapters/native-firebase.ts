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

function toFirebaseParams(payload: Record<string, PrimitiveEventValue>) {
  const params: Record<string, string | number> = {};

  for (const [key, value] of Object.entries(payload)) {
    if (value === null || value === undefined) continue;
    if (typeof value === "boolean") {
      params[key] = value ? "true" : "false";
      continue;
    }
    params[key] = value;
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
