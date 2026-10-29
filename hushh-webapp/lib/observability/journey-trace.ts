import { resolveAppEnvironment } from "@/lib/app-env";

/** Identity-free values only: enums, flags, counts and durations. Never ids, tokens or text. */
export type JourneyTraceValue = string | number | boolean | null | readonly string[];
export type JourneyTrace = (event: string, fields?: Record<string, JourneyTraceValue>) => void;

let sequence = 0;

/** Verbose journey lines run only in Dev and UAT builds. Production, and any build without a
 * recognised environment (which resolves to production), stays silent whatever debug toggle is set. */
export function journeyTraceEnabled(): boolean {
  const environment = resolveAppEnvironment();
  return environment === "development" || environment === "uat";
}

/** One opaque operation per screen or intent; filter the console by `[KARMA]` and its `op`.
 * `[KARMA][uat][web][op=k3x9q2][seq=4][+812.4ms] registration.shown state=… controls=sign_out` */
export function startJourneyTrace(feature: string): JourneyTrace {
  const operation = Math.random().toString(36).slice(2, 8);
  const started = performance.now();
  return (event, fields = {}) => {
    if (!journeyTraceEnabled()) return;
    try {
      sequence += 1;
      const detail = Object.entries(fields)
        .map(([key, value]) => `${key}=${Array.isArray(value) ? value.join(",") || "none" : String(value)}`)
        .join(" ");
      // Indirect on purpose: next.config.ts removeConsole strips direct console.info calls from
      // every web build, Dev and UAT included; the environment gate above keeps production silent.
      const sink = console.info;
      sink(`[KARMA][${resolveAppEnvironment()}][web][op=${operation}][seq=${sequence}]`
        + `[+${(performance.now() - started).toFixed(1)}ms] ${feature}.${event}${detail ? ` ${detail}` : ""}`);
    } catch { /* A console sink must not change the journey. */ }
  };
}
