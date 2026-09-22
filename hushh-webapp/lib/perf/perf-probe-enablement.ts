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
/**
 * Native only, read only when the probe itself is on: an app-relative route
 * to open once at boot (`-CapacitorStorage.hushh_perf_route /one/kai`), so a
 * device run without the test bridge can start on a surface that the
 * signed-in bottom bar does not reach. The auth guard still owns admission:
 * a locked vault sends the route through /login?redirect= and back.
 */
export const PERF_ROUTE_PREFERENCE_KEY = "hushh_perf_route";
/**
 * Native only, read only when the probe is on: attribution experiments the
 * probe applies to the page for one launch (`-CapacitorStorage.hushh_perf_experiment
 * autocorrect-off`). An experiment changes behaviour to isolate a cost, so a
 * run with one on is attribution only and never certifies; the export names
 * it. Known experiments are listed in `PERF_EXPERIMENTS`.
 */
export const PERF_EXPERIMENT_PREFERENCE_KEY = "hushh_perf_experiment";
export const PERF_EXPERIMENTS = ["autocorrect-off", "spellcheck-off", "kb-inset-off"] as const;
export type PerfExperiment = (typeof PERF_EXPERIMENTS)[number];

export type PerfProbeEnablement = {
  enabled: boolean;
  hud: boolean;
  source: "query" | "session" | "preferences" | "none";
  /** App-relative path to open once at boot; native launch argument only. */
  route?: string;
  /** Attribution experiments for this launch; native launch argument only. */
  experiments?: PerfExperiment[];
};

/** Only names from the known list, comma separated; anything else is dropped. */
export function sanitizePerfExperiments(value: string | null | undefined): PerfExperiment[] {
  return String(value ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter((name): name is PerfExperiment => (PERF_EXPERIMENTS as readonly string[]).includes(name));
}

const DISABLED: PerfProbeEnablement = { enabled: false, hud: false, source: "none" };

/** Only an app-relative path, so the argument can never point off the app. */
export function sanitizePerfRoute(value: string | null | undefined): string | undefined {
  const trimmed = String(value ?? "").trim();
  if (!trimmed.startsWith("/") || trimmed.startsWith("//")) return undefined;
  if (!/^[A-Za-z0-9/_?=&%.-]+$/.test(trimmed)) return undefined;
  return trimmed;
}

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
    if (value !== "1" && value !== "hud") return DISABLED;
    const { value: routeValue } = await Preferences.get({ key: PERF_ROUTE_PREFERENCE_KEY });
    const { value: experimentValue } = await Preferences.get({ key: PERF_EXPERIMENT_PREFERENCE_KEY });
    return {
      enabled: true,
      hud: value === "hud",
      source: "preferences",
      route: sanitizePerfRoute(routeValue),
      experiments: sanitizePerfExperiments(experimentValue),
    };
  } catch {
    // No plugin, or the bridge is not ready: stay inert.
  }
  return DISABLED;
}
