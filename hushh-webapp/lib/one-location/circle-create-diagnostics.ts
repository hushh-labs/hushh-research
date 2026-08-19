/**
 * Traceable Circle creation.
 * ==========================
 *
 * One create attempt emits one correlated line per stage, so "Create circle did
 * nothing" is read off a console instead of guessed at:
 *
 *   [CircleCreate:Click]   { attemptId, route, circleKind, hasName }
 *   [CircleCreate:LockCheck] { attemptId, lockState, source, settled }
 *   [CircleCreate:LockGuard] { attemptId, decision, reason }
 *   [CircleCreate:Unlock]  { attemptId, phase }          // opened | succeeded | cancelled
 *   [CircleCreate:Resume]  { attemptId, resumed, preservedName, preservedKind }
 *   [CircleCreate:API]     { attemptId, endpoint, started }
 *   [CircleCreate:Success] { attemptId, circleIdPrefix, durationMs, resumed }
 *   [CircleCreate:Failure] { attemptId, stage, reason, durationMs }
 *
 * Shape follows `lib/cache/request-audit-log.ts`, the repo's existing
 * `[Namespace:Stage] {detail}` helper — this is that pattern applied to a second
 * feature, not a second logging framework.
 *
 * ## Where it runs
 *
 * Local development, the UAT website, and an injected native UI-test session.
 * Never a production build, and never a packaged store build.
 *
 * Three traps decide how this is written. The third was found by reading the
 * deployed bundle rather than trusting the gate.
 *
 * 1. `isObservabilityDebugEnabled()` is unusable. `deploy/frontend.cloudbuild.yaml`
 *    hardcodes `--build-arg NEXT_PUBLIC_OBSERVABILITY_DEBUG=false`, and
 *    `NEXT_PUBLIC_*` is inlined at build time — so that flag is permanently
 *    false on every deployed build, including UAT. A diagnostic gated on it
 *    could never be read where it is needed.
 * 2. An environment check alone is not enough either. The App Store and Play
 *    Store lanes stamp `NEXT_PUBLIC_APP_ENV=uat` because they ship against the
 *    UAT backend (`.github/workflows/release-ios-appstore.yml`,
 *    `ship-android-playstore-v1.yml`), so `!== "production"` reads every store
 *    install as non-production. Distribution and backend environment are
 *    separate facts — the same reasoning `lib/testing/location-map-demo.ts`
 *    spells out. A packaged app is therefore excluded unless it is running an
 *    injected UI-test session.
 * 3. **`console.info` does not exist on the UAT website.** `next.config.ts` sets
 *    `removeConsole: isCapacitorBuild ? false : { exclude: ["error", "warn"] }`,
 *    so every `console.*` call except `error` and `warn` is stripped from the
 *    bundle at compile time. The first version of this file used
 *    `console.info`, matching `lib/cache/request-audit-log.ts` and
 *    `lib/observability/client.ts` — and the tags were verified absent from
 *    every chunk served by uat.one.hushh.ai. Both of those existing helpers are
 *    dead on the deployed website for the same reason; they only survive in the
 *    Capacitor build, where `removeConsole` is off.
 *
 *    So these lines go out on `console.warn`, the only channel that survives a
 *    web build. The gate above is what keeps them off a real person's phone —
 *    on iOS nothing strips them, which makes that check load-bearing rather
 *    than defence in depth.
 *
 * ## What never goes in
 *
 * No token, no key, no passphrase, no uid, no email, and no Circle NAME — a
 * Circle name is the person's own words and usually names a household, which is
 * why the existing `one_location_circle_created` event records the kind and not
 * the name. Only `hasName` (a boolean) is recorded. Circle ids are truncated to
 * an 8-character prefix: enough to line a console trace up with a backend row,
 * short enough not to be a usable identifier on its own. Every payload is passed
 * through `redactObservabilityLog` as a backstop, which strips bearer tokens,
 * JWTs, vault keys, emails and anything else secret-shaped that a future edit
 * might add by accident.
 */

