"use client";

import { Capacitor } from "@capacitor/core";

import { resolveAnalyticsMeasurementId } from "@/lib/observability/env";

/**
 * Cross-surface analytics identity.
 *
 * GA4 keeps web, iOS and Android on separate streams. Without a shared User-ID
 * the same person who signs up on one.hushh.ai and then installs the App Store
 * build is two users, "App Store users + web users" cannot be added up, and
 * every cross-platform funnel is wrong.
 *
 * What we send is a salted SHA-256 digest of the Firebase UID, never the UID
 * itself. To be precise about the guarantee: the salt ships in the client
 * bundle, so this is not a secret-keyed MAC — someone who already holds a
 * user's Firebase UID could recompute their analytics ID. What it does buy is
 * that no raw account identifier ever reaches Google Analytics, and that the
 * analytics ID is inert on its own. That is the property GA4's own policy
 * requires; a stronger unlinkable mapping would have to be minted server-side.
 */

/**
 * Deliberately a constant, not a `NEXT_PUBLIC_*` build arg.
 *
 * The value has to be identical on every surface or the stitching inverts: the
 * same person would resolve to a different analytics id on web than in the
 * store build, and web-plus-app would count as two users — the exact bug this
 * module exists to prevent. Four independent build lanes write client env
 * (web Cloud Build, TestFlight, App Store, Play Store), so a per-lane value is
 * a standing opportunity for them to drift apart silently.
 *
 * Nothing is lost by fixing it here. Per the note above, the salt ships in the
 * client bundle regardless, so a build arg buys no confidentiality, and because
 * `NEXT_PUBLIC_*` is inlined at build time, rotating a substitution costs the
 * same redeploy as rotating this line. Rotate by bumping the version suffix,
 * which also documents in git history when the identity space was reset.
 */
const USER_ID_SALT = "hushh-observability-v1";

let lastAppliedUserId: string | null | undefined;

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Returns null rather than falling back to the raw UID when Web Crypto is
 * unavailable. Losing identity stitching on an old browser is a reporting gap;
 * leaking an account identifier into analytics is a privacy incident, and this
 * product does not get to be careless about that distinction.
 */
export async function resolveAnalyticsUserId(
  firebaseUid: string
): Promise<string | null> {
  if (!firebaseUid) return null;
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return null;

  try {
    const encoded = new TextEncoder().encode(`${USER_ID_SALT}:${firebaseUid}`);
    const digest = await subtle.digest("SHA-256", encoded);
    // 32 hex chars is ample to avoid collisions at our scale and keeps the
    // value comfortably inside GA4's 256-byte User-ID limit.
    return toHex(digest).slice(0, 32);
  } catch {
    return null;
  }
}

/** Returns whether the id was actually applied, so a no-op is never memoized. */
async function applyNativeUserId(userId: string | null): Promise<boolean> {
  try {
    const { FirebaseAnalytics } = await import("@capacitor-firebase/analytics");
    await FirebaseAnalytics.setUserId({ userId });
    return true;
  } catch {
    // Analytics identity is never allowed to break a sign-in.
    return false;
  }
}

function applyWebUserId(userId: string | null): boolean {
  if (typeof window === "undefined" || typeof window.gtag !== "function") {
    // gtag is injected `afterInteractive`, so an auth state restored during
    // hydration arrives before it exists. Reporting failure here is what lets
    // the caller retry instead of memoizing a binding that never happened.
    return false;
  }
  const measurementId = resolveAnalyticsMeasurementId();
  if (!measurementId) return false;

  // `config` rather than `set` so the id binds to this measurement id only,
  // matching how the adapter scopes events with `send_to`.
  //
  // Guarded because this is third-party code called from the auth state
  // handler. Analytics identity is never allowed to disturb a sign-in.
  try {
    (
      window.gtag as unknown as (
        command: string,
        target: string,
        params?: Record<string, unknown>
      ) => void
    )("config", measurementId, {
      // `null`, not `undefined`: gtag drops undefined fields, so signing out
      // with undefined would leave the previous account's id bound and
      // attribute the next person's events to them. On a shared family device
      // that is exactly the wrong outcome.
      user_id: userId,
      // The app bootstraps this measurement id with `send_page_view: false`
      // (app/layout.tsx) because page views are emitted by the adapter. Every
      // `config` re-applies gtag's default of true unless we repeat it, so
      // omitting this would fire a spurious page view on every sign-in.
      send_page_view: false,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Binds (or on sign-out, clears) the analytics identity on whichever surface
 * this build is running.
 *
 * Safe to call repeatedly: a successful application is remembered so an
 * auth-state re-render does not thrash the GA4 config. A failed one is
 * deliberately not remembered, so the next auth event retries it.
 */
export async function setObservabilityUserId(
  firebaseUid: string | null
): Promise<void> {
  const userId = firebaseUid ? await resolveAnalyticsUserId(firebaseUid) : null;
  if (userId === lastAppliedUserId) return;

  const applied = Capacitor.isNativePlatform()
    ? await applyNativeUserId(userId)
    : applyWebUserId(userId);

  // Only memoize what actually landed. Memoizing first meant a page where gtag
  // had not yet loaded bound nothing and then short-circuited forever, which
  // made cross-surface stitching -- the entire reason this file exists -- a
  // no-op on web for anyone already signed in at load.
  if (applied) lastAppliedUserId = userId;
}
