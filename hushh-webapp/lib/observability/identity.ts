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

const USER_ID_SALT =
  process.env.NEXT_PUBLIC_ANALYTICS_USER_ID_SALT || "hushh-observability-v1";

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

async function applyNativeUserId(userId: string | null): Promise<void> {
  try {
    const { FirebaseAnalytics } = await import("@capacitor-firebase/analytics");
    await FirebaseAnalytics.setUserId({ userId });
  } catch {
    // Analytics identity is never allowed to break a sign-in.
  }
}

function applyWebUserId(userId: string | null): void {
  if (typeof window === "undefined" || typeof window.gtag !== "function") return;
  const measurementId = resolveAnalyticsMeasurementId();
  if (!measurementId) return;

  // `config` rather than `set` so the id binds to this measurement id only,
  // matching how the adapter scopes events with `send_to`.
  (
    window.gtag as unknown as (
      command: string,
      target: string,
      params?: Record<string, unknown>
    ) => void
  )("config", measurementId, { user_id: userId ?? undefined });
}

/**
 * Binds (or on sign-out, clears) the analytics identity on whichever surface
 * this build is running. Safe to call repeatedly; redundant applications are
 * skipped so an auth-state re-render does not thrash the GA4 config.
 */
export async function setObservabilityUserId(
  firebaseUid: string | null
): Promise<void> {
  const userId = firebaseUid ? await resolveAnalyticsUserId(firebaseUid) : null;
  if (userId === lastAppliedUserId) return;
  lastAppliedUserId = userId;

  if (Capacitor.isNativePlatform()) {
    await applyNativeUserId(userId);
    return;
  }
  applyWebUserId(userId);
}
