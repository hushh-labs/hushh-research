/**
 * How the render-performance probe is switched on, without a new env flag.
 *
 * 1. `?perf=1` (or `?perf=hud`) on any URL. Remembered in sessionStorage so
 *    client navigations keep it; a new tab starts clean.
 * 2. Inside the native shell, the Preferences key `hushh_perf_probe` = "1".
 *    On iOS it is supplied per launch as the argument
 *    `-CapacitorStorage.hushh_perf_probe 1` (Preferences reads
 *    UserDefaults.standard with the `CapacitorStorage.` prefix, and the
 *    NSArgumentDomain sits above it), so nothing is persisted on the device
 *    and the app never writes the key itself.
 *
 * When neither is present the probe module is never imported.
 */

import { Capacitor } from "@capacitor/core";

export const PERF_PROBE_QUERY_KEY = "perf";
export const PERF_PROBE_SESSION_KEY = "hushh.perf.probe";
export const PERF_HUD_SESSION_KEY = "hushh.perf.hud";
export const PERF_PROBE_PREFERENCE_KEY = "hushh_perf_probe";

export type PerfProbeEnablement = {
  enabled: boolean;
  hud: boolean;
  source: "query" | "session" | "preferences" | "none";
};

const DISABLED: PerfProbeEnablement = { enabled: false, hud: false, source: "none" };

function readSession(key: string): string | null {
  try {
    return window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeSession(key: string, value: string): void {
  try {
    window.sessionStorage.setItem(key, value);
  } catch {
    // Private mode or storage denied: the query still enables this document.
  }
}

/** Synchronous part: query string and session memory. */
export function resolvePerfProbeEnablementSync(): PerfProbeEnablement {
  if (typeof window === "undefined") return DISABLED;
  const query = new URLSearchParams(window.location.search).get(PERF_PROBE_QUERY_KEY);
  if (query === "1" || query === "hud") {
    writeSession(PERF_PROBE_SESSION_KEY, "1");
    if (query === "hud") writeSession(PERF_HUD_SESSION_KEY, "1");
    return { enabled: true, hud: query === "hud", source: "query" };
  }
  if (readSession(PERF_PROBE_SESSION_KEY) === "1") {
    return {
      enabled: true,
      hud: readSession(PERF_HUD_SESSION_KEY) === "1",
      source: "session",
    };
  }
  return DISABLED;
}

/** Full resolution: the sync sources, then the native launch preference. */
export async function resolvePerfProbeEnablement(): Promise<PerfProbeEnablement> {
  const sync = resolvePerfProbeEnablementSync();
  if (sync.enabled) return sync;
  if (typeof window === "undefined" || !Capacitor.isNativePlatform()) return DISABLED;
  try {
    const { Preferences } = await import("@capacitor/preferences");
    const { value } = await Preferences.get({ key: PERF_PROBE_PREFERENCE_KEY });
    if (value === "1") return { enabled: true, hud: false, source: "preferences" };
    if (value === "hud") return { enabled: true, hud: true, source: "preferences" };
  } catch {
    // No plugin, or the bridge is not ready: stay inert.
  }
  return DISABLED;
}