import { Capacitor } from "@capacitor/core";

import { resolveAppEnvironment } from "@/lib/app-env";
import { createRequestId } from "@/lib/observability/request-id";
import { redactObservabilityLog } from "@/lib/observability/log-redactor";
import { isNativeUiTestSession } from "@/lib/testing/native-test";

import type { OneLocationLockState } from "@/lib/one-location/circle-lock-state";

export type CircleCreateStage =
  | "Click"
  | "LockCheck"
  | "LockGuard"
  | "Unlock"
  | "Resume"
  | "API"
  | "Success"
  | "Failure";

export type CircleCreateLockDecision = "allow" | "unlock_required" | "wait";

/** Correlates every stage of one attempt, and one attempt only. */
export type CircleCreateAttemptId = string;

/**
 * Short on purpose. `createRequestId()` returns a UUID, and a UUID is 36
 * characters of `[A-Za-z0-9-]` — which is exactly what the observability
 * redactor's long-secret rule strips, so a full one arrives in the console as
 * `[REDACTED_SECRET]` and correlates nothing. Ten characters is unique enough
 * to follow one attempt through one session and short enough to survive.
 *
 * This id never leaves the browser: the create endpoint takes no client
 * correlation id, so its only job is to tie these console lines together.
 */
export function createCircleCreateAttemptId(): CircleCreateAttemptId {
  return `cc_${createRequestId().replace(/-/g, "").slice(0, 10)}`;
}

export function isCircleCreateDiagnosticsEnabled(): boolean {
  // Hard floor first. A production build never traces, whatever else is set.
  if (resolveAppEnvironment() === "production") return false;
  if (resolveAppEnvironment() === "development") return true;
  // A driven native session is an operator context — trace it, that is the
  // whole point of running the flow on a device.
  if (isNativeUiTestSession()) return true;
  // Left: a UAT build. On the website that is an operator reading a console.
  // Packaged into an app it is a real person's phone, so stay quiet.
  return !Capacitor.isNativePlatform();
}

/**
 * An id kept only as a short prefix. Long enough to join a console line to a
 * backend row while reading a single trace; too short to be an identifier.
 */
export function circleIdPrefix(circleId: string | null | undefined): string {
  const value = String(circleId || "").trim();
  return value ? value.slice(0, 8) : "";
}

function redactDetail(detail: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(detail)) {
    if (value === undefined) continue;
    safe[key] = typeof value === "string" ? redactObservabilityLog(value) : value;
  }
  return safe;
}

export function logCircleCreate(
  stage: CircleCreateStage,
  detail: Record<string, unknown>,
): void {
  if (!isCircleCreateDiagnosticsEnabled()) return;
  // console.warn, not console.info: `removeConsole` in next.config.ts strips
  // every level except error and warn from a web build, so info never reaches
  // UAT at all. Verified against the served bundle, not assumed. Not `error` —
  // these are a trace, and an operator scanning for real faults should not have
  // to wade through them.
  console.warn(`[CircleCreate:${stage}]`, redactDetail(detail));
}

export function logCircleCreateLockCheck(
  attemptId: CircleCreateAttemptId,
  lockState: OneLocationLockState,
): void {
  logCircleCreate("LockCheck", {
    attemptId,
    lockState,
    // Names the authority so a reader does not have to guess which of the
    // several lock signals was consulted. Written without an underscore after
    // "vault": `vault_…` is a redactor pattern, and `vault_context` came out
    // of the console as `[REDACTED_VAULT_KEY]`.
    source: "useVault().vaultOwnerToken",
    settled: lockState !== "resolving",
  });
}

export function logCircleCreateLockGuard(
  attemptId: CircleCreateAttemptId,
  decision: CircleCreateLockDecision,
  reason: string,
): void {
  logCircleCreate("LockGuard", { attemptId, action: "CREATE_CIRCLE", decision, reason });
}
