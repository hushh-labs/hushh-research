import { Capacitor } from "@capacitor/core";
import { App } from "@capacitor/app";
import { shouldDisableExternalTelemetryForAutomation } from "@/lib/testing/native-test";

import type {
  PrimitiveEventValue,
  ObservabilityAdapter,
  ObservabilityEventName,
} from "@/lib/observability/events";

let firebaseAnalyticsModulePromise:
  | Promise<typeof import("@capacitor-firebase/analytics")>
  | null = null;

// Read native versionName/CFBundleShortVersionString, not the web package version.
// Cache once per process; no network, user identifiers or installation state needed.
let nativeReleasePromise: Promise<{ app_version: string; app_build?: string }> | null = null;
function nativeRelease() {
  nativeReleasePromise ??= App.getInfo().then((info) => ({
    app_version: /^\d+\.\d+[\w.+-]{0,40}$/.test(info.version) ? info.version : "unknown",
    ...(/^\d{1,12}$/.test(info.build) ? { app_build: info.build } : {}),
  })).catch(() => ({ app_version: "unknown" }));
  return nativeReleasePromise;
}

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
    return Capacitor.isNativePlatform() && !shouldDisableExternalTelemetryForAutomation();
  },

  async track(
    eventName: ObservabilityEventName,
    payload: Record<string, PrimitiveEventValue>
  ): Promise<void> {
    if (!this.isAvailable()) return;
    const release = await nativeRelease();
    // Reviewer admission can change while loading the bridge. Recheck before sending.
    if (!this.isAvailable()) return;
    const { FirebaseAnalytics } = await getFirebaseAnalyticsModule();
    if (!this.isAvailable()) return;
    const nativePayload = { ...payload };
    delete nativePayload.app_build;
    await FirebaseAnalytics.logEvent({
      name: eventName,
      params: toFirebaseParams({ ...nativePayload, ...release }),
    });
  },
};
